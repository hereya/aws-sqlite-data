// The AMI pin protects the database VM from being replaced by an unrelated
// deploy (CLAUDE.md invariant 9). Backported from upstream dilaya/aws-sqlite-data. Its cost is that OS patches stop
// arriving on their own, which is only acceptable if something NOTICES that the
// pin has fallen behind.
//
// Regression guarded: that "something" was prose in two documents for weeks and
// was never executed once — on 2026-08-03 a sweep found an image four weeks
// old. These tests pin the properties that make the replacement (a command with
// an exit code) trustworthy: it must not report health when it cannot see, and
// it must tell a behind PIN apart from an un-rolled DEPLOY, because the two
// have different fixes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AL2023_SSM_PARAMETER,
  PINNED_AMI_ID,
  PINNED_AMI_REGION,
  amiPinStatus,
  describeLookup,
  describeVerdict,
  exitCodeFor,
} from "../lib/ami-pin.ts";

const AMI_A = "ami-0ab117b5527d5fe24";
const AMI_B = "ami-0390cc9c657024910";

test("pin equal to the published image is current", () => {
  assert.deepEqual(amiPinStatus({ pinned: AMI_A, latest: AMI_A }), {
    state: "current",
  });
});

test("a newer published image is reported as behind, and names it", () => {
  const v = amiPinStatus({ pinned: AMI_B, latest: AMI_A });
  assert.equal(v.state, "behind");
  assert.equal(v.state === "behind" && v.latest, AMI_A);
});

test("an unreadable parameter is 'unknown', NEVER 'current'", () => {
  // The whole point of the check is to be the thing that notices. A check that
  // passes when blind manufactures reassurance nobody verified — which is
  // exactly the failure mode (a clean-looking result hiding an unlooked-at
  // machine) that this file exists to end.
  const v = amiPinStatus({ pinned: AMI_A, latest: null });
  assert.equal(v.state, "unknown");
  assert.match(v.state === "unknown" ? v.reason : "", /al2023/i);
});

test("a running instance on neither image is 'instance-stale', not 'behind'", () => {
  // Different cause, different fix: the pin is current, so there is nothing to
  // edit — a previous bump was published and never rolled out, and the remedy
  // is a deploy. Reporting this as 'behind' would send someone to bump a
  // constant that is already right.
  const v = amiPinStatus({ pinned: AMI_A, latest: AMI_A, running: AMI_B });
  assert.equal(v.state, "instance-stale");
  assert.equal(v.state === "instance-stale" && v.running, AMI_B);
});

test("a running instance that matches the pin is current", () => {
  assert.deepEqual(
    amiPinStatus({ pinned: AMI_A, latest: AMI_A, running: AMI_A }),
    { state: "current" },
  );
});

test("an absent running id never turns a current pin into a fault", () => {
  // `--stack` is optional; the pin-vs-published question needs no EC2
  // permission, so a caller without one must still get a usable answer.
  for (const running of [null, undefined]) {
    assert.deepEqual(amiPinStatus({ pinned: AMI_A, latest: AMI_A, running }), {
      state: "current",
    });
  }
});

test("a behind pin wins over an instance check — the roll subsumes it", () => {
  const v = amiPinStatus({ pinned: AMI_B, latest: AMI_A, running: AMI_B });
  assert.equal(v.state, "behind");
});

test("every verdict renders one actionable sentence", () => {
  const unknown = amiPinStatus({ pinned: AMI_A, latest: null });
  const verdicts = [
    amiPinStatus({ pinned: AMI_A, latest: AMI_A }),
    amiPinStatus({ pinned: AMI_B, latest: AMI_A }),
    amiPinStatus({ pinned: AMI_A, latest: AMI_A, running: AMI_B }),
    unknown,
  ];
  for (const v of verdicts) {
    const line = describeVerdict(v, PINNED_AMI_ID);
    assert.ok(line.length > 20, `verdict ${v.state} must say something`);
    assert.ok(!line.includes("undefined"), `verdict ${v.state} leaked undefined`);
  }
  // The failure text must not read like an all-clear.
  assert.match(describeVerdict(unknown, PINNED_AMI_ID), /NOT "up to date"/);
});

// ---------------------------------------------------------------------------
// The instance lookup, and the exit code it feeds.
//
// Regression guarded (2026-08-05): the sweep had been running with a TRUNCATED
// stack name, `p-0000abcd` instead of `p-0000abcd-0000-4000-8000-000000000000`.
// The tag filter is an exact match, so it selected nothing; the script turned
// that empty result into the same `null` it used for "no permission", printed a
// parenthetical, and exited 0. The `instance-stale` branch — the half that
// catches a pin bumped, published, but never rolled out — had therefore never
// executed once since it shipped. These tests pin the property that makes that
// impossible: an instance question that was ASKED and not ANSWERED cannot exit 0.
// ---------------------------------------------------------------------------

const CURRENT = amiPinStatus({ pinned: AMI_A, latest: AMI_A });
const BEHIND = amiPinStatus({ pinned: AMI_B, latest: AMI_A });
const UNKNOWN = amiPinStatus({ pinned: AMI_A, latest: null });

test("a --stack that matches nothing NEVER exits 0", () => {
  const lookup = { state: "no-match", stackName: "p-0000abcd" } as const;
  assert.equal(exitCodeFor(CURRENT, lookup), 2);
  // …and it says WHY, naming exact-match as the cause rather than blaming
  // credentials — the misdiagnosis that cost us four weeks of the check.
  const line = describeLookup(lookup);
  assert.match(line, /exact match/);
  assert.match(line, /NOT checked/);
  assert.ok(line.includes("p-0000abcd"), "must name the stack it was given");
});

test("a --stack that could not be read NEVER exits 0 either", () => {
  const lookup = {
    state: "unreadable",
    stackName: "p-whatever",
    reason: "AccessDenied",
  } as const;
  assert.equal(exitCodeFor(CURRENT, lookup), 2);
  assert.match(describeLookup(lookup), /AccessDenied/);
  assert.match(describeLookup(lookup), /NOT checked/);
});

test("no --stack at all still exits 0 — the pin question needs no EC2 access", () => {
  assert.equal(exitCodeFor(CURRENT, { state: "not-requested" }), 0);
  assert.equal(describeLookup({ state: "not-requested" }), "");
});

test("a fully answered check exits 0 and adds no noise", () => {
  const lookup = { state: "found", imageId: AMI_A } as const;
  assert.equal(exitCodeFor(CURRENT, lookup), 0);
  assert.equal(describeLookup(lookup), "");
});

test("a behind pin outranks an unanswered instance question", () => {
  // A roll is needed whether or not the instance could be read, and 1 is the
  // more actionable answer — so it must not be masked by "could not determine".
  for (const lookup of [
    { state: "no-match", stackName: "x" },
    { state: "unreadable", stackName: "x", reason: "boom" },
    { state: "not-requested" },
  ] as const) {
    assert.equal(exitCodeFor(BEHIND, lookup), 1);
  }
});

test("an unresolvable parameter stays 2 regardless of the instance", () => {
  assert.equal(exitCodeFor(UNKNOWN, { state: "found", imageId: AMI_A }), 2);
  assert.equal(exitCodeFor(UNKNOWN, { state: "not-requested" }), 2);
});

test("instance-stale exits 1 — it is fixed by a deploy, not an edit", () => {
  const stale = amiPinStatus({ pinned: AMI_A, latest: AMI_A, running: AMI_B });
  assert.equal(exitCodeFor(stale, { state: "found", imageId: AMI_B }), 1);
});

test("the pin is measured against the parameter it was taken from", () => {
  // `-kernel-default-` follows whatever kernel AL2023 currently defaults to;
  // `-kernel-6.1-` is frozen on that line. They agree today and will diverge
  // the day AL2023 moves its default — and comparing against the wrong one
  // would then report an "upgrade available" that no bump can ever satisfy.
  assert.match(AL2023_SSM_PARAMETER, /al2023-ami-kernel-6\.1-arm64$/);
  assert.match(PINNED_AMI_ID, /^ami-[0-9a-f]{8,17}$/);
  assert.equal(PINNED_AMI_REGION, "eu-west-1");
});

test("the pin moves only on purpose — 0.1.2 is the dated OS roll", () => {
  // 0.1.1 pinned the image already in service (ami-0390cc9c657024910) so that
  // introducing the pin rolled nothing. 0.1.2 is the deliberate roll to the
  // AL2023 of 2026-09-18. Changing this line is changing the production OS.
  assert.equal(PINNED_AMI_ID, "ami-06f589fd2af7a9fc7");
});
