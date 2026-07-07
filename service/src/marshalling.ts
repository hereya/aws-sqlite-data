// Wire shapes deliberately mirror the RDS Data API's SqlParameter / Field unions
// so the platform caller's existing convertParams/extractFieldValue round-trip unchanged.
import { ServiceError } from "./errors.ts";

export type FieldValue =
  | { isNull: true }
  | { stringValue: string }
  | { longValue: number }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { blobValue: string }; // base64

export interface SqlParameter {
  name: string;
  value: FieldValue;
  typeHint?: string;
}

export interface ColumnMetadata {
  name: string;
  typeName?: string;
}

export interface StatementResult {
  records?: FieldValue[][];
  columnMetadata?: ColumnMetadata[];
  numberOfRecordsUpdated: number;
  lastInsertId?: number;
}

export type SqliteBindable = null | string | number | bigint | Uint8Array;

const MAX_SAFE = 9_007_199_254_740_991n; // 2^53 - 1
const MIN_SAFE = -9_007_199_254_740_991n;

/** SqlParameter[] → bind object for node:sqlite named parameters. */
export function bindParams(params: SqlParameter[]): Record<string, SqliteBindable> {
  const binds: Record<string, SqliteBindable> = {};
  for (const p of params) {
    binds[p.name] = fieldToBindable(p.name, p.value);
  }
  return binds;
}

function fieldToBindable(name: string, value: FieldValue): SqliteBindable {
  if ("isNull" in value) {
    if (value.isNull !== true) throw new ServiceError("BAD_REQUEST", `param ${name}: isNull must be true`);
    return null;
  }
  if ("stringValue" in value) return value.stringValue;
  if ("longValue" in value) {
    if (!Number.isInteger(value.longValue)) {
      throw new ServiceError("BAD_REQUEST", `param ${name}: longValue must be an integer`);
    }
    return value.longValue;
  }
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue ? 1 : 0;
  if ("blobValue" in value) return new Uint8Array(Buffer.from(value.blobValue, "base64"));
  throw new ServiceError("BAD_REQUEST", `param ${name}: unrecognized value shape`);
}

/** One SQLite output value → wire Field. INTEGER arrives as bigint (readBigInts). */
export function toField(v: unknown): FieldValue {
  if (v === null || v === undefined) return { isNull: true };
  if (typeof v === "bigint") {
    if (v <= MAX_SAFE && v >= MIN_SAFE) return { longValue: Number(v) };
    return { stringValue: v.toString() }; // documented drift: beyond ±2^53 → string
  }
  if (typeof v === "number") return { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (v instanceof Uint8Array) return { blobValue: Buffer.from(v).toString("base64") };
  return { stringValue: String(v) };
}

/**
 * Rows (as objects keyed by column name — node:sqlite has no positional mode;
 * duplicate column names collapse, same as the product layer does today) →
 * positional records following the column order.
 */
export function marshalRows(
  columns: ColumnMetadata[],
  rows: Array<Record<string, unknown>>,
): FieldValue[][] {
  return rows.map((row) => columns.map((c) => toField(row[c.name])));
}

export function assertResponseSize(result: StatementResult, maxBytes: number): void {
  if (!result.records || result.records.length === 0) return;
  const size = Buffer.byteLength(JSON.stringify(result.records), "utf8");
  if (size > maxBytes) {
    throw new ServiceError(
      "RESULT_TOO_LARGE",
      `result set is ${size} bytes (limit ${maxBytes}); narrow the query or paginate with LIMIT/OFFSET`,
    );
  }
}
