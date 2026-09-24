// The AMI pin, and the one function that says whether it has fallen behind.
// Backported from upstream dilaya/aws-sqlite-data 0.1.11–0.1.12 (+ the later
// exitCodeFor/describeLookup hardening).
//
// The pin itself is CLAUDE.md invariant 9: the launch template gets a literal
// AMI id, never a `latestAmazonLinux2023()` lookup, because that lookup
// re-resolves at every deploy and terminates the database VM the first time
// anything is deployed after AWS publishes an image (~monthly).
//
// The pin has a cost: OS security patches no longer arrive by accident, only
// when someone bumps `PINNED_AMI_ID`. Upstream first covered that cost with a
// sentence in a runbook ("compare the pin with the current AL2023"); nobody
// ever ran it, and a VM went four weeks on the same image. A written
// instruction that nothing executes is not a control — so the comparison lives
// here as code, `npm run check:ami` runs it, and its exit code is the signal.

/** Region the pinned id belongs to — an AMI id is region-scoped. */
export const PINNED_AMI_REGION = "eu-west-1";

/**
 * AL2023, kernel 6.1, arm64, eu-west-1: `al2023-ami-2023.12.20260918.0`,
 * taken from a fresh `npm run check:ami` on 2026-09-24 (0.1.2). Previous pin:
 * `ami-0390cc9c657024910`, the image the production VM had run since 2026-07-07,
 * pinned as-is in 0.1.1 so that introducing the pin rolled nothing.
 *
 * To roll the OS: `npm run check:ami`, bump this constant AND the `amiId`
 * default in hereyarc.yaml to the id it reports, publish, deploy, announce.
 * Rolling replaces the VM (~1 min with no Data API), so it is a dated,
 * announced act, never a side effect. Take the id from a FRESH `check:ami` —
 * Amazon has republished within a day.
 */
export const PINNED_AMI_ID = "ami-06f589fd2af7a9fc7";

/**
 * The SSM public parameter the pin is measured against. It MUST stay the same
 * parameter the pin was taken from: `al2023-ami-kernel-default-arm64` follows
 * whatever kernel AL2023 currently defaults to, while `-kernel-6.1-` is frozen
 * on that line. They diverge the day AL2023 moves its default — and comparing
 * against the wrong one would report a permanent, unfixable "upgrade available".
 */
export const AL2023_SSM_PARAMETER =
  "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64";

export type AmiPinVerdict =
  /** The pin is the newest published image. Nothing to do. */
  | { state: "current" }
  /** A newer image exists: propose a dated roll. */
  | { state: "behind"; latest: string }
  /** The running instance is on neither — it predates the current pin. */
  | { state: "instance-stale"; running: string }
  /** Something could not be read; never mistake this for "current". */
  | { state: "unknown"; reason: string };

export interface AmiPinInput {
  /** `PINNED_AMI_ID`, or whatever a caller pinned. */
  pinned: string;
  /** Resolved from `AL2023_SSM_PARAMETER`; null when it could not be read. */
  latest: string | null;
  /** `ImageId` of the instance actually running, when the caller could read it.
   *  Optional on purpose: pin-vs-published needs no EC2 permission at all. */
  running?: string | null;
}

/**
 * Compare a pin with what AWS publishes — pure, so the tests cover every branch
 * without credentials or a network.
 *
 * An unreadable parameter is `unknown`, never assumed current: a check that
 * silently passes when it cannot see manufactures reassurance nobody verified.
 * A stale *instance* is reported apart from a stale *pin*: a behind pin means
 * plan a roll (edit), an instance on neither image means a bumped pin was
 * published but never rolled out (deploy).
 */
export function amiPinStatus({ pinned, latest, running }: AmiPinInput): AmiPinVerdict {
  if (!latest) {
    return { state: "unknown", reason: `could not resolve ${AL2023_SSM_PARAMETER}` };
  }
  if (pinned !== latest) return { state: "behind", latest };
  if (running && running !== pinned) {
    return { state: "instance-stale", running };
  }
  return { state: "current" };
}

/**
 * What came back when the caller asked about a specific stack's instance.
 *
 * Four cases, because collapsing the last three into one `null` cost upstream
 * the check: a TRUNCATED stack name matched nothing (the tag filter is exact),
 * that empty result was indistinguishable from "no permission", the command
 * exited 0, and the `instance-stale` branch never once ran. `no-match` is a bad
 * ARGUMENT, `unreadable` a bad ENVIRONMENT; neither may exit 0.
 */
export type InstanceLookup =
  /** No `--stack` was passed: only the pin was ever in question. */
  | { state: "not-requested" }
  /** The stack's running instance was read. */
  | { state: "found"; imageId: string }
  /** The lookup worked and matched nothing — the stack name designates no instance. */
  | { state: "no-match"; stackName: string }
  /** The lookup itself failed: no CLI, no credentials, API error. */
  | { state: "unreadable"; stackName: string; reason: string };

/**
 * The command's exit code: 0 in sync · 1 a roll is needed · 2 could not determine.
 *
 * 1. A known-actionable verdict wins: a behind pin needs a roll whether or not
 *    the instance could be read.
 * 2. Otherwise a requested-but-unanswered instance question forbids 0 —
 *    `--stack` + 0 means BOTH halves were verified.
 */
export function exitCodeFor(verdict: AmiPinVerdict, lookup: InstanceLookup): 0 | 1 | 2 {
  if (verdict.state === "behind" || verdict.state === "instance-stale") return 1;
  if (verdict.state === "unknown") return 2;
  return lookup.state === "not-requested" || lookup.state === "found" ? 0 : 2;
}

/** The line that explains a lookup that produced no image id. Empty when it did. */
export function describeLookup(lookup: InstanceLookup): string {
  switch (lookup.state) {
    case "not-requested":
    case "found":
      return "";
    case "no-match":
      return (
        `No running instance carries tag aws:cloudformation:stack-name=${lookup.stackName}. ` +
        `That filter is an exact match, so a truncated or misspelt stack name selects nothing — ` +
        `pass the FULL stack name. The instance was NOT checked.`
      );
    case "unreadable":
      return `Could not read the running instance of ${lookup.stackName}: ${lookup.reason}. The instance was NOT checked.`;
  }
}

/** One line a human (or an alert digest) can read without context. */
export function describeVerdict(v: AmiPinVerdict, pinned: string): string {
  switch (v.state) {
    case "current":
      return `AMI pin is current (${pinned}).`;
    case "behind":
      return `A newer AL2023 exists: ${v.latest} (pinned: ${pinned}). Plan a roll — bump PINNED_AMI_ID, publish, deploy, announce.`;
    case "instance-stale":
      return `The running instance is on ${v.running}, but the pin is ${pinned} — a bumped pin was never rolled out. Fix with a deploy, not an edit.`;
    case "unknown":
      return `Could not determine AMI freshness: ${v.reason}. This is NOT "up to date".`;
  }
}
