// Restore-if-missing: the step that decides what an app's local file IS before
// anything reads it. Split out of litestream.ts together with the per-path
// mutex backported from upstream 0.1.40.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.ts";
import type { LitestreamApp, RestoreOutcome } from "../litestream.ts";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "litestream", ...event }));
}

export class Restorer {
  private readonly cfg: Config;
  /** In-flight restores, by db path. */
  private readonly restoring = new Map<string, Promise<RestoreOutcome>>();

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  /**
   * Spec §4 step 3, with both directions of the stale-data trap closed:
   * - local file missing + replica exists → restore (never serve an empty file
   *   that masks real data)
   * - local file present → keep it (never clobber newer local writes with a
   *   stale replica; service restarts keep local state, instance replacement
   *   starts from an empty disk)
   * - neither exists → initialize a fresh WAL-mode database
   *
   * ONE restore per path at a time, whoever asks. `ensureServed` has its own
   * per-app mutex, but the registry reconcile (`doSync`) never looked at it:
   * both saw "no local file", both spawned `litestream restore`, and the slower
   * one started after the faster had created the fresh db — "cannot restore,
   * output path already exists", a 503 on a new app's first request. Held
   * HERE, below every caller, so a third path cannot forget it. The second
   * caller gets the first one's outcome, not a guess.
   */
  restoreIfMissing(app: LitestreamApp, replicaUrl: string): Promise<RestoreOutcome> {
    const running = this.restoring.get(app.dbPath);
    if (running) return running;
    const task = this.restoreOnce(app, replicaUrl).finally(() => this.restoring.delete(app.dbPath));
    this.restoring.set(app.dbPath, task);
    return task;
  }

  private async restoreOnce(app: LitestreamApp, replicaUrl: string): Promise<RestoreOutcome> {
    mkdirSync(dirname(app.dbPath), { recursive: true });
    if (existsSync(app.dbPath)) return "existing";
    if (!this.cfg.litestreamDisabled) {
      await this.runRestore(app, replicaUrl);
      if (existsSync(app.dbPath)) {
        log({ event: "restored", appId: app.appId });
        return "restored";
      }
    }
    this.initFreshDb(app.dbPath);
    log({ event: "fresh", appId: app.appId });
    return "fresh";
  }

  private runRestore(app: LitestreamApp, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cfg.litestreamBin, ["restore", "-if-replica-exists", "-o", app.dbPath, url], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const deadline = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
      child.on("error", (err) => {
        clearTimeout(deadline);
        reject(new Error(`litestream restore failed for ${app.appId}: ${err.message}`));
      });
      child.on("exit", (code) => {
        clearTimeout(deadline);
        if (code === 0) resolve();
        else reject(new Error(`litestream restore failed for ${app.appId}: exit ${code} ${stderr.trim()}`));
      });
    });
  }

  private initFreshDb(dbPath: string): void {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.close();
  }
}
