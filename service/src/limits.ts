import { ServiceError } from "./errors.ts";

export interface LimiterOptions {
  maxPerApp: number;
  maxTotal: number;
}

/**
 * In-flight request accounting: a queued-or-executing request holds one slot
 * for its app and one global slot. A flooding app hits its own cap (429) long
 * before it can exhaust the global pool that other apps share.
 */
export class Limiter {
  private readonly perApp = new Map<string, number>();
  private total = 0;
  private readonly opts: LimiterOptions;

  constructor(opts: LimiterOptions) {
    this.opts = opts;
  }

  acquire(appKey: string): void {
    const current = this.perApp.get(appKey) ?? 0;
    if (current >= this.opts.maxPerApp) {
      throw new ServiceError("THROTTLED", `too many in-flight requests for this app (max ${this.opts.maxPerApp})`);
    }
    if (this.total >= this.opts.maxTotal) {
      throw new ServiceError("THROTTLED", `service is at its global in-flight limit (max ${this.opts.maxTotal})`);
    }
    this.perApp.set(appKey, current + 1);
    this.total += 1;
  }

  release(appKey: string): void {
    const current = this.perApp.get(appKey) ?? 0;
    if (current <= 1) this.perApp.delete(appKey);
    else this.perApp.set(appKey, current - 1);
    if (this.total > 0) this.total -= 1;
  }

  inFlight(appKey: string): number {
    return this.perApp.get(appKey) ?? 0;
  }

  get totalInFlight(): number {
    return this.total;
  }
}
