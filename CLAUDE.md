# hereya-aws-sqlite-data — dev notes

Hereya package `hereya/aws-sqlite-data`. README.md has the architecture, API, contract and
runbook; this file is the working-agreement layer for agents.

> Public fork of `dilaya/aws-sqlite-data` (private). The two evolve independently; this one
> is the generic Hereya-platform variant, paired with `hereya/aws-sqlite-db` (per-app
> provisioning) and consumed by `hereya-fullstack-sqlite-template`. Divergences from
> upstream: the capability header is `x-hereya-capability`, and the ORG DIMENSION IS
> REMOVED — everything is keyed by `app_id` alone (wire bodies, registry PK, file paths
> `<appId>/app.db`, capability payload `{a,e}`).

## Load-bearing invariants (do not "fix" these)

1. **Executors are child processes, not worker threads.** A runaway query inside one native
   `sqlite3_step` (e.g. `SELECT MAX(x)` over an infinite recursive CTE) is NOT interruptible
   by `worker.terminate()` — only SIGKILL stops it (verified experimentally; node:sqlite has
   no `interrupt()`). Timeout = kill the child; WAL makes it crash-safe. All child event
   handlers guard on `this.child !== child` (stale exit/reply races).
2. **Restore-if-missing, both directions.** Never let a worker create an empty db before
   `litestream restore -if-replica-exists` ran (masks S3 data); never restore over an
   existing local file (clobbers newer local writes). `AppSync.ensureServed` is the request-
   path gate; boot restores everything before the port binds.
3. **Fail-closed everywhere.** Registry unreadable → 503, unknown/inactive pair → 403,
   errors never cached, tx ids scoped to the app that opened them. The VM revalidates every
   request independently of the platform caller (spec §6 double control).
4. **No S3 lifecycle rules / versioning on the replica bucket** — Litestream owns retention.
   Template test enforces it.
5. **Capacity rebalance OFF** on the ASG — replacement-before-terminate would run two
   litestream writers on one generation path. Same reason the update policy is a **rolling
   update with `minInstancesInService: 0`** (terminate-before-launch, since 0.1.1): never switch
   it back to `replacingUpdate()`, which runs old and new instances side by side on one replica.
6. **Wire shapes mirror the RDS Data API** (`SqlParameter[]`, `records`/`columnMetadata`/
   `numberOfRecordsUpdated`, `Field` union incl. base64 `blobValue`; INTEGER beyond ±2^53 →
   `stringValue`) so callers' `convertParams`/`extractFieldValue` round-trip unchanged.
7. **SQL guards are duplicated by design**: ATTACH/DETACH, `VACUUM INTO`, PRAGMA outside the
   read-only allowlist are rejected HERE even when a caller also rejects them.
8. **A NEW SERVICE rolls the instance — a new BUILD must not** (0.1.1, upstream 0.1.8/0.1.10).
   The `# service-artifact-hash:` line in `buildUserData` is an inert comment but load-bearing:
   it versions the launch template, so a changed hash makes the rolling update replace the
   instance (~1 min with no Data API). The hash is `serviceContentHash()` (`lib/service-hash.ts`):
   `service/**` (tests included) + `scripts/build-service.mjs` + the pinned node/litestream versions
   and `pins.json` — **never** the built tarball (`AssetHashType.OUTPUT`), which is not
   reproducible and rolled upstream's VM on every deploy of anything. `test/service-hash.test.ts`
   and `test/rollout.test.ts` pin it. The SSM artifact pointer stays the emergency path.
9. **The AMI is a constant, not a lookup** (0.1.1, upstream 0.1.11–0.1.12).
   `latestAmazonLinux2023()` re-resolves at every deploy and replaced the VM on the first deploy
   after each AWS publication. The id lives in `PINNED_AMI_ID` (`lib/ami-pin.ts`) and reaches the
   launch template through `resolveMachineImage()`; the hereyarc `amiId` default MUST equal it
   (Hereya passes the default as env, which overrides the constant — a test enforces equality).
   `amiId=latest` restores auto-resolution. **`npm run check:ami`** is the half that makes the pin
   safe: exit 1 when a newer AL2023 exists (or `--stack <FULL name>` finds the instance on neither
   image), exit 2 — never 0 — when it cannot tell. The 0.1.1 pin is `ami-0390cc9c657024910`, the
   image the production VM has run since 2026-07-07, so pinning alone rolls nothing; moving it is
   a deliberate, announced release. With 8 and 9, only a new service or a bumped pin roll the VM.
10. **One restore per db path, one litestream replicate process** (0.1.1, upstream 0.1.26/0.1.40).
    `Restorer` (`service/src/litestream/restore.ts`) shares an in-flight restore between callers
    (`ensureServed` and the registry reconcile used to race: "output path already exists" 503s).
    `Litestream.bounce()`/`stop()` are serialized: two overlapping bounces used to orphan a second
    `litestream replicate` process — a dual writer. `service/test/unit/{restore,bounce}-race.test.ts`
    pin both and were verified to fail on 0.1.0.

## Working on it

- `npm test` = unit + integration (in-process boots, real litestream with `file://` replicas)
  + CDK template assertions. Tests run under the pinned toolchain Node 24 (`.toolchain/`),
  NOT the system node (node:sqlite + `StatementSync.columns()` need ≥23.11).
- Registry schema (shared with provisioning packages): one row per app, PK `app_id`,
  attributes {`status`, `name`, `createdAt`}; the VM reads only `status`. `status` and
  `name` are DDB reserved words — always alias them (`#s`/`#n`) in expressions.
- The service artifact is hermetic: `scripts/build-service.mjs` pins Node + litestream by
  sha256 (`scripts/pins.json`). Bump versions via `scripts/{node,litestream}-version.txt`
  and REVIEW the new pins before committing.
- cdk.json runs the app through `npx tsx` (package is ESM; ts-node would choke).
  The repo-local `aws-cdk` devDependency matters: the CLI must be ≥ the lib's cloud-assembly
  schema (a too-old global cdk silently no-ops with a schema-mismatch notice).
- Deploy for dev: `AWS_PROFILE=<p> AWS_REGION=eu-west-1 STACK_NAME=<name> autoDelete=true
  npx cdk deploy` — with `autoDelete=true`, `cdk destroy` removes bucket + table too.
- Release: bump `hereyarc.yaml` version → commit → tag `v<version>` → push → `hereya publish`.
- Stack test files synth under a cross-process lock (`test/synth-helpers.ts` → `synthStack()`):
  the runner executes files in parallel and every synth runs `build-service.mjs` into the shared
  `dist/`. Build stacks in tests through `synthStack`, never `new HereyaAwsSqliteDataStack` directly.

## Observed behaviors (dev acceptance, 2026-07-02, upstream)

- Kill-instance recovery: **53s** end-to-end (terminate → new on-demand instance →
  restore → first successful query). Kill-process: systemd restart < 10s, no ASG event.
- Noisy-neighbor: victim p95 143→144ms under a 40-bomb flood. A flooding app's QUEUED
  requests can exceed API Gateway's 30s integration timeout → the gateway returns 503
  (retryable) for those; per-app cap returns 429; the SQL deadline returns 408. All three
  are contained to the offending app.
- **Spot reality check**: t4g Spot went unfulfillable across 2 AZs + 2 sizes in eu-west-1
  for >10 min — that's why the default is on-demand (`spotPercentage=0`); Spot is opt-in.

## Consumer-track interfaces (implemented)

- `GET /stats?app_id → {dbSizeBytes}` — capability-gated usage endpoint.
- `POST /admin/delete-app {app_id}` — teardown: close executor, drop from
  litestream config, delete the local file, **KEEP the S3 replica**. Capability-gated but
  skips the active-status check (a platform caller may flip the registry row to `deleting`
  first before calling it).
