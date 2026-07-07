// Litestream lifecycle, supervised by the service itself (not systemd): the
// strict restore-then-serve boot order and hot-add both live here, in tested
// TypeScript instead of shell.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";

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

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  replicaUrl(app: LitestreamApp): string {
    return `${this.cfg.replicaBaseUrl}/${app.appId}/app.db`;
  }

  /**
   * Spec §4 step 3, with both directions of the stale-data trap closed:
   * - local file missing + replica exists → restore (never serve an empty file
   *   that masks real data)
   * - local file present → keep it (never clobber newer local writes with a
   *   stale replica; service restarts keep local state, instance replacement
   *   starts from an empty disk)
   * - neither exists → initialize a fresh WAL-mode database
   */
  async restoreIfMissing(app: LitestreamApp): Promise<RestoreOutcome> {
    mkdirSync(dirname(app.dbPath), { recursive: true });
    if (existsSync(app.dbPath)) return "existing";
    if (!this.cfg.litestreamDisabled) {
      const url = this.replicaUrl(app);
      await this.runRestore(app, url);
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

  buildConfig(apps: LitestreamApp[]): string {
    const interval = `${this.cfg.litestreamSyncIntervalMs}ms`;
    const lines: string[] = ["dbs:"];
    for (const app of apps) {
      lines.push(`  - path: ${app.dbPath}`);
      lines.push(`    replicas:`);
      lines.push(`      - url: ${this.replicaUrl(app)}`);
      lines.push(`        sync-interval: ${interval}`);
      lines.push(`        retention: ${this.cfg.litestreamRetention}`);
      lines.push(`        snapshot-interval: ${this.cfg.litestreamSnapshotInterval}`);
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

  /** Hot-add/remove: regenerate config and bounce the child (~1s pause). */
  async bounce(apps: LitestreamApp[]): Promise<void> {
    if (this.cfg.litestreamDisabled) return;
    this.writeConfig(apps);
    await this.stopChild();
    if (apps.length > 0) this.spawnChild();
    else this.childHealthy = true;
  }

  get healthy(): boolean {
    if (this.cfg.litestreamDisabled) return true;
    return this.childHealthy;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.stopChild();
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
