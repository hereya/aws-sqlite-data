// Child-process entry: owns the SQLite connections for exactly one app db.
// This is a PROCESS (not a worker thread) on purpose: a runaway query inside a
// single native sqlite3_step (e.g. an aggregate over an infinite recursive CTE)
// cannot be interrupted by V8 termination — only an OS-level SIGKILL is
// guaranteed to stop it. WAL mode makes that crash-safe (the uncommitted
// transaction rolls back on reopen).
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ErrorCode } from "./errors.ts";
import {
  assertResponseSize,
  marshalRows,
  type ColumnMetadata,
  type SqliteBindable,
  type StatementResult,
} from "./marshalling.ts";

interface ExecMessage {
  id: number;
  action: "exec";
  sql: string;
  binds: Record<string, SqliteBindable>;
  useTx: boolean;
  mode: "single" | "script";
  includeMetadata: boolean;
  maxResponseBytes: number;
}

interface ControlMessage {
  id: number;
  action: "begin" | "commit" | "rollback" | "checkpoint" | "close";
}

type WorkerMessage = ExecMessage | ControlMessage;

interface WorkerReply {
  id: number;
  ok: boolean;
  result?: StatementResult;
  code?: ErrorCode;
  message?: string;
}

const dbPath = process.argv[2];
if (!dbPath) throw new Error("usage: sql-worker <dbPath>");
if (typeof process.send !== "function") throw new Error("sql-worker must run as a forked child with IPC");

// Two connections: autocommit traffic must never land inside an open explicit
// transaction, so explicit transactions get their own connection.
let autoConn: DatabaseSync | null = null;
let txConn: DatabaseSync | null = null;

function openConn(): DatabaseSync {
  const db = new DatabaseSync(dbPath!);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA synchronous=NORMAL");
  return db;
}

function conn(useTx: boolean): DatabaseSync {
  if (useTx) {
    if (!txConn) txConn = openConn();
    return txConn;
  }
  if (!autoConn) autoConn = openConn();
  return autoConn;
}

function columnMetadata(stmt: StatementSync): ColumnMetadata[] {
  return stmt.columns().map((c) => ({
    name: c.name ?? c.column ?? "",
    typeName: c.type ?? undefined,
  }));
}

function toSafeNumber(v: number | bigint): number {
  const n = typeof v === "bigint" ? Number(v) : v;
  return Number.isSafeInteger(n) ? n : 0;
}

function execSingle(msg: ExecMessage): StatementResult {
  const db = conn(msg.useTx);
  const stmt = db.prepare(msg.sql);
  stmt.setReadBigInts(true);
  stmt.setAllowBareNamedParameters(true);
  const cols = columnMetadata(stmt);
  if (cols.length > 0) {
    const rows = stmt.all(msg.binds) as Array<Record<string, unknown>>;
    const result: StatementResult = {
      records: marshalRows(cols, rows),
      columnMetadata: msg.includeMetadata ? cols : undefined,
      numberOfRecordsUpdated: 0,
    };
    assertResponseSize(result, msg.maxResponseBytes);
    return result;
  }
  const info = stmt.run(msg.binds);
  return {
    numberOfRecordsUpdated: toSafeNumber(info.changes),
    lastInsertId: toSafeNumber(info.lastInsertRowid),
  };
}

function totalChanges(db: DatabaseSync): number {
  const row = db.prepare("SELECT total_changes() AS c").get() as { c: number | bigint };
  return toSafeNumber(row.c);
}

function execScript(msg: ExecMessage): StatementResult {
  const db = conn(msg.useTx);
  const before = totalChanges(db);
  db.exec(msg.sql);
  return { numberOfRecordsUpdated: totalChanges(db) - before };
}

function handle(msg: WorkerMessage): WorkerReply {
  switch (msg.action) {
    case "exec": {
      const result = msg.mode === "script" ? execScript(msg) : execSingle(msg);
      return { id: msg.id, ok: true, result };
    }
    case "begin":
      conn(true).exec("BEGIN IMMEDIATE");
      return { id: msg.id, ok: true };
    case "commit":
      conn(true).exec("COMMIT");
      return { id: msg.id, ok: true };
    case "rollback":
      conn(true).exec("ROLLBACK");
      return { id: msg.id, ok: true };
    case "checkpoint":
      // shutdown drain: fold the WAL into the main db so litestream's final
      // sync ships a complete snapshot of the tail
      conn(false).exec("PRAGMA wal_checkpoint(TRUNCATE)");
      return { id: msg.id, ok: true };
    case "close":
      try {
        autoConn?.close();
        txConn?.close();
      } catch {
        // closing is best-effort; the process is exiting
      }
      process.send!({ id: msg.id, ok: true } satisfies WorkerReply);
      process.exit(0);
  }
}

process.on("message", (msg: WorkerMessage) => {
  try {
    process.send!(handle(msg));
  } catch (err) {
    const isServiceShaped = typeof err === "object" && err !== null && "code" in err && "status" in err;
    const reply: WorkerReply = {
      id: msg.id,
      ok: false,
      code: isServiceShaped ? ((err as { code: ErrorCode }).code) : "SQL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    };
    process.send!(reply);
  }
});

// If the parent dies (or deliberately disconnects), don't linger as an orphan.
process.on("disconnect", () => process.exit(0));
