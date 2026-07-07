import { readFileSync, statSync } from "node:fs";
import {
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { ServiceError } from "./errors.ts";

export type RegistryStatus = "active" | "inactive" | "unknown";

export interface AppRef {
  appId: string;
}

/**
 * The service's own copy of the app registry — the defense-in-depth check
 * (spec §6): it never trusts the platform caller's declared app id. Every
 * lookup is fail-closed: backend errors surface as UNAVAILABLE, never as
 * "allowed".
 */
export interface Registry {
  lookup(appId: string): Promise<RegistryStatus>;
  listActive(): Promise<AppRef[]>;
  reload(): Promise<void>;
}

interface FileEntry {
  app_id: string;
  status: string;
}

/**
 * DynamoDB registry: one row per app, PK app_id, attributes
 * {status: active|inactive, name, createdAt}. Positive/negative lookups are
 * cached briefly; backend errors are NEVER cached and always deny
 * (fail-closed).
 */
export class DdbRegistry implements Registry {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { status: RegistryStatus; at: number }>();

  constructor(opts: {
    tableName: string;
    region: string;
    cacheMs: number;
    client?: DynamoDBClient;
    now?: () => number;
  }) {
    if (!opts.tableName) throw new Error("REGISTRY_TABLE is required in ddb registry mode");
    this.tableName = opts.tableName;
    this.cacheMs = opts.cacheMs;
    this.client = opts.client ?? new DynamoDBClient({ region: opts.region });
    this.now = opts.now ?? Date.now;
  }

  async lookup(appId: string): Promise<RegistryStatus> {
    const cached = this.cache.get(appId);
    if (cached && this.now() - cached.at < this.cacheMs) return cached.status;
    let status: RegistryStatus;
    try {
      const res = await this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: { app_id: { S: appId } },
          ConsistentRead: true,
          ProjectionExpression: "#s",
          ExpressionAttributeNames: { "#s": "status" },
        }),
      );
      const raw = res.Item?.status?.S;
      status = raw === undefined ? "unknown" : raw === "active" ? "active" : "inactive";
    } catch (err) {
      // fail-closed: an unreachable registry denies, and the failure is not cached
      throw new ServiceError("UNAVAILABLE", `registry lookup failed: ${(err as Error).message}`);
    }
    this.cache.set(appId, { status, at: this.now() });
    return status;
  }

  async listActive(): Promise<AppRef[]> {
    const refs: AppRef[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    try {
      do {
        const res = await this.client.send(
          new ScanCommand({
            TableName: this.tableName,
            FilterExpression: "#s = :active",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":active": { S: "active" } },
            ProjectionExpression: "app_id",
            ExclusiveStartKey: startKey,
          }),
        );
        for (const item of res.Items ?? []) {
          const appId = item.app_id?.S;
          if (appId) refs.push({ appId });
        }
        startKey = res.LastEvaluatedKey;
      } while (startKey);
    } catch (err) {
      throw new ServiceError("UNAVAILABLE", `registry scan failed: ${(err as Error).message}`);
    }
    return refs;
  }

  async reload(): Promise<void> {
    this.cache.clear();
  }
}

/**
 * Local-dev registry: a JSON file of {app_id, status} entries, re-read when
 * its mtime changes. The DynamoDB registry lands with the AWS wiring; this
 * keeps the whole API testable on a laptop.
 */
export class FileRegistry implements Registry {
  private readonly file: string;
  private entries = new Map<string, RegistryStatus>();
  private loadedMtimeMs = -1;

  constructor(file: string) {
    if (!file) throw new Error("REGISTRY_FILE is required in file registry mode");
    this.file = file;
  }

  async lookup(appId: string): Promise<RegistryStatus> {
    this.refresh();
    return this.entries.get(appId) ?? "unknown";
  }

  async listActive(): Promise<AppRef[]> {
    this.refresh();
    const active: AppRef[] = [];
    for (const [appId, status] of this.entries) {
      if (status !== "active") continue;
      active.push({ appId });
    }
    return active;
  }

  async reload(): Promise<void> {
    this.loadedMtimeMs = -1;
    this.refresh();
  }

  private refresh(): void {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch (err) {
      throw new ServiceError("UNAVAILABLE", `registry file unreadable: ${(err as Error).message}`);
    }
    if (mtimeMs === this.loadedMtimeMs) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      throw new ServiceError("UNAVAILABLE", `registry file invalid: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new ServiceError("UNAVAILABLE", "registry file must be a JSON array");
    }
    const next = new Map<string, RegistryStatus>();
    for (const entry of parsed as FileEntry[]) {
      if (!entry || typeof entry.app_id !== "string") continue;
      next.set(entry.app_id, entry.status === "active" ? "active" : "inactive");
    }
    this.entries = next;
    this.loadedMtimeMs = mtimeMs;
  }
}
