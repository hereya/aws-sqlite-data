import { randomUUID } from "node:crypto";
import { ServiceError } from "./errors.ts";

export interface TxEntry {
  txId: string;
  appKey: string; // the appId — a tx can only ever be used by the app that opened it
  createdAt: number;
  lastTouch: number;
}

export interface TxRegistryOptions {
  idleMs: number;
  maxMs: number;
  now?: () => number;
}

export class TxRegistry {
  private readonly entries = new Map<string, TxEntry>();
  private readonly opts: TxRegistryOptions;
  private readonly now: () => number;

  constructor(opts: TxRegistryOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  create(appKey: string): TxEntry {
    const t = this.now();
    const entry: TxEntry = { txId: randomUUID(), appKey, createdAt: t, lastTouch: t };
    this.entries.set(entry.txId, entry);
    return entry;
  }

  /**
   * Resolve + touch a transaction for the given app pair. Unknown id and
   * wrong-pair lookups are indistinguishable to the caller (TX_NOT_FOUND) —
   * a transaction id never acts as a capability across org/app boundaries.
   */
  use(txId: string, appKey: string): TxEntry {
    const entry = this.entries.get(txId);
    if (!entry || entry.appKey !== appKey) {
      throw new ServiceError("TX_NOT_FOUND", "unknown transaction for this org/app (it may have expired)");
    }
    const t = this.now();
    if (this.isExpired(entry, t)) {
      this.entries.delete(txId);
      throw new ServiceError("TX_EXPIRED", "transaction expired and was rolled back");
    }
    entry.lastTouch = t;
    return entry;
  }

  delete(txId: string): void {
    this.entries.delete(txId);
  }

  /** All open transactions for an app (used when a worker dies: they are gone). */
  deleteByAppKey(appKey: string): TxEntry[] {
    const dropped: TxEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.appKey === appKey) {
        this.entries.delete(entry.txId);
        dropped.push(entry);
      }
    }
    return dropped;
  }

  hasOpenTx(appKey: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.appKey === appKey) return true;
    }
    return false;
  }

  /** Remove and return expired entries so the caller can roll them back. */
  sweep(): TxEntry[] {
    const t = this.now();
    const expired: TxEntry[] = [];
    for (const entry of this.entries.values()) {
      if (this.isExpired(entry, t)) {
        this.entries.delete(entry.txId);
        expired.push(entry);
      }
    }
    return expired;
  }

  get size(): number {
    return this.entries.size;
  }

  private isExpired(entry: TxEntry, t: number): boolean {
    return t - entry.lastTouch > this.opts.idleMs || t - entry.createdAt > this.opts.maxMs;
  }
}
