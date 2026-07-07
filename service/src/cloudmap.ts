// Cloud Map self-registration: the API Gateway VPC Link discovers the instance
// through a service-discovery service; the singleton registers its own private
// IP at boot (deregister-all-then-register-self is safe precisely because the
// ASG guarantees at most one live instance) and deregisters on drain.
import {
  DeregisterInstanceCommand,
  ListInstancesCommand,
  RegisterInstanceCommand,
  ServiceDiscoveryClient,
} from "@aws-sdk/client-servicediscovery";

const IMDS_BASE = "http://169.254.169.254";

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "cloudmap", ...event }));
}

async function imds(path: string): Promise<string> {
  const tokenRes = await fetch(`${IMDS_BASE}/latest/api/token`, {
    method: "PUT",
    headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
    signal: AbortSignal.timeout(3000),
  });
  if (!tokenRes.ok) throw new Error(`IMDS token failed: ${tokenRes.status}`);
  const token = await tokenRes.text();
  const res = await fetch(`${IMDS_BASE}${path}`, {
    headers: { "X-aws-ec2-metadata-token": token },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`IMDS ${path} failed: ${res.status}`);
  return res.text();
}

export class CloudMapRegistration {
  private readonly client: ServiceDiscoveryClient;
  private readonly serviceId: string;
  private readonly port: number;
  private instanceId: string | null = null;

  constructor(opts: { serviceId: string; region: string; port: number; client?: ServiceDiscoveryClient }) {
    this.serviceId = opts.serviceId;
    this.port = opts.port;
    this.client = opts.client ?? new ServiceDiscoveryClient({ region: opts.region });
  }

  /** Boot: clear any stale registrations, then register this instance. */
  async register(): Promise<void> {
    const [instanceId, ip] = await Promise.all([
      imds("/latest/meta-data/instance-id"),
      imds("/latest/meta-data/local-ipv4"),
    ]);

    const existing = await this.client.send(new ListInstancesCommand({ ServiceId: this.serviceId }));
    for (const inst of existing.Instances ?? []) {
      if (!inst.Id) continue;
      try {
        await this.client.send(new DeregisterInstanceCommand({ ServiceId: this.serviceId, InstanceId: inst.Id }));
        log({ event: "deregistered-stale", instanceId: inst.Id });
      } catch (err) {
        log({ event: "deregister-stale-failed", instanceId: inst.Id, message: (err as Error).message });
      }
    }

    await this.client.send(
      new RegisterInstanceCommand({
        ServiceId: this.serviceId,
        InstanceId: instanceId,
        Attributes: {
          AWS_INSTANCE_IPV4: ip,
          AWS_INSTANCE_PORT: String(this.port),
        },
      }),
    );
    this.instanceId = instanceId;
    log({ event: "registered", instanceId, ip, port: this.port });
  }

  /** Drain: pull this instance out of discovery before the API stops answering. */
  async deregister(): Promise<void> {
    if (!this.instanceId) return;
    try {
      await this.client.send(
        new DeregisterInstanceCommand({ ServiceId: this.serviceId, InstanceId: this.instanceId }),
      );
      log({ event: "deregistered", instanceId: this.instanceId });
    } catch (err) {
      log({ event: "deregister-failed", message: (err as Error).message });
    }
    this.instanceId = null;
  }
}
