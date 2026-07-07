// Shared helpers for the acceptance/chaos scripts. Infra operations go through
// the aws CLI (present wherever these ops scripts run); API calls are SigV4.
import { execFileSync } from "node:child_process";

export function aws(args, opts = {}) {
  const out = execFileSync("aws", args, { encoding: "utf8", ...opts });
  return out.trim();
}

export function awsJson(args) {
  const out = aws([...args, "--output", "json"]);
  return out ? JSON.parse(out) : null;
}

export function stackOutputs(stackName, region) {
  const res = awsJson([
    "cloudformation", "describe-stacks",
    "--stack-name", stackName,
    "--region", region,
  ]);
  const outputs = {};
  for (const o of res.Stacks[0].Outputs ?? []) outputs[o.OutputKey] = o.OutputValue;
  return outputs;
}

export function asgInstanceId(stackName, region) {
  const asgs = awsJson(["autoscaling", "describe-auto-scaling-groups", "--region", region]);
  const asg = asgs.AutoScalingGroups.find((g) =>
    g.Tags?.some((t) => t.Key === "aws:cloudformation:stack-name" && t.Value === stackName),
  );
  if (!asg) throw new Error(`no ASG found for stack ${stackName}`);
  const inService = asg.Instances.filter((i) => i.LifecycleState === "InService");
  return { asgName: asg.AutoScalingGroupName, instanceId: inService[0]?.InstanceId ?? null };
}

export async function waitFor(label, check, { timeoutMs = 300_000, intervalMs = 5000 } = {}) {
  const start = Date.now();
  for (;;) {
    let result;
    try {
      result = await check();
    } catch {
      result = false;
    }
    if (result) return Date.now() - start;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
