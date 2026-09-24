// Two paths may prepare the SAME brand-new app at the same instant.
//
// Backported from upstream dilaya/aws-sqlite-data 0.1.40.
// Seen there on 2026-09-19 seeding a trial stack — 100 apps created 6 at a
// time, 6 of them answered 503 on their very first statement, verbatim:
//
//   app could not be prepared: litestream restore failed for scale-091:
//   exit 1 Error: cannot restore, output path already exists and is not empty:
//   …/app.db. Use -force to overwrite
//
// `ensureServed` (the request path) holds a per-app mutex, but the registry
// reconcile (`doSync`) never looked at it: both saw "no local file", both
// spawned `litestream restore`, and the slower one started after the faster had
// already created the fresh database. Invariant 2 held — nothing is ever
// restored OVER a file — so no data was at risk; the cost was a 503 on the first
// request of a new app, or a reconcile pass thrown away.
//
// The stand-in binary below does what litestream does: refuse an existing
// output path. Its SECOND run for a path waits for the file to appear before
// looking — the losing side of the race, staged on purpose rather than left to
// the scheduler.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AppManager } from "../../src/apps.ts";
import { loadConfig } from "../../src/config.ts";
import { Litestream } from "../../src/litestream.ts";
import type { Registry } from "../../src/registry.ts";
import { AppSync } from "../../src/sync.ts";

function fakeLitestream(dir: string): string {
  const bin = join(dir, "litestream");
  // argv: restore -if-replica-exists -o <path> <url> — $4 is the output path.
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$4" >> "${dir}/runs"
if [ "$(grep -c -x -F "$4" "${dir}/runs")" -gt 1 ]; then
  i=0; while [ ! -e "$4" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
else
  sleep 0.3
fi
if [ -e "$4" ]; then
  echo "Error: cannot restore, output path already exists and is not empty: $4. Use -force to overwrite" >&2
  exit 1
fi
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function litestreamIn(dir: string): Litestream {
  return new Litestream(
    loadConfig({ REPLICA_BASE_URL: "s3://bucket/replicas", LITESTREAM_BIN: fakeLitestream(dir) } as NodeJS.ProcessEnv),
  );
}

const runs = (dir: string): number => readFileSync(join(dir, "runs"), "utf8").trim().split("\n").length;

test("two callers preparing one new app share ONE restore — the second never trips on the first's file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-race-"));
  const ls = litestreamIn(dir);
  const app = { appId: "scale-091", dbPath: join(dir, "dbs", "scale-091", "app.db") };

  // The request path, then the reconcile — while the first is still inside its
  // restore, so both saw "no local file".
  const first = ls.restoreIfMissing(app);
  const second = ls.restoreIfMissing(app);

  const outcomes = await Promise.all([first, second]);
  assert.deepEqual(outcomes, ["fresh", "fresh"], "both callers learn the same outcome");
  assert.ok(existsSync(app.dbPath));
  assert.equal(runs(dir), 1, "litestream ran once for that app");
});

test("a DIFFERENT app is not held up by it, and a later call still sees the file as existing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-race-"));
  const ls = litestreamIn(dir);
  const a = { appId: "a", dbPath: join(dir, "dbs", "a", "app.db") };
  const b = { appId: "b", dbPath: join(dir, "dbs", "b", "app.db") };
  assert.deepEqual(await Promise.all([ls.restoreIfMissing(a), ls.restoreIfMissing(b)]), ["fresh", "fresh"]);
  assert.equal(runs(dir), 2, "one restore per app — the mutex is per path");
  assert.equal(await ls.restoreIfMissing(a), "existing", "the shared promise is dropped once settled");
});

test("a request hot-add and the registry reconcile racing on one new app both succeed", async () => {
  // The exact production shape: a new registry row, its first request
  // (ensureServed) and the poll/`/admin/sync` reconcile (doSync) arriving
  // together. Before the fix, one of the two rejected with the error above.
  const dir = mkdtempSync(join(tmpdir(), "restore-race-"));
  const ls = litestreamIn(dir);
  ls.bounce = async () => {}; // replication is not under test here
  const registry = { reload: async () => {}, listActive: async () => [{ appId: "newcomer" }] } as unknown as Registry;
  const manager = {
    dbPath: (appId: string) => join(dir, "dbs", appId, "app.db"),
    async removeApp() {},
  } as unknown as AppManager;
  const sync = new AppSync(registry, manager, ls);

  const request = sync.ensureServed("newcomer");
  const reconcile = sync.syncOnce();
  await Promise.all([request, reconcile]);

  assert.ok(sync.isServed("newcomer"));
  assert.ok(existsSync(manager.dbPath("newcomer")));
  assert.equal(runs(dir), 1, "one restore, whoever asked first");
});
