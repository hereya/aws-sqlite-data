// Synthesising this stack bundles the service artifact, which runs
// scripts/build-service.mjs into the REPO-WIDE dist/. The test runner executes
// test files in parallel processes, so without a cross-process lock two synths
// write that directory at once and one fails to bundle (ENOTEMPTY on
// dist/stage). The lock is taken on a file's first synth and released when that
// file is done, so stacks built inside test bodies are covered too.
// Backported from upstream dilaya/aws-sqlite-data (test/stack/helpers.ts).
import { rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import * as cdk from "aws-cdk-lib";
import { HereyaAwsSqliteDataStack } from "../lib/hereya-aws-sqlite-data-stack.ts";

const LOCK_PATH = join(tmpdir(), "hereya-aws-sqlite-data-synth.lock");
const STALE_MS = 120_000;
const WAIT_MS = 300_000;
let held = false;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireSynthLock(): void {
  if (held) return;
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
      held = true;
      return;
    } catch {
      // A holder that died leaves the file behind; steal it once it is stale.
      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > STALE_MS) rmSync(LOCK_PATH, { force: true });
      } catch {
        // released between the failed create and the stat — just retry
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${LOCK_PATH}`);
      sleepSync(50);
    }
  }
}

function releaseSynthLock(): void {
  if (!held) return;
  held = false;
  rmSync(LOCK_PATH, { force: true });
}

after(releaseSynthLock);
process.on("exit", releaseSynthLock);

/** A fresh stack in its own App, synthesised under the cross-process lock. */
export function synthStack(id: string, region = "eu-west-1"): HereyaAwsSqliteDataStack {
  acquireSynthLock();
  return new HereyaAwsSqliteDataStack(new cdk.App(), id, { env: { account: "111111111111", region } });
}
