// --- The one setting here that loses DATA, not money -------------------------
// Every other knob trades cost against restore speed. `l0-retention` against the
// level-1 interval does not: a transaction lands in L0 first and may only be
// swept once level 1 has merged it, so too short a retention deletes writes that
// were never copied anywhere else. Nothing reports it — litestream keeps
// replicating, every metric stays green, and the loss surfaces the day someone
// restores. And it is easy to reach BY ACCIDENT, because the two values are
// tuned for opposite reasons: slowing compaction is what saves the money, and
// the retention is the one you forget to move with it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeLitestream } from "./litestream-helpers.ts";

test("l0-retention shorter than the level-1 interval refuses to boot", () => {
  assert.throws(
    () => makeLitestream({ LITESTREAM_L0_RETENTION: "1m", LITESTREAM_LEVEL_INTERVALS: "5m,30m,6h" }),
    /LOST data/,
  );
});

test("l0-retention merely EQUAL to the level-1 interval is refused too — that is a race, not a margin", () => {
  assert.throws(
    () => makeLitestream({ LITESTREAM_L0_RETENTION: "5m", LITESTREAM_LEVEL_INTERVALS: "5m,30m,6h" }),
    /LOST data/,
  );
  // …and so is anything under the required ratio.
  assert.throws(
    () => makeLitestream({ LITESTREAM_L0_RETENTION: "9m", LITESTREAM_LEVEL_INTERVALS: "5m,30m,6h" }),
    /LOST data/,
  );
});

test("the required margin is met by the shipped defaults and by every offered option", () => {
  // The guard must not refuse what we actually intend to run — including
  // litestream's own defaults (5m retention vs 30s L1).
  assert.ok(makeLitestream()); // shipped defaults: 3h retention vs 30m L1
  const options: Array<[string, string]> = [
    ["10m", "1m,10m,1h"], // prudent
    ["1h", "5m,30m,6h"], // recommended
    ["3h", "15m,1h,6h"], // maximal
  ];
  for (const [retention, levels] of options) {
    assert.ok(
      makeLitestream({ LITESTREAM_L0_RETENTION: retention, LITESTREAM_LEVEL_INTERVALS: levels }),
      `${retention} / ${levels}`,
    );
  }
});

test("the guard states the fix, not just the refusal", () => {
  // A boot that dies on an unexplained assertion at 3am is a worse outcome than
  // the misconfiguration; the message must carry both values and the rule.
  try {
    makeLitestream({ LITESTREAM_L0_RETENTION: "1m", LITESTREAM_LEVEL_INTERVALS: "5m,30m,6h" });
    assert.fail("expected a refusal");
  } catch (err) {
    const msg = (err as Error).message;
    assert.match(msg, /1m/, "names the offending retention");
    assert.match(msg, /5m/, "names the level-1 interval it must clear");
    assert.match(msg, /at least 2x/i, "states the rule");
  }
});
