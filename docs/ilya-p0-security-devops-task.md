# Task for Ilya: DevOps validation for P0 security blockers

## Context

Grisha marked P0 security blockers as `DONE`.

Manager verification:

- Worker syntax OK.
- Contract/security smoke tests PASS locally.

Ilya must validate Cloudflare environment, secrets, D1 migration and remote dev health.

## Environment

Start with:

```text
dev
```

Production is blocked until dev passes.

## Secrets/env to configure

Required for dev:

```text
SERVICE_TOKEN
WEBHOOK_TOKEN
TELEGRAM_WEBHOOK_SECRET
ADMIN_TOKEN
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

Notes:

- `SERVICE_TOKEN` is preferred for `POST /api/external/analyze`.
- `WEBHOOK_TOKEN` remains legacy/fallback for old flows.
- Telegram webhook secret must match Telegram `secret_token`.
- Do not expose secrets in logs or reports.

## D1 migration

Apply dev migration:

```text
npm.cmd run cf:d1:migrate:dev
```

Verify tables:

- `contract_results`
- `analysis_tasks`
- `analysis_cache`
- `request_logs`
- `ticker_request_logs`

## Telegram webhook reset

Reset Telegram webhook with secret token.

Expected Telegram API call should set:

```text
url = <worker-url>/telegram/webhook
secret_token = <TELEGRAM_WEBHOOK_SECRET>
```

Verify:

- webhook is configured;
- secret token is active;
- wrong secret requests are rejected;
- valid Telegram delivery still works.

## Deploy check

Run dev deploy:

```text
npm.cmd run cf:deploy:dev
```

Then check:

- `GET /api/status`
- `POST /api/external/analyze` with valid service token
- duplicate `requestId`
- `delivery.sendToTelegram=false`
- `POST /telegram/webhook` missing/wrong/valid secret
- `POST /api/clear-logs` with admin token only

## Rollback risk

Before production:

- get last known good Worker version;
- export production D1 backup;
- write rollback command.

Do not proceed to production until dev passes.

## Expected DevOps report

```text
DevOps Report

Task: P0 Security blockers
Environment: dev
Status: PASS / FAIL

Secrets:
- SERVICE_TOKEN: configured yes/no
- TELEGRAM_WEBHOOK_SECRET: configured yes/no
- ADMIN_TOKEN: configured yes/no

D1:
- migration applied yes/no
- contract_results exists yes/no

Deploy:
- Worker deployed yes/no
- GET /api/status PASS/FAIL
- POST /api/external/analyze PASS/FAIL
- duplicate requestId PASS/FAIL
- Telegram webhook secret PASS/FAIL
- clear-logs admin auth PASS/FAIL

Issues:
1.

Recommendation:
Ready / not ready for production gate.
```
