// Says whether the pinned AMI has fallen behind what AWS publishes.
// Backported from upstream dilaya/aws-sqlite-data (a8de6fe + later hardening).
//
// Why a command and not a line in a runbook: the pin (CLAUDE.md invariant 9)
// stops AWS from replacing the database VM on an unrelated deploy,
// and the accepted cost is that OS patches then arrive only when someone rolls
// the pin. Two documents already said "compare the pin with the current
// AL2023". Both were right, neither was executable, and the comparison went
// four weeks without being made. This is that sentence, made runnable.
//
//   npm run check:ami                      # pin vs the published AL2023
//   npm run check:ami -- --stack <name>    # also check the RUNNING instance
//
// Exit codes are the point — a caller (a scheduled sweep, a human, CI if anyone
// wants it) branches on them without parsing prose:
//   0  in sync
//   1  a newer AL2023 exists, or the running instance is on neither → plan a roll
//   2  could not determine (no aws CLI, no credentials, unreadable parameter,
//      or a --stack that designates no running instance)
//
// 2 is deliberately NOT 0. A check that cannot see must not report health —
// including when the blindness was caused by the caller's own argument. Passing
// --stack and getting 0 means BOTH halves were verified; see `exitCodeFor`.
import { execFileSync } from "node:child_process";
import {
  AL2023_SSM_PARAMETER,
  PINNED_AMI_ID,
  PINNED_AMI_REGION,
  amiPinStatus,
  describeLookup,
  describeVerdict,
  exitCodeFor,
} from "../lib/ami-pin.ts";

const args = process.argv.slice(2);
const stackName = argValue("--stack");
const region = argValue("--region") ?? PINNED_AMI_REGION;

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}

/**
 * Run an aws CLI call.
 *
 * Returns the two outcomes SEPARATELY — `{ok:true, value}` where `value` may be
 * null for "ran fine, matched nothing", and `{ok:false, error}` for "could not
 * run". Collapsing those two into one null is what let a truncated stack name
 * masquerade as a permissions problem and silently disable half this check.
 */
function aws(cliArgs) {
  try {
    const out = execFileSync("aws", [...cliArgs, "--region", region, "--output", "text"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { ok: true, value: out === "" || out === "None" ? null : out };
  } catch (err) {
    return { ok: false, error: firstLine(err) };
  }
}

/** The aws CLI puts the useful part on stderr; keep one line of it. */
function firstLine(err) {
  const raw = String(err?.stderr ?? err?.message ?? err).trim();
  return raw.split("\n").find((l) => l.trim()) ?? "aws CLI failed";
}

const latestResult = aws([
  "ssm",
  "get-parameter",
  "--name",
  AL2023_SSM_PARAMETER,
  "--query",
  "Parameter.Value",
]);
const latest = latestResult.ok ? latestResult.value : null;

// The pin-vs-published question — the one that decides whether to plan a roll —
// needs no EC2 permission at all, so a caller without one still gets the answer
// that matters by simply not passing --stack. Passing it is a request for the
// second question, and an unanswered request is reported, never shrugged off.
const lookup = stackName ? lookUpInstance(stackName) : { state: "not-requested" };

function lookUpInstance(name) {
  const res = aws([
    "ec2",
    "describe-instances",
    "--filters",
    `Name=tag:aws:cloudformation:stack-name,Values=${name}`,
    "Name=instance-state-name,Values=running",
    "--query",
    "Reservations[0].Instances[0].ImageId",
  ]);
  if (!res.ok) return { state: "unreadable", stackName: name, reason: res.error };
  if (res.value === null) return { state: "no-match", stackName: name };
  return { state: "found", imageId: res.value };
}

const running = lookup.state === "found" ? lookup.imageId : null;
const verdict = amiPinStatus({ pinned: PINNED_AMI_ID, latest, running });

console.log(describeVerdict(verdict, PINNED_AMI_ID));
const lookupLine = describeLookup(lookup);
if (lookupLine) {
  console.log(lookupLine);
  // A name that matches nothing is usually a truncation. Naming the candidates
  // turns "wrong" into "here is the one you meant" — a hint, never a silent
  // substitution: guessing which stack was intended is exactly the kind of
  // helpfulness that would hide the next mistake.
  if (lookup.state === "no-match") {
    for (const candidate of suggestStacks(stackName)) {
      console.log(`  did you mean: ${candidate}`);
    }
  }
}

/** Best-effort: stacks whose name starts with what the caller typed. */
function suggestStacks(prefix) {
  const res = aws([
    "cloudformation",
    "list-stacks",
    "--stack-status-filter",
    "CREATE_COMPLETE",
    "UPDATE_COMPLETE",
    "UPDATE_ROLLBACK_COMPLETE",
    "--query",
    `StackSummaries[?starts_with(StackName,'${prefix}')].StackName`,
  ]);
  if (!res.ok || !res.value) return [];
  return res.value.split(/\s+/).filter(Boolean).slice(0, 5);
}

process.exit(exitCodeFor(verdict, lookup));
