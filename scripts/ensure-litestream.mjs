// Downloads the pinned Litestream binary to .toolchain/litestream for local
// dev/tests (file:// replicas). The production artifact bundles the linux-arm64
// build with an explicit sha256 at deploy time (scripts/build-service.mjs).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolchainDir = join(root, ".toolchain");
const binPath = join(toolchainDir, "litestream");
const stampFile = join(toolchainDir, "litestream.version");

const VERSION = readFileSync(join(root, "scripts", "litestream-version.txt"), "utf8").trim();

const platform = process.platform === "darwin" ? "darwin" : "linux";
// Release asset naming changed between the 0.3.x and 0.5.x lines:
//   0.3.x: litestream-v0.3.14-darwin-arm64.zip  (v-prefixed; zip on darwin; amd64)
//   0.5.x: litestream-0.5.17-darwin-arm64.tar.gz (bare version; tar.gz everywhere; x86_64)
const major05 = /^v0\.[5-9]|^v[1-9]/.test(VERSION);
const archName = process.arch === "arm64" ? "arm64" : major05 ? "x86_64" : "amd64";
const ext = platform === "darwin" && !major05 ? "zip" : "tar.gz";
const assetVersion = major05 ? VERSION.replace(/^v/, "") : VERSION;
const asset = `litestream-${assetVersion}-${platform}-${archName}.${ext}`;
const url = `https://github.com/benbjohnson/litestream/releases/download/${VERSION}/${asset}`;

function ok() {
  return existsSync(binPath) && existsSync(stampFile) && readFileSync(stampFile, "utf8").trim() === `${VERSION}-${platform}-${archName}`;
}

async function main() {
  if (ok()) return;
  mkdirSync(toolchainDir, { recursive: true });
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const archivePath = join(toolchainDir, asset);
  writeFileSync(archivePath, buf);
  const extractDir = join(toolchainDir, "litestream-extract");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  if (ext === "zip") {
    execFileSync("unzip", ["-o", "-q", archivePath, "-d", extractDir]);
  } else {
    execFileSync("tar", ["-xzf", archivePath, "-C", extractDir]);
  }
  rmSync(binPath, { force: true });
  execFileSync("mv", [join(extractDir, "litestream"), binPath]);
  chmodSync(binPath, 0o755);
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(archivePath, { force: true });
  writeFileSync(stampFile, `${VERSION}-${platform}-${archName}`);
  console.log(`litestream ${VERSION} ready at ${binPath}`);
}

await main();
