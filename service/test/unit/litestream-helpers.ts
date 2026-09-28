// Shared by the litestream-*.test.ts files (not itself a test file).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config.ts";
import { Litestream } from "../../src/litestream.ts";

export const litestreamBin = fileURLToPath(new URL("../../../.toolchain/litestream", import.meta.url));
export const haveLitestream = existsSync(litestreamBin);

export function makeLitestream(extra: Record<string, string> = {}): Litestream {
  return new Litestream(
    loadConfig({
      REPLICA_BASE_URL: "file:///replicas",
      LITESTREAM_SYNC_INTERVAL_MS: "1000",
      LITESTREAM_RETENTION: "72h",
      LITESTREAM_SNAPSHOT_INTERVAL: "6h",
      ...extra,
    } as NodeJS.ProcessEnv),
  );
}

export const APPS = [
  { appId: "app-1", dbPath: "/dbs/app-1/app.db" },
  { appId: "app-2", dbPath: "/dbs/app-2/app.db" },
];
