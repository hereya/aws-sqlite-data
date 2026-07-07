// Spec §13 acceptance: cut the instance's network → the heartbeat dead-man
// alarm must reach ALARM; restore → OK. (With telegramBotTokenParam/ChatId set
// the same transitions land in Telegram via the relay.)
// Simulation: swap the instance's SG for an empty egress-less SG — the service
// can no longer reach CloudWatch, so the metric goes silent.
//   node scripts/acceptance/cut-network.mjs <stackName>
import { asgInstanceId, aws, awsJson, stackOutputs, waitFor } from "./stack-info.mjs";

const [, , stackName = "hereya-sqlite-dev"] = process.argv;
const region = process.env.AWS_REGION ?? "eu-west-1";
const alarmName = `${stackName}-heartbeat`;

const { instanceId } = asgInstanceId(stackName, region);
if (!instanceId) throw new Error("no in-service instance");

const inst = awsJson(["ec2", "describe-instances", "--instance-ids", instanceId, "--region", region])
  .Reservations[0].Instances[0];
const originalSgs = inst.SecurityGroups.map((g) => g.GroupId);
const vpcId = inst.VpcId;
console.log(`instance ${instanceId}, original SGs: ${originalSgs.join(",")}`);

// deny-all SG (idempotent): no ingress, and we REVOKE the default egress rule
let denySg;
const existing = awsJson([
  "ec2", "describe-security-groups", "--region", region,
  "--filters", `Name=group-name,Values=${stackName}-deny-all`, `Name=vpc-id,Values=${vpcId}`,
]);
if (existing.SecurityGroups.length > 0) {
  denySg = existing.SecurityGroups[0].GroupId;
} else {
  denySg = awsJson([
    "ec2", "create-security-group", "--region", region,
    "--group-name", `${stackName}-deny-all`,
    "--description", "chaos: deny all traffic",
    "--vpc-id", vpcId,
  ]).GroupId;
  aws([
    "ec2", "revoke-security-group-egress", "--region", region,
    "--group-id", denySg,
    "--protocol", "-1", "--port", "-1", "--cidr", "0.0.0.0/0",
  ]);
}
console.log(`deny-all SG: ${denySg}`);

try {
  aws(["ec2", "modify-instance-attribute", "--instance-id", instanceId, "--groups", denySg, "--region", region]);
  console.log("network cut — waiting for the dead-man alarm (3-of-5 minutes + alarm eval; give it ~10 min)");
  const toAlarm = await waitFor(
    "heartbeat alarm in ALARM",
    () => {
      const a = awsJson(["cloudwatch", "describe-alarms", "--alarm-names", alarmName, "--region", region]);
      const state = a.MetricAlarms[0]?.StateValue;
      process.stdout.write(`  alarm state: ${state}\n`);
      return state === "ALARM";
    },
    { timeoutMs: 15 * 60_000, intervalMs: 30_000 },
  );
  console.log(`ALARM reached ${Math.round(toAlarm / 1000)}s after the cut`);
} finally {
  aws(["ec2", "modify-instance-attribute", "--instance-id", instanceId, "--groups", ...originalSgs, "--region", region]);
  console.log("network restored");
}

const toOk = await waitFor(
  "heartbeat alarm back to OK",
  () => {
    const a = awsJson(["cloudwatch", "describe-alarms", "--alarm-names", alarmName, "--region", region]);
    return a.MetricAlarms[0]?.StateValue === "OK";
  },
  { timeoutMs: 15 * 60_000, intervalMs: 30_000 },
);
console.log(`OK reached ${Math.round(toOk / 1000)}s after restore — cut-network acceptance PASSED`);
