// Two overlapping `Litestream.bounce()` calls must never leave TWO
// `litestream replicate` processes running.
//
// Backported from upstream dilaya/aws-sqlite-data 0.1.26
// (race 1: "two config writers"). Callers of `bounce` overlap in normal
// operation — a request hot-adding an app (ensureServed), the registry poll /
// `/admin/sync` (doSync) and `/admin/delete-app` (removeApp) each bounce on
// their own schedule. Unserialized, the second caller finds `this.child`
// already nulled by the first (which is still awaiting the old child's exit),
// skips the stop, spawns; the first then wakes up and spawns AGAIN, overwriting
// `this.child`. The orphan keeps replicating, unsupervised and unstoppable by
// `stop()` — two writers on one generation path, the exact dual-writer shape
// invariant 5 exists to forbid.
//
// The stand-in binary records its pid and takes a moment to exit on SIGTERM,
// like the real one flushing its last sync, which is what opens the window.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../../src/config.ts";
import { Litestream } from "../../src/litestream.ts";

function fakeReplicator(dir: string): string {
  const bin = join(dir, "litestream");
  writeFileSync(
    bin,
    `#!/bin/sh
echo $$ >> "${dir}/pids"
trap 'sleep 0.2; exit 0' TERM
while :; do sleep 0.05; done
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function pids(dir: string): number[] {
  const file = join(dir, "pids");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
}

test("overlapping bounces leave exactly ONE replicate process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bounce-race-"));
  const ls = new Litestream(
    loadConfig({
      REPLICA_BASE_URL: "s3://bucket/replicas",
      LITESTREAM_BIN: fakeReplicator(dir),
      LITESTREAM_CONFIG_PATH: join(dir, "litestream.yml"),
    } as NodeJS.ProcessEnv),
  );
  const app = (id: string) => ({ appId: id, dbPath: join(dir, "dbs", id, "app.db") });
  try {
    ls.start([app("a")]);
    await until(() => pids(dir).length === 1);
    assert.equal(pids(dir).length, 1, "the initial replicate process started");

    // A hot-add and a reconcile bounce at the same instant.
    await Promise.all([ls.bounce([app("a"), app("b")]), ls.bounce([app("a"), app("b"), app("c")])]);
    await sleep(300); // let any late spawn record its pid

    const running = pids(dir).filter(alive);
    assert.equal(running.length, 1, `exactly one litestream may run; alive pids: ${running.join(", ")}`);
    assert.ok(
      readFileSync(join(dir, "litestream.yml"), "utf8").includes(app("c").dbPath),
      "the config on disk is the LAST bounce's",
    );
  } finally {
    await ls.stop();
    // Cleanup only: reap any orphan the unserialized code left behind.
    for (const pid of pids(dir)) if (alive(pid)) process.kill(pid, "SIGKILL");
  }
});
