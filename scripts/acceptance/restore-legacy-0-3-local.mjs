// Migration acceptance (0.3.x → 0.5.x), laptop edition: no AWS, file://
// replicas. Proves that a GENUINE 0.3-format replica (written by a real 0.3
// litestream binary) is auto-detected and restored by the 0.5 service at boot
// (litestream ≥ 0.5.8 restores legacy-format backups — the load-bearing path
// for quiet apps whose replicas stay 0.3-format long after the rollout).
//
// How: seeds a deterministic SQLite db, replicates it with a legacy 0.3 binary
// to a file:// replica at <replicaBase>/<appId>/app.db (the exact layout an s3
// replica has at that URL), then boots the service in-process with the pinned
// 0.5 binary (.toolchain/litestream, `npm run ensure-litestream`), an empty
// local disk and a registry naming the app — boot's restore-before-serve step
// must take the restore path — and asserts the aggregates through /query.
//
// The legacy binary: linux-arm64 uses the exact v0.3.14 asset the package
// shipped (sha256 pinned in scripts/pins.json through v0.1.2). v0.3.14 has no
// darwin build, so darwin-arm64 uses v0.3.13, the last 0.3 darwin release
// (same replica format; 0.3.14 only fixed a restore panic), pinned below.
//
//   .toolchain/node/bin/node scripts/acceptance/restore-legacy-0-3-local.mjs
//
// Needs the toolchain node (node:sqlite + .ts imports), like `npm test`.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../service/src/config.ts";
import { bootService } from "../../service/src/boot.ts";

const appId = process.argv[2] ?? "app-legacy";
const root = fileURLToPath(new URL("../..", import.meta.url));
const ls05 = join(root, ".toolchain", "litestream");
if (!existsSync(ls05)) throw new Error("run `npm run ensure-litestream` first (pinned 0.5 binary)");

const LEGACY = {
  "linux-arm64": {
    version: "v0.3.14",
    asset: "litestream-v0.3.14-linux-arm64.tar.gz",
    sha256: "4d375a66653e4a9b27a5b38ce9cb73681c39893ba0485f81ab860d4cd427e642",
  },
  "darwin-arm64": {
    version: "v0.3.13",
    asset: "litestream-v0.3.13-darwin-arm64.zip",
    sha256: "6d1689487432613f5c10aee75ee77c95250dcce4da49695bf0a448c794eb7daa",
  },
};
const legacy = LEGACY[`${process.platform}-${process.arch}`];
if (!legacy) throw new Error(`no pinned legacy 0.3 binary for ${process.platform}-${process.arch}`);

const work = mkdtempSync(join(tmpdir(), "ls03-local-"));

// 1. the pinned legacy asset, cached next to the build artifacts, verified
const cacheDir = join(root, ".toolchain", "artifact-cache");
const assetPath = join(cacheDir, legacy.asset);
if (!existsSync(assetPath)) {
  const url = `https://github.com/benbjohnson/litestream/releases/download/${legacy.version}/${legacy.asset}`;
  console.log(`fetching ${url} ...`);
  mkdirSync(dirname(assetPath), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(assetPath, Buffer.from(await res.arrayBuffer()));
}
const gotSha = createHash("sha256").update(readFileSync(assetPath)).digest("hex");
if (gotSha !== legacy.sha256) throw new Error(`${legacy.asset} sha256 mismatch: ${gotSha}`);
const binDir = join(work, "ls03");
mkdirSync(binDir);
if (legacy.asset.endsWith(".zip")) execFileSync("unzip", ["-o", "-q", assetPath, "-d", binDir]);
else execFileSync("tar", ["-xzf", assetPath, "-C", binDir]);
const ls03 = join(binDir, "litestream");
console.log(`legacy binary: ${execFileSync(ls03, ["version"], { encoding: "utf8" }).trim()} (sha256 verified)`);
console.log(`service binary: ${execFileSync(ls05, ["version"], { encoding: "utf8" }).trim()}`);

// 2. deterministic seed db (WAL like the service creates)
const seedDir = join(work, "seed");
mkdirSync(seedDir);
const seedPath = join(seedDir, "app.db");
const db = new DatabaseSync(seedPath);
db.exec("PRAGMA journal_mode=WAL");
db.exec("CREATE TABLE legacy_data(id INTEGER PRIMARY KEY, val TEXT NOT NULL)");
const ins = db.prepare("INSERT INTO legacy_data(id,val) VALUES(?,?)");
for (let i = 1; i <= 500; i++) ins.run(i, `legacy-row-${i}-` + "x".repeat(i % 37));
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const expected = db.prepare("SELECT COUNT(*) c, SUM(length(val)) s, SUM(id) i FROM legacy_data").get();
db.close();
console.log(`seed db ready — expected aggregates ${JSON.stringify(expected)}`);

// 3. a genuine 0.3 replica at the app's replica path
const replicaBase = join(work, "replicas");
const replicaPath = join(replicaBase, appId, "app.db");
const ls03Cfg = join(work, "ls03.yml");
writeFileSync(
  ls03Cfg,
  `dbs:\n  - path: ${seedPath}\n    replicas:\n      - url: file://${replicaPath}\n        sync-interval: 1s\n`,
);
const child = spawn(ls03, ["replicate", "-config", ls03Cfg], { stdio: ["ignore", "ignore", "inherit"] });
await new Promise((r) => setTimeout(r, 6000));
child.kill("SIGTERM");
await new Promise((r) => child.once("exit", r));
if (!existsSync(join(replicaPath, "generations"))) throw new Error("0.3 replica was not written");
const generations = readdirSync(join(replicaPath, "generations"));
console.log(`0.3-format replica written: ${replicaPath}/generations/{${generations.join(",")}}`);

// 4. boot the service on the 0.5 binary: empty disk + registry naming the app
const registryFile = join(work, "registry.json");
writeFileSync(registryFile, JSON.stringify([{ app_id: appId, status: "active" }]));
const cfg = loadConfig({
  PORT: "0",
  DB_DIR: join(work, "dbs"),
  REGISTRY_MODE: "file",
  REGISTRY_FILE: registryFile,
  LITESTREAM_BIN: ls05,
  LITESTREAM_CONFIG_PATH: join(work, "litestream.yml"),
  REPLICA_BASE_URL: `file://${replicaBase}`,
  REGISTRY_POLL_SECONDS: "3600",
});
const svc = await bootService(cfg, { installSignalHandlers: false });
let pass = false;
try {
  const res = await fetch(`http://127.0.0.1:${svc.port}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, sql: "SELECT COUNT(*) c, SUM(length(val)) s, SUM(id) i FROM legacy_data" }),
  });
  const body = await res.json();
  if (res.status !== 200) throw new Error(`restore query failed: ${res.status} ${JSON.stringify(body)}`);
  const [c, s, i] = body.records[0].map((f) => f.longValue);
  console.log(`restored aggregates: c=${c} s=${s} i=${i} (expected c=${expected.c} s=${expected.s} i=${expected.i})`);
  pass = c === expected.c && s === expected.s && i === expected.i;
} finally {
  await svc.stop();
  rmSync(work, { recursive: true, force: true });
}
if (!pass) {
  console.error("MISMATCH — restored data does not match the seeded 0.3 replica");
  process.exit(1);
}
console.log("legacy 0.3-format replica restored by the 0.5 service — PASS");
