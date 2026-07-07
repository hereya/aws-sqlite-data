// Dead-man switch: the service emits a CloudWatch metric only while it is
// genuinely healthy end-to-end (HTTP up AND litestream replicating). Silence —
// instance dead, service wedged, replication down, network cut — trips the
// missing-data alarm, which relays to Telegram. « Le silence est interdit. »
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import type { Config } from "./config.ts";

export const METRIC_NAMESPACE = "Hereya/SqliteData";
export const METRIC_NAME = "Heartbeat";

export class Heartbeat {
  private readonly cfg: Config;
  private readonly client: CloudWatchClient;
  private readonly isHealthy: () => boolean;
  private timer: NodeJS.Timeout | null = null;

  constructor(cfg: Config, isHealthy: () => boolean, client?: CloudWatchClient) {
    this.cfg = cfg;
    this.isHealthy = isHealthy;
    this.client = client ?? new CloudWatchClient({ region: cfg.awsRegion });
  }

  start(): void {
    if (!this.cfg.heartbeatEnabled) return;
    const beat = async (): Promise<void> => {
      if (!this.isHealthy()) {
        console.log(JSON.stringify({ type: "heartbeat", skipped: true, reason: "unhealthy" }));
        return;
      }
      try {
        await this.client.send(
          new PutMetricDataCommand({
            Namespace: METRIC_NAMESPACE,
            MetricData: [
              {
                MetricName: METRIC_NAME,
                Dimensions: [{ Name: "stack", Value: this.cfg.heartbeatDimension }],
                Value: 1,
              },
            ],
          }),
        );
      } catch (err) {
        // do not crash on a metrics hiccup; sustained failure = alarm fires anyway
        console.error(JSON.stringify({ type: "heartbeat", error: (err as Error).message }));
      }
    };
    void beat();
    this.timer = setInterval(() => void beat(), this.cfg.heartbeatPeriodSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
