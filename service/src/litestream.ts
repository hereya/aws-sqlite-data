// Litestream lifecycle, supervised by the service itself (not systemd): the
// strict restore-then-serve boot order and hot-add both live here, in tested
// TypeScript instead of shell.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import { Restorer } from "./litestream/restore.ts";

export interface LitestreamApp {
  appId: string;
  dbPath: string;
}

export type RestoreOutcome = "existing" | "restored" | "fresh";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "litestream", ...event }));
}

export class Litestream {
  private readonly cfg: Config;
  private child: ChildProcess | null = null;
  private childHealthy = false;
  private stopping = false;
  private readonly restorer: Restorer;
  /**
   * Serializes every change to the replicate process (bounce, stop).
   *
   * Callers of `bounce` overlap in normal operation: a request hot-adding an
   * app, the registry poll / `/admin/sync`, and `/admin/delete-app` each bounce
   * on their own schedule. Unserialized, the second caller found `this.child`
   * already nulled by the first (still awaiting the old child's exit), skipped
   * the stop and spawned; the first then woke up and spawned AGAIN, overwriting
   * `this.child`. The orphan kept replicating, unsupervised and out of reach of
   * `stop()` — two writers on one generation path (invariant 5). Backported
   * from upstream 0.1.26 (race 1); pinned by
   * service/test/unit/bounce-race.test.ts.
   */
  private childOp: Promise<unknown> = Promise.resolve();

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.restorer = new Restorer(cfg);
  }

  /** Run `fn` after the previous child operation settles, whether it resolved
   *  or threw — a failed bounce must not wedge every later one. */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.childOp.then(fn, fn);
    this.childOp = run.catch(() => undefined);
    return run;
  }

  replicaUrl(app: LitestreamApp): string {
    return `${this.cfg.replicaBaseUrl}/${app.appId}/app.db`;
  }

  /** Restore-if-missing, one at a time per db path — see litestream/restore.ts. */
  restoreIfMissing(app: LitestreamApp): Promise<RestoreOutcome> {
    return this.restorer.restoreIfMissing(app, this.replicaUrl(app));
  }

  buildConfig(apps: LitestreamApp[]): string {
    const interval = `${this.cfg.litestreamSyncIntervalMs}ms`;
    // 0.5.x schema (backported from upstream dilaya/aws-sqlite-data 0.1.4):
    // snapshots are configured globally (per-db values must not conflict
    // anyway), and each db takes a single `replica:` — the legacy
    // replica-level `retention:`/`snapshot-interval:` keys are silently
    // IGNORED by 0.5.x (config parsing is non-strict), so keeping them would
    // shrink the restore window to the 24h defaults without any error.
    const lines: string[] = [
      "snapshot:",
      `  interval: ${this.cfg.litestreamSnapshotInterval}`,
      `  retention: ${this.cfg.litestreamRetention}`,
      "dbs:",
    ];
    for (const app of apps) {
      lines.push(`  - path: ${app.dbPath}`);
      lines.push(`    replica:`);
      lines.push(`      url: ${this.replicaUrl(app)}`);
      lines.push(`      sync-interval: ${interval}`);
    }
    if (apps.length === 0) lines.push("  []");
    return lines.join("\n") + "\n";
  }

  writeConfig(apps: LitestreamApp[]): void {
    mkdirSync(dirname(this.cfg.litestreamConfigPath), { recursive: true });
    writeFileSync(this.cfg.litestreamConfigPath, this.buildConfig(apps));
  }

  /** Spec §4 step 5: start continuous replication (after the API is up). */
  start(apps: LitestreamApp[]): void {
    if (this.cfg.litestreamDisabled) return;
    this.writeConfig(apps);
    if (apps.length === 0) {
      // litestream exits immediately with no dbs; treat "nothing to replicate" as healthy
      this.childHealthy = true;
      return;
    }
    this.spawnChild();
  }

  /**
   * Hot-add/remove: regenerate config and bounce the child (~1s pause).
   * Serialized (see `childOp`): calls run in arrival order, so the config left
   * on disk — and read by the one surviving child — is the latest caller's.
   */
  bounce(apps: LitestreamApp[]): Promise<void> {
    if (this.cfg.litestreamDisabled) return Promise.resolve();
    return this.serialized(async () => {
      if (this.stopping) return; // shutting down: never respawn behind stop()
      this.writeConfig(apps);
      await this.stopChild();
      if (this.stopping) return;
      if (apps.length > 0) this.spawnChild();
      else this.childHealthy = true;
    });
  }

  get healthy(): boolean {
    if (this.cfg.litestreamDisabled) return true;
    return this.childHealthy;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // Behind any in-flight bounce, so the child it is about to spawn (if any)
    // is the one we stop — never one spawned after we looked.
    await this.serialized(() => this.stopChild());
  }

  private spawnChild(): void {
    this.childHealthy = false;
    const child = spawn(this.cfg.litestreamBin, ["replicate", "-config", this.cfg.litestreamConfigPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log({ stream: "stdout", text });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log({ stream: "stderr", text });
      // any replication error output flips health until the child proves itself again
      if (/level=ERROR|error/i.test(text)) this.childHealthy = false;
    });
    child.on("spawn", () => {
      this.childHealthy = true;
      log({ event: "replicate-started", pid: child.pid });
    });
    child.on("exit", (code, signal) => {
      this.childHealthy = false;
      if (this.child === child) this.child = null;
      log({ event: "replicate-exited", code, signal });
      // Unexpected death (not a bounce/stop): respawn with backoff — replication
      // must not stay down silently; heartbeat gates on childHealthy meanwhile.
      if (!this.stopping && !this.bouncing) {
        setTimeout(() => {
          if (!this.stopping && !this.bouncing && this.child === null) this.spawnChild();
        }, 2000).unref();
      }
    });
    child.on("error", (err) => {
      this.childHealthy = false;
      log({ event: "replicate-error", message: err.message });
    });
    this.child = child;
  }

  private bouncing = false;

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.bouncing = true;
    this.child = null;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.bouncing = false;
  }
}
