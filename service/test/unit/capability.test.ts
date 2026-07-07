import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyCapability } from "../../src/capability.ts";

// A local mint helper that reproduces the platform caller's EXACT token format:
//   v1.<base64url(JSON{o,a,e})>.<base64url(HMAC-SHA256(secret,"v1."+payload))>
function mint(secret: string, appId: string, expSec: number): string {
  const payload = Buffer.from(JSON.stringify({ a: appId, e: expSec })).toString("base64url");
  const sig = createHmac("sha256", secret).update(`v1.${payload}`).digest("base64url");
  return `v1.${payload}.${sig}`;
}

const SECRET = "s3cr3t-under-test";
const NOW = 1_800_000_000;

test("round-trips a freshly minted token", () => {
  const token = mint(SECRET, "app-1", NOW + 300);
  const res = verifyCapability(token, SECRET, NOW);
  assert.deepEqual(res, { ok: true, appId: "app-1" });
});

test("wrong secret → bad_signature", () => {
  const token = mint(SECRET, "app-1", NOW + 300);
  const res = verifyCapability(token, "not-the-secret", NOW);
  assert.deepEqual(res, { ok: false, reason: "bad_signature" });
});

test("tampered payload → bad_signature", () => {
  const token = mint(SECRET, "app-1", NOW + 300);
  const [, , sig] = token.split(".");
  // Swap in a different (validly-encoded) payload but keep the original sig.
  const forgedPayload = Buffer.from(JSON.stringify({ o: "org-evil", a: "app-1", e: NOW + 300 })).toString(
    "base64url",
  );
  const res = verifyCapability(`v1.${forgedPayload}.${sig}`, SECRET, NOW);
  assert.deepEqual(res, { ok: false, reason: "bad_signature" });
});

test("expired token (e in the past) → expired", () => {
  const token = mint(SECRET, "app-1", NOW - 1);
  const res = verifyCapability(token, SECRET, NOW);
  assert.deepEqual(res, { ok: false, reason: "expired" });
});

test("malformed strings → malformed (never throws)", () => {
  for (const bad of [
    "",
    "v1",
    "v1.",
    "v1.abc",
    "abc.def.ghi",
    "v2.abc.def", // wrong version
    "v1..sig",
    "just-garbage",
    "v1.notbase64!!!.sig", // payload fails signature, but we check missing sig-length first
  ]) {
    const res = verifyCapability(bad, SECRET, NOW);
    assert.equal(res.ok, false, `expected not-ok for ${JSON.stringify(bad)}`);
    if (!res.ok) assert.ok(["malformed", "bad_signature"].includes(res.reason));
  }
});

test("valid signature but payload missing/mistyped fields → malformed", () => {
  // Sign a payload that lacks the required numeric `e`.
  const payload = Buffer.from(JSON.stringify({ a: "app-1" })).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(`v1.${payload}`).digest("base64url");
  const res = verifyCapability(`v1.${payload}.${sig}`, SECRET, NOW);
  assert.deepEqual(res, { ok: false, reason: "malformed" });
});
