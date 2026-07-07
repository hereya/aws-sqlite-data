import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AppManager } from "./apps.ts";
import type { Litestream, LitestreamApp } from "./litestream.ts";
import type { Registry } from "./registry.ts";
import { ServiceError } from "./errors.ts";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "sync", ...event }));
}

/**
 * Owns the "served set": which apps have a restored local db and are covered
 * by the litestream config. Reconciles it against the registry at boot, on the
 * poll interval, on /admin/sync, and on-demand when a request hits an app the
 * registry knows but this instance doesn't serve yet (hot-add without restart).
 */
export class AppSync {
  private readonly registry: Registry;
  private readonly manager: AppManager;
  private readonly litestream: Litestream;
  private readonly served = new Map<string, LitestreamApp>();
  private readonly pending = new Map<string, Promise<void>>();
  private syncing: Promise<{ added: number; removed: number }> | null = null;

  constructor(registry: Registry, manager: AppManager, litestream: Litestream) {
    this.registry = registry;
    this.manager = manager;
    this.litestream = litestream;
  }

  /** Spec §4 steps 2-3: restore every active app BEFORE the API binds. */
  async bootRestoreAll(): Promise<LitestreamApp[]> {
    const active = await this.registry.listActive();
    for (const ref of active) {
      const app: LitestreamApp = {
        appId: ref.appId,
        dbPath: this.manager.dbPath(ref.appId),
      };
      await this.litestream.restoreIfMissing(app);
      this.served.set(ref.appId, app);
    }
    log({ event: "boot-restore-complete", apps: this.served.size });
    return [...this.served.values()];
  }

  get servedApps(): LitestreamApp[] {
    return [...this.served.values()];
  }

  isServed(appId: string): boolean {
    return this.served.has(appId);
  }

  /**
   * Request-path hot-add: the registry already said "active" (fail-closed
   * check done by the caller); make the app servable if it isn't yet.
   * Restore-if-missing runs BEFORE the first query so a replica in S3 can
   * never be shadowed by a freshly created empty file. A per-app mutex keeps
   * concurrent first-requests from racing the restore.
   */
  async ensureServed(appId: string): Promise<void> {
    const key = appId;
    if (this.served.has(key)) return;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = (async () => {
      const app: LitestreamApp = { appId, dbPath: this.manager.dbPath(appId) };
      try {
        await this.litestream.restoreIfMissing(app);
        this.served.set(key, app);
        await this.litestream.bounce(this.servedApps);
        log({ event: "hot-add", appId });
      } catch (err) {
        this.served.delete(key);
        throw new ServiceError("UNAVAILABLE", `app could not be prepared: ${(err as Error).message}`);
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, task);
    return task;
  }

  /**
   * Explicit teardown (delete-app flow): close the executor, drop the
   * app from the litestream config, delete the LOCAL file. The S3 replica is
   * retained as the durable archive. Idempotent; works whether or not the app
   * is currently served (its registry row is typically already non-active).
   */
  async removeApp(appId: string): Promise<void> {
    const key = appId;
    const wasServed = this.served.delete(key);
    await this.manager.removeApp(appId);
    try {
      rmSync(dirname(this.manager.dbPath(appId)), { recursive: true, force: true });
    } catch (err) {
      log({ event: "remove-cleanup-failed", appId, message: (err as Error).message });
    }
    if (wasServed) await this.litestream.bounce(this.servedApps);
    log({ event: "removed", appId, wasServed });
  }

  /** Full reconcile: registry is the source of truth for adds AND removals. */
  async syncOnce(): Promise<{ added: number; removed: number }> {
    if (this.syncing) return this.syncing;
    this.syncing = this.doSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSync(): Promise<{ added: number; removed: number }> {
    await this.registry.reload();
    const active = await this.registry.listActive();
    const target = new Map(active.map((ref) => [ref.appId, ref]));

    let added = 0;
    let removed = 0;

    for (const [key, ref] of target) {
      if (this.served.has(key)) continue;
      const app: LitestreamApp = {
        appId: ref.appId,
        dbPath: this.manager.dbPath(ref.appId),
      };
      await this.litestream.restoreIfMissing(app);
      this.served.set(key, app);
      added += 1;
    }

    for (const [key, app] of [...this.served]) {
      if (target.has(key)) continue;
      this.served.delete(key);
      await this.manager.removeApp(app.appId);
      // Local file goes; the S3 replica is retained as the durable archive
      // (cleanup is a documented manual op — litestream retention stops with
      // replication, and no S3 lifecycle rule is allowed to touch it).
      try {
        rmSync(dirname(app.dbPath), { recursive: true, force: true });
      } catch (err) {
        log({ event: "remove-cleanup-failed", appId: app.appId, message: (err as Error).message });
      }
      removed += 1;
      log({ event: "removed", appId: app.appId });
    }

    if (added > 0 || removed > 0) {
      await this.litestream.bounce(this.servedApps);
    }
    return { added, removed };
  }
}
