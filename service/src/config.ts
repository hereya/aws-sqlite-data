import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export interface Config {
  port: number;
  dbDir: string;
  registryMode: "file" | "ddb";
  registryFile: string;
  registryTable: string;
  awsRegion: string;
  sqlTimeoutMs: number;
  txOpTimeoutMs: number;
  maxInflightPerApp: number;
  maxInflightTotal: number;
  maxLiveWorkers: number;
  txIdleMs: number;
  txMaxMs: number;
  maxResponseBytes: number;
  maxRequestBytes: number;
  maxSqlBytes: number;
  registryCacheMs: number;
  registryPollSeconds: number;
  litestreamDisabled: boolean;
  litestreamBin: string;
  litestreamConfigPath: string;
  replicaBaseUrl: string;
  litestreamSyncIntervalMs: number;
  litestreamRetention: string;
  litestreamSnapshotInterval: string;
  heartbeatEnabled: boolean;
  heartbeatPeriodSeconds: number;
  heartbeatDimension: string;
  imdsEnabled: boolean;
  drainMs: number;
  cloudMapServiceId: string;
  // Per-request capability token (spec §6 caller-binding). The shared HMAC
  // secret is resolved at boot: from Secrets Manager when CAPABILITY_SECRET_ARN
  // is set (prod), else from the CAPABILITY_SECRET env var (local/tests). Empty
  // is only tolerated when enforcement is off (rollout-compat window).
  capabilitySecret: string;
  capabilityEnforce: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // port 0 is valid (ephemeral, used by tests); negatives and garbage are not
  function intEnv(name: string, fallback: number): number {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw new Error(`invalid ${name}: ${raw}`);
    }
    return n;
  }

  const registryMode = (env.REGISTRY_MODE ?? "ddb") as Config["registryMode"];
  if (registryMode !== "file" && registryMode !== "ddb") {
    throw new Error(`invalid REGISTRY_MODE: ${env.REGISTRY_MODE}`);
  }
  return {
    port: intEnv("PORT", 8080),
    dbDir: env.DB_DIR ?? "/var/lib/hereya/dbs",
    registryMode,
    registryFile: env.REGISTRY_FILE ?? "",
    registryTable: env.REGISTRY_TABLE ?? "",
    awsRegion: env.AWS_REGION ?? "eu-west-1",
    sqlTimeoutMs: intEnv("SQL_TIMEOUT_MS", 20_000),
    txOpTimeoutMs: intEnv("TX_OP_TIMEOUT_MS", 5_000),
    maxInflightPerApp: intEnv("MAX_INFLIGHT_PER_APP", 16),
    maxInflightTotal: intEnv("MAX_INFLIGHT_TOTAL", 64),
    maxLiveWorkers: intEnv("MAX_LIVE_WORKERS", 8),
    txIdleMs: intEnv("TX_IDLE_MS", 15_000),
    txMaxMs: intEnv("TX_MAX_MS", 60_000),
    maxResponseBytes: intEnv("MAX_RESPONSE_BYTES", 1_048_576),
    maxRequestBytes: intEnv("MAX_REQUEST_BYTES", 1_048_576),
    maxSqlBytes: intEnv("MAX_SQL_BYTES", 262_144),
    registryCacheMs: intEnv("REGISTRY_CACHE_MS", 30_000),
    registryPollSeconds: intEnv("REGISTRY_POLL_SECONDS", 30),
    litestreamDisabled: env.LITESTREAM_DISABLED === "1" || env.LITESTREAM_DISABLED === "true",
    litestreamBin: env.LITESTREAM_BIN ?? "litestream",
    litestreamConfigPath: env.LITESTREAM_CONFIG_PATH ?? "/etc/hereya/litestream.yml",
    replicaBaseUrl: (env.REPLICA_BASE_URL ?? "").replace(/\/+$/, ""),
    litestreamSyncIntervalMs: intEnv("LITESTREAM_SYNC_INTERVAL_MS", 1000),
    litestreamRetention: env.LITESTREAM_RETENTION ?? "72h",
    litestreamSnapshotInterval: env.LITESTREAM_SNAPSHOT_INTERVAL ?? "6h",
    heartbeatEnabled: env.HEARTBEAT_ENABLED === "1" || env.HEARTBEAT_ENABLED === "true",
    heartbeatPeriodSeconds: intEnv("HEARTBEAT_PERIOD_SECONDS", 60),
    heartbeatDimension: env.HEARTBEAT_DIMENSION ?? "hereya-sqlite-data",
    imdsEnabled: env.IMDS_ENABLED === "1" || env.IMDS_ENABLED === "true",
    drainMs: intEnv("DRAIN_MS", 5_000),
    cloudMapServiceId: env.CLOUDMAP_SERVICE_ID ?? "",
    // The Secrets Manager fetch is async (see resolveCapabilitySecret); here we
    // only seed the plaintext-env fallback used when no ARN is provided.
    capabilitySecret: env.CAPABILITY_SECRET ?? "",
    capabilityEnforce: env.CAPABILITY_ENFORCE === "true",
  };
}

/**
 * Resolve the capability HMAC secret at boot. When CAPABILITY_SECRET_ARN is set
 * (the CDK stack injects it), fetch the plaintext SecretString from Secrets
 * Manager; otherwise fall back to the CAPABILITY_SECRET env var already loaded
 * into `cfg.capabilitySecret`. Fails closed: if enforcement is on but no secret
 * could be resolved, the boot aborts rather than run unauthenticated.
 *
 * The stack generates a RAW random secret string (no SecretStringTemplate), so
 * SecretString is the secret verbatim — no JSON key to unwrap.
 */
export async function resolveCapabilitySecret(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  let secret = cfg.capabilitySecret;
  const arn = env.CAPABILITY_SECRET_ARN;
  if (arn !== undefined && arn !== "") {
    const client = new SecretsManagerClient({ region: cfg.awsRegion });
    try {
      const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
      secret = res.SecretString ?? "";
    } finally {
      client.destroy();
    }
  }
  if (cfg.capabilityEnforce && secret === "") {
    throw new Error("CAPABILITY_ENFORCE is on but no capability secret could be resolved");
  }
  return secret;
}
