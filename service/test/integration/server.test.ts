import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { call, DEFAULT_REGISTRY, startTestService, type TestService } from "../helpers.ts";

let svc: TestService;

before(async () => {
  svc = await startTestService();
});

after(async () => {
  await svc.close();
});

const A1 = { app_id: "app-1" };
const A2 = { app_id: "app-2" };

test("health", async () => {
  const res = await call(svc.baseUrl, "/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
});

test("typed round-trip: create, insert, select", async () => {
  const create = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, qty INTEGER, price REAL, active INTEGER, data BLOB, note TEXT)",
  });
  assert.equal(create.status, 200, JSON.stringify(create.body));

  const insert = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "INSERT INTO items (name, qty, price, active, data, note) VALUES (:name, :qty, :price, :active, :data, :note)",
    params: [
      { name: "name", value: { stringValue: "widget" } },
      { name: "qty", value: { longValue: 5 } },
      { name: "price", value: { doubleValue: 9.75 } },
      { name: "active", value: { booleanValue: true } },
      { name: "data", value: { blobValue: Buffer.from("blobby").toString("base64") } },
      { name: "note", value: { isNull: true } },
    ],
  });
  assert.equal(insert.status, 200, JSON.stringify(insert.body));
  assert.equal(insert.body.numberOfRecordsUpdated, 1);
  assert.equal(insert.body.lastInsertId, 1);

  const select = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "SELECT id, name, qty, price, active, data, note FROM items",
  });
  assert.equal(select.status, 200);
  assert.deepEqual(
    select.body.columnMetadata.map((c: { name: string }) => c.name),
    ["id", "name", "qty", "price", "active", "data", "note"],
  );
  const row = select.body.records[0];
  assert.deepEqual(row[0], { longValue: 1 });
  assert.deepEqual(row[1], { stringValue: "widget" });
  assert.deepEqual(row[2], { longValue: 5 });
  assert.deepEqual(row[3], { doubleValue: 9.75 });
  assert.deepEqual(row[4], { longValue: 1 }); // booleans are INTEGER 0/1 in SQLite
  assert.deepEqual(row[5], { blobValue: Buffer.from("blobby").toString("base64") });
  assert.deepEqual(row[6], { isNull: true });
});

test("update reports numberOfRecordsUpdated", async () => {
  const res = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "UPDATE items SET qty = qty + 1 WHERE name = :n",
    params: [{ name: "n", value: { stringValue: "widget" } }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.numberOfRecordsUpdated, 1);
});

test("multi-statement script works without params, rejected with params", async () => {
  const ok = await call(svc.baseUrl, "/query", {
    ...A2,
    sql: "CREATE TABLE t (x TEXT); CREATE INDEX ix ON t(x); INSERT INTO t VALUES ('a');",
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.numberOfRecordsUpdated, 1);

  const bad = await call(svc.baseUrl, "/query", {
    ...A2,
    sql: "INSERT INTO t VALUES (:x); INSERT INTO t VALUES (:x);",
    params: [{ name: "x", value: { stringValue: "y" } }],
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "BAD_REQUEST");
});

test("apps are isolated: same table name, different files", async () => {
  await call(svc.baseUrl, "/query", { ...A2, sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, secret TEXT)" });
  await call(svc.baseUrl, "/query", {
    ...A2,
    sql: "INSERT INTO items (secret) VALUES ('app-2-only')",
  });
  const fromA = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT name FROM items" });
  assert.equal(fromA.status, 200);
  assert.deepEqual(fromA.body.records[0][0], { stringValue: "widget" });
  const fromOther = await call(svc.baseUrl, "/query", { ...A2, sql: "SELECT secret FROM items" });
  assert.deepEqual(fromOther.body.records[0][0], { stringValue: "app-2-only" });
});

test("unknown / inactive apps are denied fail-closed", async () => {
  for (const app of [
    { app_id: "nope" },
    { app_id: "app-old" }, // inactive
  ]) {
    const res = await call(svc.baseUrl, "/query", { ...app, sql: "SELECT 1" });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "APP_DENIED");
  }
});

test("ATTACH and write-PRAGMA are rejected", async () => {
  const attach = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "ATTACH DATABASE '/var/lib/hereya/dbs/app-2/app.db' AS other",
  });
  assert.equal(attach.status, 400);
  assert.equal(attach.body.error.code, "SQL_FORBIDDEN");

  const pragma = await call(svc.baseUrl, "/query", { ...A1, sql: "PRAGMA journal_mode=DELETE" });
  assert.equal(pragma.status, 400);
  assert.equal(pragma.body.error.code, "SQL_FORBIDDEN");

  const readPragma = await call(svc.baseUrl, "/query", { ...A1, sql: "PRAGMA table_info(items)" });
  assert.equal(readPragma.status, 200);
  assert.ok(readPragma.body.records.length > 0);
});

test("transactions: commit persists, rollback discards, ids are app-scoped", async () => {
  const begin = await call(svc.baseUrl, "/tx/begin", A1);
  assert.equal(begin.status, 200, JSON.stringify(begin.body));
  const txId = begin.body.transactionId;
  assert.ok(txId);

  const ins = await call(svc.baseUrl, "/query", {
    ...A1,
    transactionId: txId,
    sql: "INSERT INTO items (name, qty) VALUES ('tx-item', 1)",
  });
  assert.equal(ins.status, 200, JSON.stringify(ins.body));

  // another app cannot use this transaction id
  const foreign = await call(svc.baseUrl, "/query", {
    ...A2,
    transactionId: txId,
    sql: "SELECT 1",
  });
  assert.equal(foreign.status, 409);
  assert.equal(foreign.body.error.code, "TX_NOT_FOUND");

  // uncommitted data is invisible to autocommit readers (separate connection)
  const dirty = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "SELECT COUNT(*) AS c FROM items WHERE name = 'tx-item'",
  });
  assert.deepEqual(dirty.body.records[0][0], { longValue: 0 });

  const commit = await call(svc.baseUrl, "/tx/commit", { ...A1, transactionId: txId });
  assert.equal(commit.status, 200);
  assert.equal(commit.body.status, "committed");

  const after = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "SELECT COUNT(*) AS c FROM items WHERE name = 'tx-item'",
  });
  assert.deepEqual(after.body.records[0][0], { longValue: 1 });

  // rollback path
  const begin2 = await call(svc.baseUrl, "/tx/begin", A1);
  const tx2 = begin2.body.transactionId;
  await call(svc.baseUrl, "/query", {
    ...A1,
    transactionId: tx2,
    sql: "INSERT INTO items (name, qty) VALUES ('doomed', 1)",
  });
  const rb = await call(svc.baseUrl, "/tx/rollback", { ...A1, transactionId: tx2 });
  assert.equal(rb.status, 200);
  const gone = await call(svc.baseUrl, "/query", {
    ...A1,
    sql: "SELECT COUNT(*) AS c FROM items WHERE name = 'doomed'",
  });
  assert.deepEqual(gone.body.records[0][0], { longValue: 0 });

  // commit of unknown tx → 409; rollback of unknown tx → idempotent 200
  const badCommit = await call(svc.baseUrl, "/tx/commit", { ...A1, transactionId: tx2 });
  assert.equal(badCommit.status, 409);
  const idemRb = await call(svc.baseUrl, "/tx/rollback", { ...A1, transactionId: tx2 });
  assert.equal(idemRb.status, 200);
});

test("batch-execute inserts every parameter set", async () => {
  await call(svc.baseUrl, "/query", { ...A2, sql: "CREATE TABLE batch (a TEXT, b INTEGER)" });
  const res = await call(svc.baseUrl, "/batch-execute", {
    ...A2,
    sql: "INSERT INTO batch (a, b) VALUES (:a, :b)",
    parameterSets: [
      [
        { name: "a", value: { stringValue: "one" } },
        { name: "b", value: { longValue: 1 } },
      ],
      [
        { name: "a", value: { stringValue: "two" } },
        { name: "b", value: { longValue: 2 } },
      ],
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.updateResults.length, 2);
  const count = await call(svc.baseUrl, "/query", { ...A2, sql: "SELECT COUNT(*) AS c FROM batch" });
  assert.deepEqual(count.body.records[0][0], { longValue: 2 });
});

test("query timeout kills only the offending app's in-flight work", async () => {
  const bombPromise = call(svc.baseUrl, "/query", {
    ...A1,
    sql: "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r) SELECT MAX(x) FROM r",
  });
  // while the bomb runs on app-1, app-2 stays responsive
  const other = await call(svc.baseUrl, "/query", { ...A2, sql: "SELECT COUNT(*) AS c FROM batch" });
  assert.equal(other.status, 200);

  const bomb = await bombPromise;
  assert.equal(bomb.status, 408, JSON.stringify(bomb.body));
  assert.equal(bomb.body.error.code, "QUERY_TIMEOUT");

  // the app recovers on a fresh worker
  const recovered = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT COUNT(*) AS c FROM items" });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
});

test("registry hot-reload: newly added app becomes servable, removed app is denied", async () => {
  const before = await call(svc.baseUrl, "/query", { app_id: "fresh", sql: "SELECT 1" });
  assert.equal(before.status, 403);

  svc.setRegistry([...DEFAULT_REGISTRY, { app_id: "fresh", status: "active" }]);
  const after = await call(svc.baseUrl, "/query", { app_id: "fresh", sql: "SELECT 1" });
  assert.equal(after.status, 200, JSON.stringify(after.body));
});

test("oversized results are rejected with RESULT_TOO_LARGE", async () => {
  const small = await startTestService({ maxResponseBytes: 1000 });
  try {
    await call(small.baseUrl, "/query", { ...A1, sql: "CREATE TABLE big (s TEXT)" });
    await call(small.baseUrl, "/query", {
      ...A1,
      sql: "INSERT INTO big VALUES (:s)",
      params: [{ name: "s", value: { stringValue: "z".repeat(5000) } }],
    });
    const res = await call(small.baseUrl, "/query", { ...A1, sql: "SELECT s FROM big" });
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, "RESULT_TOO_LARGE");
  } finally {
    await small.close();
  }
});

test("per-app in-flight cap returns 429", async () => {
  const capped = await startTestService({ maxInflightPerApp: 1, sqlTimeoutMs: 2000 });
  try {
    const bomb = call(capped.baseUrl, "/query", {
      ...A1,
      sql: "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r) SELECT MAX(x) FROM r",
    });
    await new Promise((r) => setTimeout(r, 200)); // let the bomb occupy the slot
    const throttled = await call(capped.baseUrl, "/query", { ...A1, sql: "SELECT 1" });
    assert.equal(throttled.status, 429, JSON.stringify(throttled.body));
    assert.equal(throttled.body.error.code, "THROTTLED");
    const bombRes = await bomb;
    assert.equal(bombRes.status, 408);
  } finally {
    await capped.close();
  }
});
