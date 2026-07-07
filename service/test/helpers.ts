import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { Config } from "../src/config.ts";
import { AppManager } from "../src/apps.ts";
import { Limiter } from "../src/limits.ts";
import { FileRegistry } from "../src/registry.ts";
import { buildServer } from "../src/server.ts";
import { TxRegistry } from "../src/tx.ts";
import { resolveWorkerPath, WorkerPool } from "../src/worker-host.ts";

export interface TestService {
  baseUrl: string;
  registryFile: string;
  setRegistry: (entries: Array<{ app_id: string; status: string }>) => void;
  close: () => Promise<void>;
}

export const DEFAULT_REGISTRY = [
  { app_id: "app-1", status: "active" },
  { app_id: "app-2", status: "active" },
  { app_id: "app-old", status: "inactive" },
];

export async function startTestService(overrides: Partial<Config> = {}): Promise<TestService> {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-data-test-"));
  const registryFile = join(dir, "registry.json");
  writeFileSync(registryFile, JSON.stringify(DEFAULT_REGISTRY));

  const cfg: Config = {
    port: 0,
    dbDir: join(dir, "dbs"),
    registryMode: "file",
    registryFile,
    registryTable: "",
    awsRegion: "eu-west-1",
    sqlTimeoutMs: 1500,
    txOpTimeoutMs: 3000,
    maxInflightPerApp: 16,
    maxInflightTotal: 64,
    maxLiveWorkers: 8,
    txIdleMs: 15_000,
    txMaxMs: 60_000,
    maxResponseBytes: 1_048_576,
    maxRequestBytes: 1_048_576,
    maxSqlBytes: 262_144,
    registryCacheMs: 100,
    registryPollSeconds: 30,
    litestreamDisabled: true,
    litestreamBin: "litestream",
    litestreamConfigPath: join(dir, "litestream.yml"),
    replicaBaseUrl: "",
    litestreamSyncIntervalMs: 200,
    litestreamRetention: "72h",
    litestreamSnapshotInterval: "6h",
    heartbeatEnabled: false,
    heartbeatPeriodSeconds: 60,
    heartbeatDimension: "test",
    imdsEnabled: false,
    drainMs: 100,
    cloudMapServiceId: "",
    capabilitySecret: "",
    capabilityEnforce: false,
    ...overrides,
  };

  const registry = new FileRegistry(cfg.registryFile);
  const txRegistry = new TxRegistry({ idleMs: cfg.txIdleMs, maxMs: cfg.txMaxMs });
  const pool = new WorkerPool({
    maxLiveWorkers: cfg.maxLiveWorkers,
    workerPath: resolveWorkerPath(),
    callbacks: { onTxInvalidated: (appKey) => txRegistry.deleteByAppKey(appKey) },
    canEvict: (appKey) => !txRegistry.hasOpenTx(appKey),
  });
  const manager = new AppManager(cfg, pool);
  const limiter = new Limiter({ maxPerApp: cfg.maxInflightPerApp, maxTotal: cfg.maxInflightTotal });
  const server: Server = buildServer({ cfg, registry, manager, txRegistry, limiter });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    registryFile,
    setRegistry: (entries) => {
      writeFileSync(registryFile, JSON.stringify(entries));
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await manager.closeAll();
    },
  };
}

export async function call(
  baseUrl: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
