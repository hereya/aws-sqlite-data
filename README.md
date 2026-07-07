# hereya/aws-sqlite-data

Hereya package (`iac: cdk`, `infra: aws`) providing **durable multi-tenant SQLite storage**
as shared platform infrastructure: one SQLite file per app on a self-healing EC2 Spot
singleton, continuously replicated to S3 by Litestream, served through an IAM-authorized
(SigV4) HTTP "Data API" behind API Gateway. Durable storage / disposable compute: the
instance can die at any time; the source of truth is S3.

Deploy this **once** (per workspace). Per-app databases are then provisioned by the
companion package **`hereya/aws-sqlite-db`** — a registry row + a capability token per app,
never a redeploy of this stack. The pairing mirrors `hereya/aws-aurora-dataapi` (shared
cluster) + `hereya/aws-postgres-serverless` (per-app database), with SQLite economics: no
per-app cost, no resume latency, one tiny VM.

## Architecture

```
consumer Lambda ──SigV4──▶ API Gateway (HTTP API, IAM auth)
                              │ VPC Link v2 + Cloud Map (no load balancer)
                              ▼
                EC2 ASG singleton (Spot, t4g, AL2023 arm64, SSM-only)
                  └─ Data API service (Node 24, bundled)
                       ├─ one CHILD PROCESS per app db (SIGKILL = timeout)
                       ├─ litestream child: WAL → s3://bucket/<appId>/app.db
                       ├─ registry poller/hot-add (DynamoDB, fail-closed)
                       └─ CloudWatch heartbeat (dead-man) ─▶ alarm ─▶ SNS ─▶ Telegram
```

- **Boot (strict)**: registry scan → `litestream restore` every active app **→ only then**
  bind HTTP → start replication → register in Cloud Map.
- **Timeouts**: per-request SQL deadline enforced by SIGKILLing the app's executor process —
  the only mechanism that stops a runaway query inside a single native `sqlite3_step`
  (worker-thread `terminate()` cannot; verified).
- **Isolation**: per-app in-flight cap (429) + global cap; ATTACH/DETACH/`VACUUM INTO`/
  write-PRAGMAs rejected; app ids revalidated against the registry on EVERY request
  (defense in depth — the API never trusts its caller).
- **App lifecycle is runtime**: adding an app = a DynamoDB registry row (PK `app_id`,
  `status=active`) — discovered by poll, `POST /admin/sync`, or
  request-path hot-add (restore-before-first-query). Never a CDK redeploy.
  `hereya/aws-sqlite-db` automates exactly this.
- **Caller binding (capability tokens)**: data routes optionally require an
  `x-hereya-capability` HMAC token bound to one `app_id` (see `capabilityEnforce`).
  IAM (SigV4) is the workspace boundary; the token is the per-app boundary — a caller
  holding only its own app's token cannot address another app.

## HTTP API (all routes IAM-authorized)

| Route | Body | Notes |
|---|---|---|
| `POST /query` | `{app_id, sql, params?, transactionId?}` | typed params/records mirror the RDS Data API `SqlParameter`/`Field` shapes; named parameters only (`:name`); 1MiB response cap |
| `POST /batch-execute` | `{app_id, sql, parameterSets, transactionId?}` | chunked inserts |
| `POST /tx/begin\|commit\|rollback` | `{app_id, transactionId?}` | tx ids are app-scoped; idle 15s / max 60s |
| `POST /admin/sync` | `{}` | reconcile served apps against the registry now |
| `POST /admin/delete-app` | `{app_id}` | tears down the app's local db (close executor, drop from litestream, delete local file); **S3 replica retained**; capability-gated to the app |
| `GET /stats?app_id` | – | `{dbSizeBytes}` (db + WAL on disk) |
| `GET /health` | – | status, apps, litestream up/down |

## Package contract

Inputs (env/`-p`): `capabilityEnforce` (see hereyarc), `instanceType` (t4g.micro),
`autoDelete`, `servicePort`, `sqlTimeoutMs`, `maxInflightPerApp`, `maxLiveWorkers`,
`registryPollSeconds`, `litestreamSyncIntervalMs`, `litestreamRetention`,
`telegramBotTokenParam` (SSM SecureString *name*), `telegramChatId`.

Outputs: `dataApiUrl`, `awsRegion`, `registryTableName`, `sqliteReplicaBucketName`,
`capabilitySecretArn` (the HMAC secret provisioning packages mint tokens with),
`iamPolicySqliteDataApi` (execute-api:Invoke), `iamPolicySqliteRegistry` (DDB writes),
`iamPolicySqliteCapability` (read the HMAC secret) — the `iamPolicy*` outputs auto-attach
to the consuming app's Lambda role.

> **Do not hand `iamPolicySqliteCapability` / the HMAC secret to tenant app code** — the
> secret is global (any holder can mint a token for ANY app). Give app Lambdas a single
> pre-minted token via `hereya/aws-sqlite-db` instead.

## Development

```bash
npm install
npm test              # unit + integration + CDK assertions (downloads Node 24 + litestream toolchain)
npm run typecheck
npm run build-service # dist/service.tar.gz (hermetic: pinned sha256 Node + litestream)
```

Local service without AWS: `REGISTRY_MODE=file REGISTRY_FILE=... LITESTREAM_DISABLED=1 DB_DIR=... node --experimental-strip-types service/src/main.ts` (or use the toolchain node).

## Acceptance / chaos scripts (`scripts/acceptance/`, run against a deployed stack)

```bash
node scripts/acceptance/canary.mjs <dataApiUrl> <registryTable>   # signed round-trip + forged-pair 403
node scripts/acceptance/kill-instance.mjs <stackName>             # terminate → auto-recovery with data intact
node scripts/acceptance/kill-process.mjs <stackName>              # SIGKILL → systemd restart, no ASG event
node scripts/acceptance/cut-network.mjs <stackName>               # SG swap → dead-man ALARM → restore → OK
node scripts/acceptance/noisy-neighbor.mjs <stackName>            # flood one app → other app unaffected
```

## Ops runbook

- **Service-only update (no CDK)**: build `service.tar.gz`, upload to any readable S3 spot,
  update the `/<stack>/service-artifact` SSM parameter, then either restart the service via
  SSM (`systemctl restart hereya-data-api` after re-running the fetch steps) or terminate the
  instance and let the ASG rebuild from the parameter.
- **Remove an app**: flip its registry row `status` (or delete the row) → the poller (or
  `/admin/sync`) closes it and deletes the LOCAL file. The **S3 replica is retained** as the
  durable archive; deleting `s3://bucket/<appId>/` is a deliberate manual op. Recreating
  the row later restores the app from the replica (restore-before-first-query).
- **Never** add S3 lifecycle rules or versioning to the replica bucket, and never mount the
  db files over the network — Litestream owns retention; only the Data API touches the files.
- **Spot loss window**: ≈ the litestream sync interval (1s default) on hard kills; clean
  interruptions drain (503 + checkpoint + final sync) to ~zero.
- Capacity rebalance stays OFF (two concurrent litestream writers on one generation path
  would corrupt it). Future overlap-style replacement requires the documented DDB lease.
- **`cdk destroy` caveat**: stack deletion terminates the instance without a drain, so its
  Cloud Map registration survives and blocks the discovery-service deletion. If destroy
  fails on the namespace service: `aws servicediscovery list-instances --service-id <id>`,
  deregister each, re-run destroy. (Future work: a custom resource that force-deregisters
  on delete.)
- **Purchasing**: on-demand by default. Spot (`spotPercentage=100`) is cheaper but was
  observed unfulfillable across 2 AZs + 2 instance sizes for >10 min in eu-west-1 — accept
  open-ended outages before enabling it.
