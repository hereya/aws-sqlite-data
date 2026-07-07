// Spec §13 acceptance: an app sending abnormally heavy/numerous requests is
// contained (timeouts + per-app 429) without degrading other apps.
//   node scripts/acceptance/noisy-neighbor.mjs <stackName>
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { signedCall } from "./signed-call.mjs";
import { stackOutputs } from "./stack-info.mjs";

const [, , stackName = "hereya-sqlite-dev"] = process.argv;
const region = process.env.AWS_REGION ?? "eu-west-1";
const outputs = stackOutputs(stackName, region);
const api = outputs.dataApiUrl;
const table = outputs.registryTableName;

// two apps: the bully and the victim
const ddb = new DynamoDBClient({ region });
for (const appId of ["bully", "victim"]) {
  await ddb.send(
    new PutItemCommand({
      TableName: table,
      Item: {
        app_id: { S: appId },
        appId: { S: appId },
        name: { S: appId },
        status: { S: "active" },
      },
    }),
  );
}

const q = (appId, sql) => signedCall(api, "/query", { app_id: appId, sql }, region);
await q("victim", "CREATE TABLE IF NOT EXISTS pings (t TEXT)");

// baseline victim latency
const baseline = [];
for (let i = 0; i < 10; i++) {
  const t0 = Date.now();
  const res = await q("victim", "SELECT COUNT(*) FROM pings");
  if (res.status !== 200) throw new Error(`victim baseline failed: ${JSON.stringify(res)}`);
  baseline.push(Date.now() - t0);
}
const p95 = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length * 0.95) - 1] ?? arr[arr.length - 1];
console.log(`victim baseline p95: ${p95(baseline)}ms`);

// unleash the bully: 40 concurrent CPU bombs (cap is 16 → expect 429s + 408s)
const BOMB = "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r) SELECT MAX(x) FROM r";
console.log("flooding bully with 40 concurrent recursive-CTE bombs ...");
const bullyResults = Promise.all(Array.from({ length: 40 }, () => q("bully", BOMB)));

// measure victim latency DURING the flood
await new Promise((r) => setTimeout(r, 1000));
const during = [];
for (let i = 0; i < 20; i++) {
  const t0 = Date.now();
  const res = await q("victim", "SELECT COUNT(*) FROM pings");
  if (res.status !== 200) throw new Error(`victim degraded to error during flood: ${JSON.stringify(res)}`);
  during.push(Date.now() - t0);
}
const victimP95 = p95(during);
console.log(`victim p95 during flood: ${victimP95}ms`);

const bully = await bullyResults;
const statuses = bully.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
console.log(`bully outcomes by status: ${JSON.stringify(statuses)}`);

if (!statuses[429]) throw new Error("expected some 429s for the flooding app");
if (statuses[200]) throw new Error("CPU bombs should not succeed");
const degradation = victimP95 / Math.max(p95(baseline), 1);
console.log(`victim degradation factor: ${degradation.toFixed(2)}x`);
if (degradation > 5) throw new Error("victim degraded more than 5x during the flood");
console.log("noisy-neighbor acceptance PASSED");
