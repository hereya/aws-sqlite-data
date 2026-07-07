// Spec §13 acceptance: SIGKILL the Data API process → systemd restarts it
// locally (fast net), WITHOUT an ASG instance replacement.
//   node scripts/acceptance/kill-process.mjs <stackName>
import { signedCall } from "./signed-call.mjs";
import { asgInstanceId, aws, awsJson, stackOutputs, waitFor } from "./stack-info.mjs";

const [, , stackName = "hereya-sqlite-dev"] = process.argv;
const region = process.env.AWS_REGION ?? "eu-west-1";

const outputs = stackOutputs(stackName, region);
const { instanceId } = asgInstanceId(stackName, region);
if (!instanceId) throw new Error("no in-service instance");
console.log(`SIGKILLing hereya-data-api on ${instanceId} via SSM ...`);

const cmd = awsJson([
  "ssm", "send-command",
  "--instance-ids", instanceId,
  "--document-name", "AWS-RunShellScript",
  "--parameters", JSON.stringify({
    commands: [
      "systemctl show hereya-data-api -p MainPID --value",
      "systemctl kill -s SIGKILL hereya-data-api",
      "sleep 3",
      "systemctl is-active hereya-data-api",
      "systemctl show hereya-data-api -p MainPID --value",
      "systemctl show hereya-data-api -p NRestarts --value",
    ],
  }),
  "--region", region,
]);
const commandId = cmd.Command.CommandId;

await waitFor("SSM command done", () => {
  const inv = awsJson([
    "ssm", "get-command-invocation",
    "--command-id", commandId,
    "--instance-id", instanceId,
    "--region", region,
  ]);
  return inv.Status === "Success" || inv.Status === "Failed" ? inv : false;
}, { timeoutMs: 120_000, intervalMs: 5000 });

const inv = awsJson([
  "ssm", "get-command-invocation",
  "--command-id", commandId,
  "--instance-id", instanceId,
  "--region", region,
]);
console.log("--- remote output ---\n" + inv.StandardOutputContent.trim() + "\n---------------------");
const lines = inv.StandardOutputContent.trim().split("\n");
const [pidBefore, activeState, pidAfter] = [lines[0], lines[1], lines[2]];
if (activeState !== "active") throw new Error(`service not active after SIGKILL: ${activeState}`);
if (pidBefore === pidAfter) throw new Error("PID unchanged — was the process actually killed?");

// API answers again and the SAME instance is still there (no ASG replacement)
const api = outputs.dataApiUrl;
await waitFor("API healthy", async () => (await signedCall(api, "/health", undefined, region)).status === 200, {
  timeoutMs: 60_000,
  intervalMs: 3000,
});
const { instanceId: afterId } = asgInstanceId(stackName, region);
if (afterId !== instanceId) throw new Error("instance was replaced — systemd restart should have sufficed");
console.log("kill-process acceptance PASSED (systemd restart, no ASG event)");
