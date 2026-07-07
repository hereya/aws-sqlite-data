import assert from "node:assert/strict";
import { test } from "node:test";
import { Limiter } from "../../src/limits.ts";
import { TxRegistry } from "../../src/tx.ts";
import { ServiceError } from "../../src/errors.ts";

test("Limiter caps per app and globally", () => {
  const limiter = new Limiter({ maxPerApp: 2, maxTotal: 3 });
  limiter.acquire("a");
  limiter.acquire("a");
  assert.throws(
    () => limiter.acquire("a"),
    (err: unknown) => err instanceof ServiceError && err.code === "THROTTLED",
  );
  limiter.acquire("b"); // total = 3
  assert.throws(
    () => limiter.acquire("c"),
    (err: unknown) => err instanceof ServiceError && err.code === "THROTTLED",
  );
  limiter.release("a");
  limiter.acquire("c"); // freed slot is usable
  assert.equal(limiter.totalInFlight, 3);
});

test("TxRegistry scopes transactions to their app pair", () => {
  let now = 0;
  const reg = new TxRegistry({ idleMs: 100, maxMs: 1000, now: () => now });
  const entry = reg.create("org1/app1");
  assert.equal(reg.use(entry.txId, "org1/app1").txId, entry.txId);
  assert.throws(
    () => reg.use(entry.txId, "org2/app1"),
    (err: unknown) => err instanceof ServiceError && err.code === "TX_NOT_FOUND",
  );
  assert.throws(
    () => reg.use("nonexistent", "org1/app1"),
    (err: unknown) => err instanceof ServiceError && err.code === "TX_NOT_FOUND",
  );
});

test("TxRegistry expires on idle and on max lifetime", () => {
  let now = 0;
  const reg = new TxRegistry({ idleMs: 100, maxMs: 1000, now: () => now });
  const a = reg.create("k/a");
  now = 50;
  reg.use(a.txId, "k/a"); // touch resets idle
  now = 140;
  reg.use(a.txId, "k/a"); // 90ms since touch — still alive
  now = 260;
  assert.throws(
    () => reg.use(a.txId, "k/a"),
    (err: unknown) => err instanceof ServiceError && err.code === "TX_EXPIRED",
  );

  const b = reg.create("k/b");
  for (let t = 300; t <= 1400; t += 90) {
    now = t;
    try {
      reg.use(b.txId, "k/b");
    } catch (err) {
      assert.ok(err instanceof ServiceError && err.code === "TX_EXPIRED");
      assert.ok(t - b.createdAt > 1000, "must only die from max lifetime");
      return;
    }
  }
  assert.fail("transaction outlived its max lifetime");
});

test("TxRegistry sweep returns expired entries once", () => {
  let now = 0;
  const reg = new TxRegistry({ idleMs: 100, maxMs: 1000, now: () => now });
  reg.create("k/a");
  reg.create("k/b");
  now = 200;
  const expired = reg.sweep();
  assert.equal(expired.length, 2);
  assert.equal(reg.sweep().length, 0);
  assert.equal(reg.size, 0);
});

test("TxRegistry deleteByAppKey drops all txs for the app", () => {
  const reg = new TxRegistry({ idleMs: 1000, maxMs: 10_000 });
  reg.create("k/a");
  reg.create("k/other");
  const dropped = reg.deleteByAppKey("k/a");
  assert.equal(dropped.length, 1);
  assert.equal(reg.hasOpenTx("k/a"), false);
  assert.equal(reg.hasOpenTx("k/other"), true);
});
