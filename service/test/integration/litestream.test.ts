// Full-boot tests against a REAL litestream binary with file:// replicas:
// the strict restore-then-serve order, hot-add via /admin/sync, and removal.
// These are the laptop version of the spec §13 kill-instance criteria.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../../src/config.ts";
import { bootService, type RunningService } from "../../src/boot.ts";
import { call } from "../helpers.ts";

const litestreamBin = fileURLToPath(new URL("../../../.toolchain/litestream", import.meta.url));
const haveLitestream = existsSync(litestreamBin);

interface Env {
  cfg: Config;
  dir: string;
  setRegistry: (entries: Array<{ app_id: string; status: string }>) => void;
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-data-ls-"));
  const registryFile = join(dir, "registry.json");
  const entries = [{ app_id: "app-1", status: "active" }];
  writeFileSync(registryFile, JSON.stringify(entries));
  const cfg = loadConfig({
    PORT: "0",
    DB_DIR: join(dir, "dbs"),
    REGISTRY_MODE: "file",
    REGISTRY_FILE: registryFile,
    LITESTREAM_BIN: litestreamBin,
    LITESTREAM_CONFIG_PATH: join(dir, "litestream.yml"),
    REPLICA_BASE_URL: `file://${join(dir, "replicas")}`,
    LITESTREAM_SYNC_INTERVAL_MS: "150",
    SQL_TIMEOUT_MS: "5000",
    REGISTRY_POLL_SECONDS: "3600",
  } as NodeJS.ProcessEnv);
  return {
    cfg,
    dir,
    setRegistry: (e) => writeFileSync(registryFile, JSON.stringify(e)),
  };
}

const A1 = { app_id: "app-1" };

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

test("restore-then-serve: data survives losing the local disk", { skip: !haveLitestream }, async () => {
  const env = makeEnv();

  // boot #1: fresh app, write data, let litestream replicate, stop cleanly
  let svc: RunningService = await bootService(env.cfg, { installSignalHandlers: false });
  let base = `http://127.0.0.1:${svc.port}`;
  await call(base, "/query", { ...A1, sql: "CREATE TABLE facts (k TEXT PRIMARY KEY, v TEXT)" });
  const ins = await call(base, "/query", {
    ...A1,
    sql: "INSERT INTO facts VALUES (:k, :v)",
    params: [
      { name: "k", value: { stringValue: "durable" } },
      { name: "v", value: { stringValue: "yes" } },
    ],
  });
  assert.equal(ins.status, 200, JSON.stringify(ins.body));
  // give litestream a few sync intervals to ship the WAL
  await new Promise((r) => setTimeout(r, 1200));
  await svc.stop();

  // simulate instance replacement: local disk gone, replica remains
  rmSync(join(env.dir, "dbs"), { recursive: true, force: true });
  assert.ok(existsSync(join(env.dir, "replicas")), "replica dir must exist");

  // boot #2: restore happens BEFORE the port binds; data must be back
  svc = await bootService(env.cfg, { installSignalHandlers: false });
  base = `http://127.0.0.1:${svc.port}`;
  const read = await call(base, "/query", { ...A1, sql: "SELECT v FROM facts WHERE k = 'durable'" });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.records[0][0], { stringValue: "yes" });
  await svc.stop();
});

test("hot-add via /admin/sync and hot-remove", { skip: !haveLitestream }, async () => {
  const env = makeEnv();
  const svc = await bootService(env.cfg, { installSignalHandlers: false });
  const base = `http://127.0.0.1:${svc.port}`;
  try {
    const N2 = { app_id: "app-new" };

    // unknown until the registry says so
    const denied = await call(base, "/query", { ...N2, sql: "SELECT 1" });
    assert.equal(denied.status, 403);

    env.setRegistry([
      { app_id: "app-1", status: "active" },
      { app_id: "app-new", status: "active" },
    ]);
    const sync = await call(base, "/admin/sync", {});
    assert.equal(sync.status, 200);
    assert.equal(sync.body.added, 1);

    const ok = await call(base, "/query", { ...N2, sql: "SELECT 1 AS one" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    // write something and confirm its replica appears
    await call(base, "/query", { ...N2, sql: "CREATE TABLE t (x TEXT)" });
    assert.ok(
      await waitFor(() => existsSync(join(env.dir, "replicas", "app-new"))),
      "new app replica dir",
    );

    // removal: registry drops the app → served set shrinks, local file deleted, replica retained
    env.setRegistry([{ app_id: "app-1", status: "active" }]);
    const sync2 = await call(base, "/admin/sync", {});
    assert.equal(sync2.body.removed, 1);
    const gone = await call(base, "/query", { ...N2, sql: "SELECT 1" });
    assert.equal(gone.status, 403);
    assert.ok(!existsSync(join(env.dir, "dbs", "app-new", "app.db")), "local db removed");
    assert.ok(existsSync(join(env.dir, "replicas", "app-new")), "replica retained");
  } finally {
    await svc.stop();
  }
});

test("stats and delete-app admin surface", { skip: !haveLitestream }, async () => {
  const env = makeEnv();
  const svc = await bootService(env.cfg, { installSignalHandlers: false });
  const base = `http://127.0.0.1:${svc.port}`;
  try {
    await call(base, "/query", { ...A1, sql: "CREATE TABLE big (s TEXT)" });
    await call(base, "/query", {
      ...A1,
      sql: "INSERT INTO big VALUES (:s)",
      params: [{ name: "s", value: { stringValue: "x".repeat(10_000) } }],
    });
    const stats = await call(base, "/stats?app_id=app-1");
    assert.equal(stats.status, 200, JSON.stringify(stats.body));
    assert.ok(stats.body.dbSizeBytes > 10_000, `dbSizeBytes=${stats.body.dbSizeBytes}`);

    // stats for an unknown pair is denied
    const deniedStats = await call(base, "/stats?app_id=ghost");
    assert.equal(deniedStats.status, 403);

    // let litestream ship the first snapshot before tearing the app down
    assert.ok(
      await waitFor(() => existsSync(join(env.dir, "replicas", "app-1"))),
      "replica created before delete",
    );

    // delete-app: local file gone, replica retained, executor closed
    const del = await call(base, "/admin/delete-app", A1);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.ok(!existsSync(join(env.dir, "dbs", "app-1", "app.db")), "local db removed");
    assert.ok(existsSync(join(env.dir, "replicas", "app-1")), "replica retained");
  } finally {
    await svc.stop();
  }
});

test("request-path hot-add restores from replica before first query", { skip: !haveLitestream }, async () => {
  const env = makeEnv();

  // seed a replica for an app the next boot doesn't serve yet
  let svc = await bootService(env.cfg, { installSignalHandlers: false });
  let base = `http://127.0.0.1:${svc.port}`;
  await call(base, "/query", { ...A1, sql: "CREATE TABLE seeded (v TEXT)" });
  await call(base, "/query", { ...A1, sql: "INSERT INTO seeded VALUES ('from-replica')" });
  await new Promise((r) => setTimeout(r, 1200));
  await svc.stop();
  rmSync(join(env.dir, "dbs"), { recursive: true, force: true });

  // boot with an EMPTY registry file, then flip the app active without /admin/sync:
  // the request-path cache-miss must restore from the replica, not create a blank db
  env.setRegistry([]);
  svc = await bootService(env.cfg, { installSignalHandlers: false });
  base = `http://127.0.0.1:${svc.port}`;
  try {
    env.setRegistry([{ app_id: "app-1", status: "active" }]);
    const read = await call(base, "/query", { ...A1, sql: "SELECT v FROM seeded" });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(read.body.records[0][0], { stringValue: "from-replica" });
  } finally {
    await svc.stop();
  }
});
