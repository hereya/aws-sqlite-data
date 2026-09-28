// Litestream housekeeping-cadence parsing and the one safety guard among them.
// Backported from upstream dilaya/aws-sqlite-data.

/** A litestream duration (`5m`, `30s`, `1h`, `250ms`) in milliseconds, or null. */
export function durationToMs(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value.trim());
  if (!m) return null;
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
  return Number(m[1]) * unit;
}

/**
 * How many times longer an L0 file must be RETAINED than the level-1 compaction
 * interval. Not a style preference — the boundary between a saving and data
 * loss. L0 is where a transaction lands first; it may only be swept once it has
 * been merged into L1. A file written just after a compaction waits nearly a
 * full interval for the next one, and that compaction takes time itself, so a
 * retention merely EQUAL to the interval races with it. Two full cycles is the
 * cheapest margin that is obviously sufficient.
 */
export const MIN_L0_RETENTION_RATIO = 2;

/**
 * Compaction level intervals, as a comma-separated list ordered L1, L2, …
 * Each level must be strictly slower than the one below it — litestream
 * compacts upwards, so an inverted pair would have a level repeatedly
 * recompacting what it already holds. Empty/unset keeps the defaults.
 */
export function parseLevelIntervals(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length === 0) return fallback;
  const ms: number[] = [];
  for (const p of parts) {
    const v = durationToMs(p);
    if (v === null) {
      throw new Error(`invalid LITESTREAM_LEVEL_INTERVALS entry: ${p} (expected a duration such as 5m)`);
    }
    ms.push(v);
  }
  for (let i = 1; i < ms.length; i += 1) {
    if (ms[i]! <= ms[i - 1]!) {
      throw new Error(
        `invalid LITESTREAM_LEVEL_INTERVALS: ${raw} (level ${i + 1} must be slower than level ${i})`,
      );
    }
  }
  return parts;
}

/**
 * The one combination of these settings that loses DATA rather than money.
 *
 * Every other knob here trades cost against restore speed. This pair does not:
 * a transaction lands in L0 first and is only safe to sweep once level 1 has
 * merged it, so an `l0-retention` shorter than the level-1 interval deletes
 * transactions that were never copied anywhere else. Nothing would report it —
 * litestream keeps replicating happily, every metric stays green, and the loss
 * only surfaces the day someone actually restores.
 *
 * It is easy to reach by accident precisely because the two values are tuned
 * for opposite reasons: slowing compaction is what saves the money, and the
 * retention is the number one forgets to move with it. Hence a boot-time
 * refusal rather than a line of documentation — the README already said it, and
 * a README cannot fail a deploy.
 */
export function assertL0RetentionCoversL1(l0Retention: string, levelIntervals: string[]): void {
  const retentionMs = durationToMs(l0Retention);
  const l1 = levelIntervals[0];
  if (retentionMs === null || l1 === undefined) return;
  const l1Ms = durationToMs(l1);
  if (l1Ms === null) return;
  if (retentionMs < l1Ms * MIN_L0_RETENTION_RATIO) {
    throw new Error(
      `invalid LITESTREAM_L0_RETENTION: ${l0Retention} is not safely longer than the level-1 ` +
        `compaction interval ${l1} — an L0 file swept before it is compacted into L1 is LOST data. ` +
        `Use at least ${MIN_L0_RETENTION_RATIO}x the level-1 interval.`,
    );
  }
}
