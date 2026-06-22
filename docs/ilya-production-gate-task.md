# Task for Ilya: production gate for P0 security blockers

## Context

Dev gate is `PASS`.

Confirmed in dev:

- `GET /api/status` PASS.
- `POST /api/external/analyze` with `SERVICE_TOKEN` PASS.
- duplicate `requestId` PASS.
- `delivery.sendToTelegram=false` PASS.
- `POST /telegram/webhook` missing/wrong/valid secret PASS.
- `POST /api/clear-logs` missing/wrong/admin token PASS.
- D1 required tables PASS.

Production must not be released automatically. Production is a separate gate.

## Goal

Safely deploy the P0 security changes to production and verify production health.

## Production prerequisites

### 1. Confirm production secrets

Configure or verify production secrets:

```text
SERVICE_TOKEN
WEBHOOK_TOKEN
TELEGRAM_WEBHOOK_SECRET
ADMIN_TOKEN
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

Rules:

- Do not print secret values.
- Report only `configured yes/no`.
- Production secrets must be separate from dev secrets.

### 2. Export production D1 backup

Before migration/deploy, export production D1:

```text
wrangler d1 export stock_signal_scanner_production --remote --output backup-production-YYYYMMDD.sql
```

If the exact database binding/name differs, use the configured production D1 database.

### 3. Capture rollback target

Before production deploy:

```text
wrangler versions list --env production
```

Record:

- last known good version id;
- rollback command.

Expected rollback command:

```text
wrangler rollback <VERSION_ID> --env production
```

## Production steps

### 1. Apply production D1 migration

Run:

```text
npm.cmd run cf:d1:migrate:production
```

Verify required tables:

- `contract_results`
- `analysis_tasks`
- `analysis_cache`
- `request_logs`
- `ticker_request_logs`

### 2. Deploy production Worker

Run:

```text
npm.cmd run cf:deploy:production
```

### 3. Reset production Telegram webhook

Set production Telegram webhook:

```text
url = <production-worker-url>/telegram/webhook
secret_token = TELEGRAM_WEBHOOK_SECRET
```

Do not log token value.

## Production health checks

Run and report:

- `GET /api/status`
- `POST /api/external/analyze` with missing service token -> expected `403`
- `POST /api/external/analyze` with valid `SERVICE_TOKEN` -> expected `200` with contract response
- duplicate `requestId` -> expected saved response, no duplicate analysis
- `delivery.sendToTelegram=false` -> expected `sendToTelegram=false`, `delivered=false`
- `POST /telegram/webhook` missing secret -> expected `403`
- `POST /telegram/webhook` wrong secret -> expected `403`
- `POST /telegram/webhook` valid secret -> expected `200`
- `POST /api/clear-logs` missing token -> expected `403`
- `POST /api/clear-logs` wrong scanner token -> expected `403`
- `POST /api/clear-logs` valid `ADMIN_TOKEN` -> expected `200`

## Expected report

```text
DevOps Report

Task: P0 Security blockers production gate
Environment: production
Status: PASS / FAIL

Secrets:
- SERVICE_TOKEN: configured yes/no
- WEBHOOK_TOKEN: configured yes/no
- TELEGRAM_WEBHOOK_SECRET: configured yes/no
- ADMIN_TOKEN: configured yes/no
- TELEGRAM_BOT_TOKEN: configured yes/no
- TELEGRAM_CHAT_ID: configured yes/no

D1:
- backup exported: yes/no
- backup file:
- migration applied: yes/no
- required tables verified: yes/no

Rollback:
- last known good Worker version:
- rollback command:

Deploy:
- production Worker deployed: yes/no
- Worker version/id:

Telegram webhook:
- reset with secret_token: yes/no

Production health:
- GET /api/status:
- external analyze missing token:
- external analyze valid SERVICE_TOKEN:
- duplicate requestId:
- delivery.sendToTelegram=false:
- webhook missing secret:
- webhook wrong secret:
- webhook valid secret:
- clear-logs missing token:
- clear-logs wrong scanner token:
- clear-logs valid ADMIN_TOKEN:

Issues:
1.

Recommendation:
Production ready / rollback / keep production blocked.
```

## Manager decision rules

If production gate passes:

- mark P0 security blockers closed for production;
- send summary to Oleg for optional post-production smoke confirmation;
- continue to P1/P2/P3 roadmap.

If production gate fails:

- keep production blocked;
- rollback if production behavior is unsafe;
- document failure and owner.
