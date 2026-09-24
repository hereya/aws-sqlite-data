// The artifact hash decides when the PRODUCTION database VM is replaced (the
// update policy is terminate-before-launch, so a roll = ~1 min with no Data
// API). These tests pin the property that makes that acceptable: the hash
// tracks what the service IS, not how many times it was built.
//
// Regression guarded (upstream dilaya/aws-sqlite-data, backported in 0.1.1):
// until 2026-07-30 the asset hash was computed on the
// bundling output (`service.tar.gz`), which is not reproducible — `builtAt`
// plus tar/gzip mtimes made every build differ. The launch template therefore
// changed on every deploy of anything, and CloudFormation rolled the databases
// five times in forty hours without a single change to this service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serviceContentHash } from "../lib/service-hash.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A miniature repo with the same shape the hash walks. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "svc-hash-"));
  mkdirSync(join(dir, "service", "src"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "service", "src", "main.ts"), "export const x = 1;\n");
  writeFileSync(join(dir, "scripts", "build-service.mjs"), "// build\n");
  writeFileSync(join(dir, "scripts", "node-version.txt"), "v24.0.0\n");
  writeFileSync(join(dir, "scripts", "litestream-version.txt"), "v0.5.14\n");
  return dir;
}

test("the hash of the real service is stable across calls (no build in the loop)", () => {
  assert.equal(serviceContentHash(repoRoot), serviceContentHash(repoRoot));
});

test("editing a service source file changes the hash — a real change still rolls", () => {
  const dir = fixture();
  try {
    const before = serviceContentHash(dir);
    writeFileSync(join(dir, "service", "src", "main.ts"), "export const x = 2;\n");
    assert.notEqual(serviceContentHash(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bumping a pinned tool version changes the hash (litestream, node)", () => {
  // These live OUTSIDE service/, but they decide what runs on the box — a
  // litestream bump IS a different service and must replace the instance.
  for (const file of ["litestream-version.txt", "node-version.txt"]) {
    const dir = fixture();
    try {
      const before = serviceContentHash(dir);
      writeFileSync(join(dir, "scripts", file), "v9.9.9\n");
      assert.notEqual(serviceContentHash(dir), before, `${file} must affect the hash`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("changing the build script changes the hash", () => {
  const dir = fixture();
  try {
    const before = serviceContentHash(dir);
    writeFileSync(join(dir, "scripts", "build-service.mjs"), "// build, differently\n");
    assert.notEqual(serviceContentHash(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build leftovers never move the hash — this is the whole point", () => {
  const dir = fixture();
  try {
    const before = serviceContentHash(dir);
    // A rebuild drops dist/ and node_modules/ into the tree and rewrites the
    // timestamped version.json. None of it changes what the service DOES, so
    // none of it may take the production databases down.
    mkdirSync(join(dir, "service", "dist"), { recursive: true });
    writeFileSync(join(dir, "service", "dist", "bundle.js"), `// built at ${new Date(0).toISOString()}\n`);
    mkdirSync(join(dir, "service", "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(dir, "service", "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    assert.equal(serviceContentHash(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renaming a file changes the hash even when the bytes are identical", () => {
  const dir = fixture();
  try {
    const before = serviceContentHash(dir);
    cpSync(join(dir, "service", "src", "main.ts"), join(dir, "service", "src", "renamed.ts"));
    rmSync(join(dir, "service", "src", "main.ts"));
    assert.notEqual(serviceContentHash(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an absent optional input is a stable value, not a crash", () => {
  // scripts/pins.json legitimately does not exist before the first fetch — the
  // hash must still compute, and writing it must still register as a change.
  const dir = fixture();
  try {
    const withoutPins = serviceContentHash(dir);
    assert.equal(serviceContentHash(dir), withoutPins);
    writeFileSync(join(dir, "scripts", "pins.json"), "{}\n");
    assert.notEqual(serviceContentHash(dir), withoutPins);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
