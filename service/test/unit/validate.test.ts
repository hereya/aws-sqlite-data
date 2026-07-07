import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceError } from "../../src/errors.ts";
import {
  assertSafeSql,
  isMultiStatement,
  stripSqlLiterals,
  validateParams,
  validateQuery,
} from "../../src/validate.ts";

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (err) {
    if (err instanceof ServiceError) return err.code;
    throw err;
  }
}

test("validateQuery accepts a well-formed request", () => {
  const q = validateQuery(
    {
      app_id: "6a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
      sql: "SELECT 1",
      params: [{ name: "x", value: { longValue: 1 } }],
    },
    1000,
  );
  assert.equal(q.sql, "SELECT 1");
  assert.equal(q.params.length, 1);
  assert.equal(q.includeResultMetadata, true);
});

test("validateQuery rejects path-shaped and missing ids", () => {
  const base = { sql: "SELECT 1" };
  assert.equal(codeOf(() => validateQuery({ ...base, app_id: "a/b" }, 1000)), "BAD_REQUEST");
  assert.equal(codeOf(() => validateQuery({ ...base, app_id: ".." }, 1000)), "BAD_REQUEST");
  assert.equal(codeOf(() => validateQuery({ ...base, app_id: "a.b" }, 1000)), "BAD_REQUEST");
  assert.equal(codeOf(() => validateQuery(base, 1000)), "BAD_REQUEST"); // app_id missing
});

test("stack-name-shaped and underscore-prefixed ids are accepted", () => {
  // hereya stack names look like p-<guid> — the id every provisioning uses.
  const stackName = "p-0b7e6f2a-9f1c-4c1e-8d3a-111111111111";
  assert.equal(validateQuery({ app_id: stackName, sql: "SELECT 1" }, 1000).appId, stackName);
  assert.equal(validateQuery({ app_id: "_internal", sql: "SELECT 1" }, 1000).appId, "_internal");
});

test("validateParams enforces exactly one value key", () => {
  assert.equal(codeOf(() => validateParams([{ name: "x", value: {} }])), "BAD_REQUEST");
  assert.equal(
    codeOf(() => validateParams([{ name: "x", value: { longValue: 1, stringValue: "a" } }])),
    "BAD_REQUEST",
  );
  assert.equal(codeOf(() => validateParams([{ name: "1bad", value: { longValue: 1 } }])), "BAD_REQUEST");
  const ok = validateParams([{ name: "x", value: { isNull: true } }]);
  assert.deepEqual(ok[0]!.value, { isNull: true });
});

test("stripSqlLiterals removes strings and comments", () => {
  assert.equal(stripSqlLiterals("SELECT 'ATTACH' -- ATTACH\n, 1").includes("ATTACH"), false);
  assert.equal(stripSqlLiterals("SELECT /* ATTACH */ 1").includes("ATTACH"), false);
  assert.equal(stripSqlLiterals(`SELECT "att''ach", 'don''t' , x'ff'`).includes("ach"), false);
});

test("assertSafeSql allows normal SQL and read-only PRAGMAs", () => {
  assertSafeSql("SELECT * FROM t WHERE name = :name");
  assertSafeSql("INSERT INTO t (a) VALUES (:a)");
  assertSafeSql("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT)");
  assertSafeSql("PRAGMA table_info(mytable)");
  assertSafeSql("PRAGMA foreign_key_list('t')");
  assertSafeSql("SELECT 'attach database is a string literal'");
});

test("assertSafeSql rejects escape primitives", () => {
  assert.equal(codeOf(() => assertSafeSql("ATTACH DATABASE '/etc/x' AS other")), "SQL_FORBIDDEN");
  assert.equal(codeOf(() => assertSafeSql("attach database :p as o")), "SQL_FORBIDDEN");
  assert.equal(codeOf(() => assertSafeSql("DETACH other")), "SQL_FORBIDDEN");
  assert.equal(codeOf(() => assertSafeSql("VACUUM INTO '/tmp/steal.db'")), "SQL_FORBIDDEN");
  assert.equal(codeOf(() => assertSafeSql("VACUUM main INTO '/tmp/steal.db'")), "SQL_FORBIDDEN");
  assert.equal(codeOf(() => assertSafeSql("PRAGMA journal_mode=DELETE")), "SQL_FORBIDDEN");
  assert.equal(codeOf(() => assertSafeSql("PRAGMA foreign_keys = OFF")), "SQL_FORBIDDEN");
  assert.equal(codeOf(() => assertSafeSql("PRAGMA database_list")), "SQL_FORBIDDEN");
  assert.equal(codeOf(() => assertSafeSql("SELECT 1; ATTACH DATABASE 'x' AS y")), "SQL_FORBIDDEN");
  assert.equal(codeOf(() => assertSafeSql("/**/ATTACH/**/DATABASE 'x' AS y")), "SQL_FORBIDDEN");
});

test("isMultiStatement", () => {
  assert.equal(isMultiStatement("SELECT 1"), false);
  assert.equal(isMultiStatement("SELECT 1;"), false);
  assert.equal(isMultiStatement("SELECT 1;  \n"), false);
  assert.equal(isMultiStatement("SELECT 1; SELECT 2"), true);
  assert.equal(isMultiStatement("SELECT ';'"), false);
  assert.equal(isMultiStatement("CREATE TABLE a (x TEXT); CREATE INDEX i ON a(x);"), true);
});
