// Graceful shutdown: on SIGTERM or a Spot interruption notice, stop taking
// requests (503 → callers retry politely), roll back open transactions,
// checkpoint every served app's WAL, give litestream a final sync window,
// then exit. Narrows the loss window on clean interruptions to ~zero.
import type { Server } from "node:http";
import type { Config } from "./config.ts";
import type { AppManager } from "./apps.ts";
import type { AppSync } from "./sync.ts";
import type { CloudMapRegistration } from "./cloudmap.ts";
import type { Litestream } from "./litestream.ts";
import type { TxRegistry } from "./tx.ts";

const IMDS_BASE = "http://169.254.169.254";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "shutdown", ...event }));
}

export class Shutdown {
  private readonly cfg: Config;
  private readonly server: Server;
  private readonly manager: AppManager;
  private readonly sync: AppSync;
  private readonly litestream: Litestream;
  private readonly txRegistry: TxRegistry;
  private readonly cloudMap: CloudMapRegistration | null;
  private draining = false;
  private spotTimer: NodeJS.Timeout | null = null;

  constructor(opts: {
    cfg: Config;
    server: Server;
    manager: AppManager;
    sync: AppSync;
    litestream: Litestream;
    txRegistry: TxRegistry;
    cloudMap?: CloudMapRegistration | null;
  }) {
    this.cfg = opts.cfg;
    this.server = opts.server;
    this.manager = opts.manager;
    this.sync = opts.sync;
    this.litestream = opts.litestream;
    this.txRegistry = opts.txRegistry;
    this.cloudMap = opts.cloudMap ?? null;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  install(): void {
    process.on("SIGTERM", () => void this.begin("SIGTERM"));
    process.on("SIGINT", () => void this.begin("SIGINT"));
    if (this.cfg.imdsEnabled) this.watchSpotNotice();
  }

  /** Poll IMDSv2 for the 2-minute Spot interruption notice. */
  private watchSpotNotice(): void {
    const poll = async (): Promise<void> => {
      try {
        const tokenRes = await fetch(`${IMDS_BASE}/latest/api/token`, {
          method: "PUT",
          headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
          signal: AbortSignal.timeout(2000),
        });
        if (!tokenRes.ok) return;
        const token = await tokenRes.text();
        const res = await fetch(`${IMDS_BASE}/latest/meta-data/spot/instance-action`, {
          headers: { "X-aws-ec2-metadata-token": token },
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          log({ event: "spot-interruption-notice" });
          void this.begin("spot-interruption");
        }
      } catch {
        // IMDS unreachable — not our signal to act on
      }
    };
    this.spotTimer = setInterval(() => void poll(), 5000);
    this.spotTimer.unref();
  }

  async begin(reason: string): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    log({ event: "drain-start", reason });
    if (this.spotTimer) clearInterval(this.spotTimer);

    // 0. Leave service discovery first so API Gateway stops routing to us.
    if (this.cloudMap) await this.cloudMap.deregister();

    // 1. Roll back whatever transactions are open (their callers get TX_NOT_FOUND).
    for (const app of this.sync.servedApps) {
      const appKey = app.appId;
      if (!this.txRegistry.hasOpenTx(appKey)) continue;
      this.txRegistry.deleteByAppKey(appKey);
      try {
        await this.manager.workerFor(app.appId).control("rollback", this.cfg.txOpTimeoutMs);
      } catch {
        // worker may already be gone; WAL semantics roll it back regardless
      }
    }

    // 2. Let in-flight requests finish (bounded), while new ones get 503.
    await new Promise((r) => setTimeout(r, this.cfg.drainMs));

    // 3. Checkpoint each served app so the final litestream sync ships everything.
    for (const app of this.sync.servedApps) {
      try {
        await this.manager.workerFor(app.appId).control("checkpoint", this.cfg.txOpTimeoutMs);
      } catch (err) {
        log({ event: "checkpoint-failed", appId: app.appId, message: (err as Error).message });
      }
    }

    // 4. Final replication window, then stop litestream cleanly.
    await new Promise((r) => setTimeout(r, this.cfg.litestreamSyncIntervalMs * 2));
    await this.litestream.stop();

    await this.manager.closeAll();
    this.server.close();
    log({ event: "drain-complete", reason });
    process.exit(0);
  }
}
