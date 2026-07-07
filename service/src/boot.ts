// Strict boot order (spec §4): read registry → restore EVERY active app →
// bind the HTTP API → start litestream replication → background loops → ready.
// Any restore failure aborts the boot — never serve partially restored.
import type { Server } from "node:http";
import type { Config } from "./config.ts";
import { AppManager } from "./apps.ts";
import { CloudMapRegistration } from "./cloudmap.ts";
import { Heartbeat } from "./heartbeat.ts";
import { Limiter } from "./limits.ts";
import { Litestream } from "./litestream.ts";
import { DdbRegistry, FileRegistry, type Registry } from "./registry.ts";
import { buildServer } from "./server.ts";
import { Shutdown } from "./shutdown.ts";
import { AppSync } from "./sync.ts";
import { TxRegistry } from "./tx.ts";
import { resolveWorkerPath, WorkerPool } from "./worker-host.ts";

export interface RunningService {
  server: Server;
  port: number;
  sync: AppSync;
  litestream: Litestream;
  stop: () => Promise<void>;
}

export function createRegistry(cfg: Config): Registry {
  if (cfg.registryMode === "file") return new FileRegistry(cfg.registryFile);
  return new DdbRegistry({ tableName: cfg.registryTable, region: cfg.awsRegion, cacheMs: cfg.registryCacheMs });
}

export async function bootService(cfg: Config, opts: { installSignalHandlers?: boolean } = {}): Promise<RunningService> {
  const registry = createRegistry(cfg);
  const litestream = new Litestream(cfg);
  const txRegistry = new TxRegistry({ idleMs: cfg.txIdleMs, maxMs: cfg.txMaxMs });
  const pool = new WorkerPool({
    maxLiveWorkers: cfg.maxLiveWorkers,
    workerPath: resolveWorkerPath(),
    callbacks: { onTxInvalidated: (appKey) => txRegistry.deleteByAppKey(appKey) },
    canEvict: (appKey) => !txRegistry.hasOpenTx(appKey),
  });
  const manager = new AppManager(cfg, pool);
  const limiter = new Limiter({ maxPerApp: cfg.maxInflightPerApp, maxTotal: cfg.maxInflightTotal });
  const sync = new AppSync(registry, manager, litestream);

  // 1-3. registry + restore-then-serve (throws on any failure = boot aborts)
  const servedAtBoot = await sync.bootRestoreAll();

  // 4. bind the HTTP API
  let shutdownRef: Shutdown | null = null;
  const server = buildServer({
    cfg,
    registry,
    manager,
    txRegistry,
    limiter,
    ensureServed: (appId) => sync.ensureServed(appId),
    onAdminSync: () => sync.syncOnce(),
    onDeleteApp: (appId) => sync.removeApp(appId),
    health: () => ({ litestream: litestream.healthy ? "up" : "down" }),
    isDraining: () => shutdownRef?.isDraining ?? false,
  });
  await new Promise<void>((resolve) => server.listen(cfg.port, resolve));
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : cfg.port;

  // 5. continuous replication
  litestream.start(servedAtBoot);

  // 6. announce ourselves to the API Gateway path (Cloud Map), only once the
  // API is actually able to answer
  let cloudMap: CloudMapRegistration | null = null;
  if (cfg.cloudMapServiceId) {
    cloudMap = new CloudMapRegistration({
      serviceId: cfg.cloudMapServiceId,
      region: cfg.awsRegion,
      port,
    });
    await cloudMap.register();
  }

  // background loops
  const sweeper = setInterval(() => {
    for (const expired of txRegistry.sweep()) {
      void manager.workerFor(expired.appKey).control("rollback", cfg.txOpTimeoutMs).catch(() => {});
      console.log(JSON.stringify({ type: "tx-expired", appKey: expired.appKey, txId: expired.txId }));
    }
  }, 2000);
  sweeper.unref();

  const poller = setInterval(() => {
    void sync.syncOnce().catch((err) => {
      console.error(JSON.stringify({ type: "sync", error: (err as Error).message }));
    });
  }, cfg.registryPollSeconds * 1000);
  poller.unref();

  const heartbeat = new Heartbeat(cfg, () => litestream.healthy);
  heartbeat.start();

  const shutdown = new Shutdown({ cfg, server, manager, sync, litestream, txRegistry, cloudMap });
  shutdownRef = shutdown;
  if (opts.installSignalHandlers !== false) shutdown.install();

  console.log(
    JSON.stringify({ type: "ready", port, apps: servedAtBoot.length, registryMode: cfg.registryMode }),
  );

  return {
    server,
    port,
    sync,
    litestream,
    stop: async () => {
      clearInterval(sweeper);
      clearInterval(poller);
      heartbeat.stop();
      await litestream.stop();
      await manager.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
