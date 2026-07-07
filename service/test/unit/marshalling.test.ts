import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertResponseSize,
  bindParams,
  marshalRows,
  toField,
  type SqlParameter,
} from "../../src/marshalling.ts";
import { ServiceError } from "../../src/errors.ts";

test("bindParams converts every Field shape", () => {
  const params: SqlParameter[] = [
    { name: "s", value: { stringValue: "hello" } },
    { name: "i", value: { longValue: 42 } },
    { name: "d", value: { doubleValue: 1.5 } },
    { name: "bt", value: { booleanValue: true } },
    { name: "bf", value: { booleanValue: false } },
    { name: "n", value: { isNull: true } },
    { name: "b", value: { blobValue: Buffer.from("abc").toString("base64") } },
  ];
  const binds = bindParams(params);
  assert.equal(binds.s, "hello");
  assert.equal(binds.i, 42);
  assert.equal(binds.d, 1.5);
  assert.equal(binds.bt, 1);
  assert.equal(binds.bf, 0);
  assert.equal(binds.n, null);
  assert.deepEqual(Buffer.from(binds.b as Uint8Array).toString(), "abc");
});

test("bindParams rejects non-integer longValue", () => {
  assert.throws(
    () => bindParams([{ name: "x", value: { longValue: 1.5 } }]),
    (err: unknown) => err instanceof ServiceError && err.code === "BAD_REQUEST",
  );
});

test("toField maps sqlite output values to wire Fields", () => {
  assert.deepEqual(toField(null), { isNull: true });
  assert.deepEqual(toField(7n), { longValue: 7 });
  assert.deepEqual(toField(-9_007_199_254_740_991n), { longValue: -9_007_199_254_740_991 });
  assert.deepEqual(toField(9_007_199_254_740_993n), { stringValue: "9007199254740993" });
  assert.deepEqual(toField(1.25), { doubleValue: 1.25 });
  assert.deepEqual(toField("x"), { stringValue: "x" });
  assert.deepEqual(toField(new Uint8Array([1, 2])), { blobValue: Buffer.from([1, 2]).toString("base64") });
});

test("marshalRows follows column order (duplicates collapse, documented)", () => {
  const cols = [{ name: "a" }, { name: "b" }];
  const records = marshalRows(cols, [{ a: 1n, b: "x" }, { a: null, b: 2.5 }]);
  assert.deepEqual(records, [
    [{ longValue: 1 }, { stringValue: "x" }],
    [{ isNull: true }, { doubleValue: 2.5 }],
  ]);
});

test("assertResponseSize enforces the cap", () => {
  const result = {
    records: [[{ stringValue: "y".repeat(2000) }]],
    numberOfRecordsUpdated: 0,
  };
  assert.throws(
    () => assertResponseSize(result, 1000),
    (err: unknown) => err instanceof ServiceError && err.code === "RESULT_TOO_LARGE",
  );
  assertResponseSize(result, 10_000); // no throw
});
