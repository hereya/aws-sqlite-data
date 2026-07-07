// Acceptance canary (spec §13: "a Lambda-style caller can query via the API"):
// seeds a registry row, then writes + reads a canary value through the signed
// API. Usage:
//   node scripts/acceptance/canary.mjs <dataApiUrl> <registryTable> [appId]
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { signedCall } from "./signed-call.mjs";

const [, , dataApiUrl, registryTable, appId = "canary-app"] = process.argv;
if (!dataApiUrl || !registryTable) {
  console.error("usage: canary.mjs <dataApiUrl> <registryTable> [appId]");
  process.exit(2);
}
const region = process.env.AWS_REGION ?? "eu-west-1";

// 1. make sure the canary app exists in the registry (idempotent)
const ddb = new DynamoDBClient({ region });
await ddb.send(
  new PutItemCommand({
    TableName: registryTable,
    Item: {
      app_id: { S: appId },
      appId: { S: appId },
      name: { S: appId },
      status: { S: "active" },
      created_at: { S: new Date().toISOString() },
    },
  }),
);
console.log(`registry row ensured: ${appId}`);

const q = (sql, params) => signedCall(dataApiUrl, "/query", { app_id: appId, sql, params }, region);

// 2. hot-add + round trip
const stamp = new Date().toISOString();
let res = await q("CREATE TABLE IF NOT EXISTS canary (ts TEXT PRIMARY KEY, note TEXT)");
if (res.status !== 200) {
  console.error("CREATE failed", res);
  process.exit(1);
}
res = await q("INSERT INTO canary (ts, note) VALUES (:ts, :note)", [
  { name: "ts", value: { stringValue: stamp } },
  { name: "note", value: { stringValue: "canary write" } },
]);
if (res.status !== 200) {
  console.error("INSERT failed", res);
  process.exit(1);
}
res = await q("SELECT COUNT(*) AS total FROM canary");
if (res.status !== 200) {
  console.error("SELECT failed", res);
  process.exit(1);
}
const total = res.body.records[0][0].longValue;
console.log(`canary OK — ${total} row(s), latest ${stamp}`);

// 3. negative check: an unregistered app must be denied by the VM (defense in depth)
const forged = await signedCall(
  dataApiUrl,
  "/query",
  { app_id: "app-that-does-not-exist", sql: "SELECT 1" },
  region,
);
if (forged.status !== 403) {
  console.error("SECURITY: unregistered app was NOT denied", forged);
  process.exit(1);
}
console.log("unregistered app correctly denied (403)");
