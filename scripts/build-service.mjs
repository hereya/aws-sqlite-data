// Builds the deployable service artifact (dist/service.tar.gz):
//   main.js + sql-worker.js  (esbuild ESM bundles, AWS SDK inlined)
//   package.json             ({"type":"module"} so .js loads as ESM on the VM)
//   bin/litestream           (pinned linux-arm64 build, sha256-verified)
//   node.tar.xz              (pinned Node linux-arm64 tarball, sha256-verified)
//   version.json
// All downloads happen at BUILD time and are checksum-verified — the instance
// boot path (the disaster-recovery path) has zero non-AWS network dependencies.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
const stageDir = join(distDir, "stage");
const cacheDir = join(root, ".toolchain", "artifact-cache");

const NODE_VERSION = readFileSync(join(root, "scripts", "node-version.txt"), "utf8").trim();
const LITESTREAM_VERSION = readFileSync(join(root, "scripts", "litestream-version.txt"), "utf8").trim();
const pinsPath = join(root, "scripts", "pins.json");
const pins = existsSync(pinsPath) ? JSON.parse(readFileSync(pinsPath, "utf8")) : {};

const NODE_ASSET = `node-${NODE_VERSION}-linux-arm64.tar.xz`;
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ASSET}`;
const LITESTREAM_ASSET = `litestream-${LITESTREAM_VERSION}-linux-arm64.tar.gz`;
const LITESTREAM_URL = `https://github.com/benbjohnson/litestream/releases/download/${LITESTREAM_VERSION}/${LITESTREAM_ASSET}`;

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function fetchCached(url, name, pinKey) {
  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, name);
  let buf;
  if (existsSync(cached)) {
    buf = readFileSync(cached);
  } else {
    console.log(`downloading ${url}`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
    buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(cached, buf);
  }
  const actual = sha256(buf);
  const expected = pins[pinKey];
  if (expected === undefined) {
    // first fetch: record the pin; commit scripts/pins.json to freeze it
    pins[pinKey] = actual;
    writeFileSync(pinsPath, JSON.stringify(pins, null, 2) + "\n");
    console.log(`pinned ${pinKey} = ${actual}`);
  } else if (expected !== actual) {
    rmSync(cached, { force: true });
    throw new Error(`sha256 mismatch for ${name}: expected ${expected}, got ${actual}`);
  }
  return buf;
}

async function main() {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(join(stageDir, "bin"), { recursive: true });

  // 1. bundle the service (two entries so the fork()ed executor sits beside main)
  await build({
    entryPoints: [join(root, "service/src/main.ts"), join(root, "service/src/sql-worker.ts")],
    outdir: stageDir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    minify: false,
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    logLevel: "warning",
  });
  writeFileSync(join(stageDir, "package.json"), JSON.stringify({ type: "module" }) + "\n");

  // 2. pinned runtime pieces
  const nodeTar = await fetchCached(NODE_URL, NODE_ASSET, `node:${NODE_VERSION}:linux-arm64`);
  writeFileSync(join(stageDir, "node.tar.xz"), nodeTar);

  const lsTar = await fetchCached(LITESTREAM_URL, LITESTREAM_ASSET, `litestream:${LITESTREAM_VERSION}:linux-arm64`);
  const lsExtract = join(distDir, "ls-extract");
  rmSync(lsExtract, { recursive: true, force: true });
  mkdirSync(lsExtract, { recursive: true });
  writeFileSync(join(lsExtract, LITESTREAM_ASSET), lsTar);
  execFileSync("tar", ["-xzf", join(lsExtract, LITESTREAM_ASSET), "-C", lsExtract]);
  execFileSync("cp", [join(lsExtract, "litestream"), join(stageDir, "bin", "litestream")]);
  rmSync(lsExtract, { recursive: true, force: true });

  writeFileSync(
    join(stageDir, "version.json"),
    JSON.stringify({ node: NODE_VERSION, litestream: LITESTREAM_VERSION, builtAt: new Date().toISOString() }, null, 2),
  );

  // 3. tar it up (tar is always present on AL2023; unzip is not)
  const artifact = join(distDir, "service.tar.gz");
  rmSync(artifact, { force: true });
  execFileSync("tar", ["-czf", artifact, "-C", stageDir, "."]);
  console.log(`built ${artifact}`);
}

await main();
