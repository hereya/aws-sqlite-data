import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ServiceError, type ErrorCode } from "./errors.ts";
import type { SqliteBindable, StatementResult } from "./marshalling.ts";

export interface ExecRequest {
  sql: string;
  binds: Record<string, SqliteBindable>;
  useTx: boolean;
  mode: "single" | "script";
  includeMetadata: boolean;
  maxResponseBytes: number;
}

interface Job {
  msg: Record<string, unknown>;
  timeoutMs: number;
  resolve: (result: StatementResult | undefined) => void;
  reject: (err: ServiceError) => void;
}

export interface AppWorkerCallbacks {
  /** Fired when the executor died (timeout/crash) and any open tx is gone. */
  onTxInvalidated: (appKey: string) => void;
}

export function resolveWorkerPath(): string {
  for (const candidate of ["./sql-worker.js", "./sql-worker.ts"]) {
    const p = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(p)) return p;
  }
  throw new Error("sql-worker entry not found next to worker-host");
}

const CLOSE_GRACE_MS = 1000;

/**
 * One child process per app db, strictly serialized execution with a bounded
 * host-side queue (bounded by the Limiter upstream). The per-request deadline
 * is enforced with SIGKILL — the only mechanism guaranteed to stop a runaway
 * query stuck inside a single native sqlite3_step (worker_threads terminate()
 * cannot; verified). Only this app's in-flight work is lost; queued jobs run
 * on a fresh child.
 */
export class AppWorker {
  readonly appKey: string;
  readonly dbPath: string;
  private readonly workerPath: string;
  private readonly callbacks: AppWorkerCallbacks;
  private child: ChildProcess | null = null;
  private readonly queue: Job[] = [];
  private inflight: Job | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private closed = false;

  constructor(appKey: string, dbPath: string, workerPath: string, callbacks: AppWorkerCallbacks) {
    this.appKey = appKey;
    this.dbPath = dbPath;
    this.workerPath = workerPath;
    this.callbacks = callbacks;
  }

  exec(req: ExecRequest, timeoutMs: number): Promise<StatementResult> {
    return this.post({ action: "exec", ...req }, timeoutMs) as Promise<StatementResult>;
  }

  async control(action: "begin" | "commit" | "rollback" | "checkpoint", timeoutMs: number): Promise<void> {
    await this.post({ action }, timeoutMs);
  }

  get busy(): boolean {
    return this.inflight !== null || this.queue.length > 0;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new ServiceError("UNAVAILABLE", "app is shutting down"));
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        child.kill("SIGKILL");
      }, CLOSE_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      // Graceful path: the child closes its connections and exits itself.
      try {
        child.send({ id: 0, action: "close" });
      } catch {
        child.kill("SIGKILL");
      }
    });
  }

  private post(msg: Record<string, unknown>, timeoutMs: number): Promise<StatementResult | undefined> {
    if (this.closed) {
      return Promise.reject(new ServiceError("UNAVAILABLE", "app is shutting down"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ msg, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  private ensureChild(): ChildProcess {
    if (this.child) return this.child;
    const child = fork(this.workerPath, [this.dbPath], {
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.unref();
    child.channel?.unref();
    // Every handler ignores events from a child that is no longer current:
    // a deadline-killed child's late 'exit' (or a reply racing the SIGKILL)
    // must never touch the fresh child's state.
    child.on("message", (reply: { id: number; ok: boolean; result?: StatementResult; code?: ErrorCode; message?: string }) => {
      if (this.child !== child) return;
      const job = this.inflight;
      if (!job || reply.id === 0) return;
      this.clearTimer();
      this.inflight = null;
      if (reply.ok) job.resolve(reply.result);
      else job.reject(new ServiceError(reply.code ?? "SQL_ERROR", reply.message ?? "sql error"));
      this.pump();
    });
    child.on("error", (err) => {
      if (this.child !== child) return;
      this.onChildDeath(new ServiceError("INTERNAL", `sql executor failed: ${err.message}`));
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.onChildDeath(new ServiceError("INTERNAL", "sql executor exited unexpectedly"));
    });
    this.child = child;
    return child;
  }

  private pump(): void {
    if (this.inflight || this.queue.length === 0 || this.closed) return;
    const job = this.queue.shift()!;
    this.inflight = job;
    const id = this.nextId++;
    job.msg.id = id;
    try {
      this.ensureChild().send(job.msg);
    } catch (err) {
      this.inflight = null;
      job.reject(new ServiceError("INTERNAL", `failed to dispatch to sql executor: ${(err as Error).message}`));
      return;
    }
    this.timer = setTimeout(() => this.onDeadline(job), job.timeoutMs);
  }

  private onDeadline(job: Job): void {
    if (this.inflight !== job) return;
    this.inflight = null;
    this.clearTimer();
    const child = this.child;
    this.child = null;
    child?.kill("SIGKILL");
    this.callbacks.onTxInvalidated(this.appKey);
    job.reject(
      new ServiceError("QUERY_TIMEOUT", `query exceeded the ${job.timeoutMs}ms time limit and was aborted`),
    );
    this.pump();
  }

  private onChildDeath(err: ServiceError): void {
    this.clearTimer();
    this.child = null;
    this.callbacks.onTxInvalidated(this.appKey);
    const job = this.inflight;
    this.inflight = null;
    if (job) job.reject(err);
    this.pump();
  }

  private failAll(err: ServiceError): void {
    this.clearTimer();
    const job = this.inflight;
    this.inflight = null;
    if (job) job.reject(err);
    while (this.queue.length > 0) this.queue.shift()!.reject(err);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export interface WorkerPoolOptions {
  maxLiveWorkers: number;
  workerPath: string;
  callbacks: AppWorkerCallbacks;
  /** Eviction guard: an executor with an open explicit tx must not be evicted. */
  canEvict: (appKey: string) => boolean;
}

export class WorkerPool {
  private readonly workers = new Map<string, AppWorker>();
  private readonly opts: WorkerPoolOptions;

  constructor(opts: WorkerPoolOptions) {
    this.opts = opts;
  }

  get(appKey: string, dbPath: string): AppWorker {
    const existing = this.workers.get(appKey);
    if (existing) {
      // refresh LRU position
      this.workers.delete(appKey);
      this.workers.set(appKey, existing);
      return existing;
    }
    const worker = new AppWorker(appKey, dbPath, this.opts.workerPath, this.opts.callbacks);
    this.workers.set(appKey, worker);
    this.evictIfNeeded();
    return worker;
  }

  async remove(appKey: string): Promise<void> {
    const worker = this.workers.get(appKey);
    if (!worker) return;
    this.workers.delete(appKey);
    await worker.close();
  }

  async closeAll(): Promise<void> {
    const all = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(all.map((w) => w.close()));
  }

  get size(): number {
    return this.workers.size;
  }

  private evictIfNeeded(): void {
    if (this.workers.size <= this.opts.maxLiveWorkers) return;
    for (const [appKey, worker] of this.workers) {
      if (this.workers.size <= this.opts.maxLiveWorkers) break;
      if (!worker.busy && this.opts.canEvict(appKey)) {
        this.workers.delete(appKey);
        void worker.close();
      }
    }
  }
}
