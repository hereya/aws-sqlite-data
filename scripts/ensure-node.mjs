// Ensures a local Node 24 toolchain at .toolchain/node for running the service
// and its tests (node:sqlite with StatementSync.columns() needs Node >= 23.11;
// the VM artifact ships the same major). Downloads the official tarball once.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolchainDir = join(root, ".toolchain");
const nodeDir = join(toolchainDir, "node");
const stampFile = join(toolchainDir, "node.version");

const PINNED = readFileSync(join(root, "scripts", "node-version.txt"), "utf8").trim();

const platform = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";

function nodeOk() {
  if (!existsSync(join(nodeDir, "bin", "node"))) return false;
  if (!existsSync(stampFile)) return false;
  return readFileSync(stampFile, "utf8").trim() === `${PINNED}-${platform}-${arch}`;
}

async function resolveVersion() {
  // Prefer the pin; if its tarball 404s (e.g. pruned from dist), fall back to latest v24.
  const pinnedUrl = tarballUrl(PINNED);
  const head = await fetch(pinnedUrl, { method: "HEAD" });
  if (head.ok) return PINNED;
  const index = await (await fetch("https://nodejs.org/dist/index.json")).json();
  const latest = index.find((e) => e.version.startsWith("v24."));
  if (!latest) throw new Error("no v24 release found in nodejs.org dist index");
  console.warn(`pinned node ${PINNED} unavailable; using ${latest.version} — update scripts/node-version.txt`);
  return latest.version;
}

function tarballUrl(version) {
  return `https://nodejs.org/dist/${version}/node-${version}-${platform}-${arch}.tar.gz`;
}

async function main() {
  if (nodeOk()) return;
  mkdirSync(toolchainDir, { recursive: true });
  const version = await resolveVersion();
  const url = tarballUrl(version);
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const shaText = await (await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
  const expected = shaText
    .split("\n")
    .find((l) => l.endsWith(`node-${version}-${platform}-${arch}.tar.gz`))
    ?.split(/\s+/)[0];
  const actual = createHash("sha256").update(buf).digest("hex");
  if (!expected || expected !== actual) throw new Error(`sha256 mismatch for ${url}`);

  const tarPath = join(toolchainDir, "node.tar.gz");
  writeFileSync(tarPath, buf);
  const extractDir = join(toolchainDir, "extract");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarPath, "-C", extractDir]);
  rmSync(nodeDir, { recursive: true, force: true });
  renameSync(join(extractDir, `node-${version}-${platform}-${arch}`), nodeDir);
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(tarPath, { force: true });
  writeFileSync(stampFile, `${version}-${platform}-${arch}`);
  console.log(`node ${version} ready at ${nodeDir}`);
}

await main();
