import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { call, startTestService, type TestService } from "../helpers.ts";

const SECRET = "cap-secret-under-test";
const HEADER = "x-hereya-capability";
const A1 = { app_id: "app-1" };

function mint(secret: string, appId: string, expSec: number): string {
  const payload = Buffer.from(JSON.stringify({ a: appId, e: expSec })).toString("base64url");
  const sig = createHmac("sha256", secret).update(`v1.${payload}`).digest("base64url");
  return `v1.${payload}.${sig}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);

// Service with a known secret, enforcement OFF (the rollout-compat window).
let svc: TestService;
// Service with enforcement ON.
let enforced: TestService;

before(async () => {
  svc = await startTestService({ capabilitySecret: SECRET });
  enforced = await startTestService({ capabilitySecret: SECRET, capabilityEnforce: true });
});

after(async () => {
  await svc.close();
  await enforced.close();
});

test("present + valid + matching app → allowed", async () => {
  const token = mint(SECRET, A1.app_id, nowSec() + 300);
  const res = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT 1" }, { [HEADER]: token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test("present but for a different app → 403 CAPABILITY_DENIED", async () => {
  // A valid token for app-2 (also an active app) must NOT authorize app-1.
  const token = mint(SECRET, "app-2", nowSec() + 300);
  const res = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT 1" }, { [HEADER]: token });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "CAPABILITY_DENIED");
});

test("present but expired → 403 CAPABILITY_DENIED", async () => {
  const token = mint(SECRET, A1.app_id, nowSec() - 5);
  const res = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT 1" }, { [HEADER]: token });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "CAPABILITY_DENIED");
});

test("absent + enforce=false → allowed and a cap_missing warn is emitted", async () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg?: unknown) => {
    warnings.push(String(msg));
  };
  try {
    const res = await call(svc.baseUrl, "/query", { ...A1, sql: "SELECT 1" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  } finally {
    console.warn = orig;
  }
  assert.ok(
    warnings.some((w) => w.includes("cap_missing") && w.includes("/query")),
    `expected a cap_missing warn, got: ${warnings.join(" | ")}`,
  );
});

test("absent + enforce=true → 403 CAPABILITY_DENIED", async () => {
  const res = await call(enforced.baseUrl, "/query", { ...A1, sql: "SELECT 1" });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "CAPABILITY_DENIED");
});

test("enforce=true still allows a valid matching token", async () => {
  const token = mint(SECRET, A1.app_id, nowSec() + 300);
  const res = await call(enforced.baseUrl, "/query", { ...A1, sql: "SELECT 1" }, { [HEADER]: token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});
