// --- Housekeeping cadences ---------------------------------------------------
// These are the S3 REQUEST bill: litestream runs each of them as a fixed timer
// per database, whether or not the database was written to, and each tick LISTs
// the replica. Measured on a production fleet: 16.5M ListBucket in 24
// days (82.60 USD) vs 50k PutObject (0.25 USD).
//
// Parsing is NOT enough to test. 0.5.x config parsing is non-strict, so a key
// that this binary does not know is dropped in silence and the built-in default
// applies — the config would still parse, and we would keep paying while
// believing we had slowed it down. The only honest oracle is the running
// daemon's own report of the intervals it started, so that is what we assert.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { APPS, haveLitestream, litestreamBin, makeLitestream } from "./litestream-helpers.ts";

test("config knobs change the emitted cadences", () => {
  const yml = makeLitestream({
    LITESTREAM_L0_RETENTION: "30m",
    LITESTREAM_L0_RETENTION_CHECK_INTERVAL: "5m",
    LITESTREAM_LEVEL_INTERVALS: "5m,30m,6h",
  }).buildConfig(APPS);
  assert.ok(yml.startsWith("l0-retention: 30m\nl0-retention-check-interval: 5m\nlevels:\n"));
  assert.ok(yml.includes("  - interval: 5m\n  - interval: 30m\n  - interval: 6h\n"));
});

test("a malformed duration fails the boot instead of being silently dropped", () => {
  assert.throws(() => makeLitestream({ LITESTREAM_L0_RETENTION: "5 minutes" }), /invalid LITESTREAM_L0_RETENTION/);
  assert.throws(
    () => makeLitestream({ LITESTREAM_L0_RETENTION_CHECK_INTERVAL: "300" }),
    /invalid LITESTREAM_L0_RETENTION_CHECK_INTERVAL/,
  );
  assert.throws(() => makeLitestream({ LITESTREAM_LEVEL_INTERVALS: "5m,oops" }), /invalid LITESTREAM_LEVEL_INTERVALS/);
});

test("levels must be ordered slowest-last (an inverted pair recompacts forever)", () => {
  assert.throws(
    () => makeLitestream({ LITESTREAM_LEVEL_INTERVALS: "5m,30s" }),
    /level 2 must be slower than level 1/,
  );
  assert.throws(() => makeLitestream({ LITESTREAM_LEVEL_INTERVALS: "5m,5m" }), /must be slower/);
});

test(
  "the real binary HONOURS the cadences (not merely parses them)",
  { skip: !haveLitestream },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-cadence-"));
    const dbPath = join(dir, "app.db");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE t(a)");
    db.close();

    const cfgPath = join(dir, "litestream.yml");
    const cfg = makeLitestream({
      LITESTREAM_L0_RETENTION: "30m",
      LITESTREAM_L0_RETENTION_CHECK_INTERVAL: "5m",
      LITESTREAM_LEVEL_INTERVALS: "5m,30m,6h",
    }).buildConfig([{ appId: "app-1", dbPath }]);
    // point the replica at a local dir rather than the placeholder s3-ish url
    writeFileSync(cfgPath, cfg.replace(/url: .*/, `url: file://${join(dir, "replica")}`));

    const child = spawn(litestreamBin, ["replicate", "-config", cfgPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !/L0 retention monitor/.test(out)) {
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      child.kill("SIGKILL");
    }

    assert.match(out, /L0 retention monitor.*interval=5m0s retention=30m0s/);
    assert.match(out, /compaction monitor.*level=1 interval=5m0s/);
    assert.match(out, /compaction monitor.*level=2 interval=30m0s/);
    assert.match(out, /compaction monitor.*level=3 interval=6h0m0s/);
  },
);

test(
  "the real binary honours the SHIPPED cadence — the one prod actually runs",
  { skip: !haveLitestream },
  async () => {
    // The test above proves the knobs work with arbitrary values. This one
    // proves the values we actually ship are honoured, which is a different
    // claim: a default that only LOOKS applied would keep the fleet on
    // litestream's 15s/30s and nobody would notice, because the bill is the
    // only symptom and it arrives a month later.
    const dir = mkdtempSync(join(tmpdir(), "ls-shipped-"));
    const dbPath = join(dir, "app.db");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE t(a)");
    db.close();

    const cfgPath = join(dir, "litestream.yml");
    const cfg = makeLitestream().buildConfig([{ appId: "app-1", dbPath }]);
    writeFileSync(cfgPath, cfg.replace(/url: .*/, `url: file://${join(dir, "replica")}`));

    const child = spawn(litestreamBin, ["replicate", "-config", cfgPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !/L0 retention monitor/.test(out)) {
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      child.kill("SIGKILL");
    }

    assert.match(out, /L0 retention monitor.*interval=30m0s retention=3h0m0s/);
    assert.match(out, /compaction monitor.*level=1 interval=30m0s/);
    assert.match(out, /compaction monitor.*level=2 interval=2h0m0s/);
    assert.match(out, /compaction monitor.*level=3 interval=6h0m0s/);
    // and NOT litestream's own defaults, which is the failure being guarded
    assert.doesNotMatch(out, /L0 retention monitor.*interval=15s/);
    assert.doesNotMatch(out, /compaction monitor.*level=1 interval=30s/);
  },
);
