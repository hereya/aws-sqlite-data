import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import type { AppWorker, WorkerPool } from "./worker-host.ts";

/**
 * Maps an appId to its on-disk database and worker. Layout mirrors the
 * S3 replica layout: <dbDir>/<appId>/app.db
 */
export class AppManager {
  private readonly cfg: Config;
  private readonly pool: WorkerPool;

  constructor(cfg: Config, pool: WorkerPool) {
    this.cfg = cfg;
    this.pool = pool;
  }

  dbPath(appId: string): string {
    return join(this.cfg.dbDir, appId, "app.db");
  }

  workerFor(appId: string): AppWorker {
    const path = this.dbPath(appId);
    mkdirSync(dirname(path), { recursive: true });
    return this.pool.get(appId, path);
  }

  async removeApp(appId: string): Promise<void> {
    await this.pool.remove(appId);
  }

  async closeAll(): Promise<void> {
    await this.pool.closeAll();
  }

  get openApps(): number {
    return this.pool.size;
  }
}
