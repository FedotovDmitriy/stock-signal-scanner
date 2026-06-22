# Task for Ilya: retry dev deploy gate outside sandbox

## Context

Ilya's first dev-gate attempt failed.

Confirmed:

- Local syntax/security/contract tests pass.
- Dev D1 migration applied successfully.
- Required remote dev D1 tables exist.

Blocked:

- Worker deploy failed in sandbox because Wrangler cannot read required parent directories.
- Remote dev Worker still runs old behavior.
- `POST /telegram/webhook` with wrong secret returns `200`, which is P0 FAIL.
- Cloudflare secrets API returned auth error `10000`.

## Goal

Complete dev deploy gate from an environment where Wrangler has normal filesystem access and Cloudflare auth works.

Production remains blocked until this task passes.

## Steps

### 1. Use a non-sandbox environment

Run from a normal local terminal or CI environment with repository access.

Do not run from the restricted Codex sandbox if Wrangler still cannot read parent directories.

### 2. Verify Cloudflare authentication

Run:

```text
npx wrangler whoami
```

Expected:

```text
Authenticated account is visible
```

If auth fails, fix Cloudflare login before continuing.

### 3. Verify dev secrets exist

Required dev secrets:

```text
SERVICE_TOKEN
WEBHOOK_TOKEN
TELEGRAM_WEBHOOK_SECRET
ADMIN_TOKEN
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

Do not print secret values.

Report only:

```text
configured yes/no
```

### 4. Deploy dev Worker

Run:

```text
npm.cmd run cf:deploy:dev
```

Expected:

```text
Deploy succeeds
```

### 5. Reset Telegram webhook with secret token

Set Telegram webhook with:

```text
url = <dev-worker-url>/telegram/webhook
secret_token = TELEGRAM_WEBHOOK_SECRET
```

Do not log token value.

### 6. Remote dev health checks

Run and report:

- `GET /api/status`
- `POST /telegram/webhook` missing secret -> expected `403`
- `POST /telegram/webhook` wrong secret -> expected `403`
- `POST /telegram/webhook` valid secret -> expected `200`
- `POST /api/external/analyze` valid service token -> expected `200` or valid contract response
- duplicate `requestId` -> expected previous response, no duplicate analysis
- `delivery.sendToTelegram=false` -> expected no Telegram delivery
- `POST /api/clear-logs` with `WEBHOOK_TOKEN` -> expected `403`
- `POST /api/clear-logs` with `ADMIN_TOKEN` -> expected `200`

## Expected report

```text
DevOps Report

Task: Retry P0 dev deploy gate
Environment: dev
Status: PASS / FAIL

Cloudflare auth:
- wrangler whoami: PASS/FAIL

Secrets:
- SERVICE_TOKEN: configured yes/no
- WEBHOOK_TOKEN: configured yes/no
- TELEGRAM_WEBHOOK_SECRET: configured yes/no
- ADMIN_TOKEN: configured yes/no
- TELEGRAM_BOT_TOKEN: configured yes/no
- TELEGRAM_CHAT_ID: configured yes/no

Deploy:
- npm.cmd run cf:deploy:dev: PASS/FAIL
- Worker version/id:

Telegram webhook:
- reset with secret_token: PASS/FAIL

Remote checks:
- GET /api/status:
- webhook missing secret:
- webhook wrong secret:
- webhook valid secret:
- external analyze valid service token:
- duplicate requestId:
- delivery.sendToTelegram=false:
- clear-logs with WEBHOOK_TOKEN:
- clear-logs with ADMIN_TOKEN:

Issues:
1.

Recommendation:
Ready / not ready for production gate.
```

## Manager decision rules

If this task passes:

- send remote dev result to Oleg for a short post-deploy QA confirmation if needed;
- then prepare production gate with D1 backup and rollback version.

If this task fails:

- keep production blocked;
- identify whether failure is auth, deploy, secret config, webhook setup or code behavior.
