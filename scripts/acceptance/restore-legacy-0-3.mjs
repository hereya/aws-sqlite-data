// Migration acceptance (0.3.x → 0.5.x): prove that a GENUINE 0.3-format
// replica sitting in the stack's bucket is auto-detected and restored by the
// deployed 0.5 service (litestream ≥ 0.5.8 restores legacy-format backups —
// the load-bearing path for quiet apps whose replicas stay 0.3-format long
// after the rollout).
//
// How: seeds a deterministic SQLite db locally, produces a real 0.3 replica
// ON THE STACK'S OWN INSTANCE with litestream v0.3.14 linux-arm64 (the asset
// sha256-pinned in scripts/pins.json through package v0.1.2 — see git history),
// publishes it under <appId>/app.db in the stack bucket, registers the app,
// then queries through the signed API and asserts the seeded aggregates.
// Backported from upstream dilaya/aws-sqlite-data 0.1.4 (db1e3c6), without the
// org dimension. No-AWS variant: restore-legacy-0-3-local.mjs.
//
//   .toolchain/node/bin/node scripts/acceptance/restore-legacy-0-3.mjs <stackName> [appId]
//
// Needs the toolchain node (node:sqlite), like `npm test`.
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { signedCall } from "./signed-call.mjs";
import { asgInstanceId, aws, awsJson, stackOutputs, waitFor } from "./stack-info.mjs";

const [, , stackName, appId = "app-legacy"] = process.argv;
if (!stackName) {
  console.error("usage: restore-legacy-0-3.mjs <stackName> [appId]");
  process.exit(2);
}
const region = process.env.AWS_REGION ?? "eu-west-1";

// The exact asset the package shipped on the 0.3 line, pinned by the sha256
// committed in scripts/pins.json through package v0.1.2.
const LS03_ASSET = "litestream-v0.3.14-linux-arm64.tar.gz";
const LS03_SHA256 = "4d375a66653e4a9b27a5b38ce9cb73681c39893ba0485f81ab860d4cd427e642";
const LS03_URL = `https://github.com/benbjohnson/litestream/releases/download/v0.3.14/${LS03_ASSET}`;

const outputs = stackOutputs(stackName, region);
const bucket = outputs.sqliteReplicaBucketName;
const dataApiUrl = outputs.dataApiUrl;
const registryTable = outputs.registryTableName;
if (!bucket || !dataApiUrl || !registryTable) throw new Error(`stack ${stackName}: missing outputs`);
const { instanceId } = asgInstanceId(stackName, region);
if (!instanceId) throw new Error("no in-service instance");

// 1. deterministic seed db (WAL like the service creates, checkpointed so the
// single file is self-contained)
const dir = mkdtempSync(join(tmpdir(), "ls03-seed-"));
const seedPath = join(dir, "app.db");
const db = new DatabaseSync(seedPath);
db.exec("PRAGMA journal_mode=WAL");
db.exec("CREATE TABLE legacy_data(id INTEGER PRIMARY KEY, val TEXT NOT NULL)");
const ins = db.prepare("INSERT INTO legacy_data(id,val) VALUES(?,?)");
for (let i = 1; i <= 500; i++) ins.run(i, `legacy-row-${i}-` + "x".repeat(i % 37));
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const expected = db.prepare("SELECT COUNT(*) c, SUM(length(val)) s, SUM(id) i FROM legacy_data").get();
db.close();
console.log(`seed db ready — expected aggregates ${JSON.stringify(expected)}`);

// 2. the pinned 0.3 asset: reuse the toolchain artifact cache, else fetch;
// always verify against the committed pin before it goes anywhere.
const cacheDir = fileURLToPath(new URL("../../.toolchain/artifact-cache", import.meta.url));
const assetPath = join(cacheDir, LS03_ASSET);
if (!existsSync(assetPath)) {
  console.log(`fetching ${LS03_URL} ...`);
  mkdirSync(dirname(assetPath), { recursive: true });
  const res = await fetch(LS03_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(assetPath, Buffer.from(await res.arrayBuffer()));
}
const gotSha = createHash("sha256").update(readFileSync(assetPath)).digest("hex");
if (gotSha !== LS03_SHA256) throw new Error(`litestream 0.3.14 sha256 mismatch: ${gotSha}`);
console.log("litestream 0.3.14 asset verified against the committed pin");

// 3. stage both in the stack's own bucket for the instance to pick up
aws(["s3", "cp", assetPath, `s3://${bucket}/_tooling/${LS03_ASSET}`, "--quiet", "--region", region]);
aws(["s3", "cp", seedPath, `s3://${bucket}/_tooling/seed-app.db`, "--quiet", "--region", region]);

// 4. produce the genuine 0.3 replica on the instance (same SSM channel the
// other chaos scripts use) and publish it at the app's replica path. A file://
// replica has the exact same layout a 0.3 s3 replica would have at that URL.
console.log(`replicating with litestream 0.3.14 on ${instanceId} via SSM ...`);
const cmd = awsJson([
  "ssm", "send-command",
  "--instance-ids", instanceId,
  "--document-name", "AWS-RunShellScript",
  "--parameters", JSON.stringify({
    commands: [
      "set -e",
      "rm -rf /tmp/ls03test && mkdir -p /tmp/ls03test && cd /tmp/ls03test",
      `aws s3 cp s3://${bucket}/_tooling/${LS03_ASSET} . --quiet`,
      `echo "${LS03_SHA256}  ${LS03_ASSET}" | sha256sum -c`,
      `tar xzf ${LS03_ASSET}`,
      "./litestream version",
      `aws s3 cp s3://${bucket}/_tooling/seed-app.db /tmp/ls03test/app.db --quiet`,
      "printf 'dbs:\\n  - path: /tmp/ls03test/app.db\\n    replicas:\\n      - url: file:///tmp/ls03test/replica\\n        sync-interval: 1s\\n' > ls03.yml",
      "timeout --signal=TERM 12 ./litestream replicate -config ls03.yml || true",
      "test -d replica/generations",
      `aws s3 cp --recursive /tmp/ls03test/replica s3://${bucket}/${appId}/app.db --quiet`,
      `aws s3 ls s3://${bucket}/${appId}/app.db/ --recursive | head -5`,
      "rm -rf /tmp/ls03test",
    ],
  }),
  "--region", region,
]);
const commandId = cmd.Command.CommandId;
const inv = await waitFor("SSM command done", () => {
  const r = awsJson([
    "ssm", "get-command-invocation",
    "--command-id", commandId,
    "--instance-id", instanceId,
    "--region", region,
  ]);
  return r.Status === "Success" || r.Status === "Failed" ? r : false;
}, { timeoutMs: 180_000, intervalMs: 5000 }).then(() =>
  awsJson([
    "ssm", "get-command-invocation",
    "--command-id", commandId,
    "--instance-id", instanceId,
    "--region", region,
  ]),
);
console.log("--- remote output ---\n" + inv.StandardOutputContent.trim() + "\n---------------------");
if (inv.Status !== "Success") {
  console.error("replica seeding failed", inv.StandardErrorContent);
  process.exit(1);
}

// 5. register the app (idempotent, same shape as canary.mjs) — AFTER the
// replica exists, so the service's first touch takes the restore path.
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

// 6. first signed query = ensureServed → restore-if-missing → the 0.5 service
// must auto-detect the 0.3-format replica and restore it.
const res = await signedCall(
  dataApiUrl,
  "/query",
  { app_id: appId, sql: "SELECT COUNT(*) c, SUM(length(val)) s, SUM(id) i FROM legacy_data" },
  region,
);
if (res.status !== 200) {
  console.error("restore query failed", res);
  process.exit(1);
}
const [c, s, i] = res.body.records[0].map((f) => f.longValue);
const pass = c === expected.c && s === expected.s && i === expected.i;
console.log(`restored aggregates: c=${c} s=${s} i=${i} (expected c=${expected.c} s=${expected.s} i=${expected.i})`);
if (!pass) {
  console.error("MISMATCH — restored data does not match the seeded 0.3 replica");
  process.exit(1);
}
console.log("legacy 0.3-format replica restored by the 0.5 service — PASS");
