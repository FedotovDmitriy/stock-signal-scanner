# DevOps Report

Task: P0 Security blockers
Environment: dev
Status: PASS
Date: 2026-06-22

## Summary

Remote dev Worker is online.
Remote D1 dev migration was applied successfully and required tables exist.
Required dev secrets were configured and valid-token checks passed.
Telegram webhook was reset with `TELEGRAM_WEBHOOK_SECRET`.
Dev P0 security gate is closed.

Production remains blocked until the same separation, secret setup, deployment, and health checks are completed for production.

## Secrets

- SERVICE_TOKEN: configured
- WEBHOOK_TOKEN: configured
- TELEGRAM_WEBHOOK_SECRET: configured
- ADMIN_TOKEN: configured
- TELEGRAM_BOT_TOKEN: configured; dev bot token was rotated after prior exposure
- TELEGRAM_CHAT_ID: configured

No secret values were printed or stored in this report.

## D1

- migration applied: yes
- required tables verified: yes
- `contract_results` exists: yes
- `analysis_tasks` exists: yes
- `analysis_cache` exists: yes
- `request_logs` exists: yes
- `ticker_request_logs` exists: yes

Latest table verification:

```text
analysis_cache
analysis_tasks
contract_results
request_logs
ticker_request_logs
```

## Deploy

- Worker deployed: yes
- deployed URL: `https://stock-signal-scanner-dev.fnemoy.workers.dev`
- known version ID: `11915ace-b689-48e1-9d42-260cea6e40c8`
- note: deploy was completed by operator outside the sandbox because local sandbox blocks Wrangler build parent-directory reads

## Local Verification

- `node --check cloudflare/worker.js`: PASS
- `npm.cmd run test:worker-contract`: PASS
- service token must be supplied in headers for `/api/external/analyze`: PASS
- duplicate `requestId`: PASS
- `delivery.sendToTelegram=false`: PASS
- Telegram webhook missing/wrong/valid secret: PASS
- `/api/clear-logs` requires admin token: PASS

## Remote Dev Health

- `GET /api/status`: PASS
- `POST /api/external/analyze` with missing token: PASS, returned 403
- `POST /api/external/analyze` with valid `SERVICE_TOKEN`: PASS, returned `status=processed`
- duplicate `requestId`: PASS, returned the same saved `requestId`, `taskId`, `fingerprint`, and `generatedAt`
- `delivery.sendToTelegram=false`: PASS, returned `sendToTelegram=false` and `delivered=false`
- `POST /telegram/webhook` with missing secret: PASS, returned 403
- `POST /telegram/webhook` with wrong secret: PASS, returned 403
- `POST /telegram/webhook` with valid `TELEGRAM_WEBHOOK_SECRET`: PASS, returned `{ "ok": true }`
- `POST /api/clear-logs` without admin token: PASS, returned 403
- `POST /api/clear-logs` with wrong scanner token: PASS, returned 403
- `POST /api/clear-logs` with valid `ADMIN_TOKEN`: PASS, returned `{ "ok": true, "logs": [] }`

## Issues

1. [P2] Dev deploy cannot be initiated from the sandbox because Wrangler build cannot read parent directories; operator-side deploy works.
2. [P3] Some signal text in API responses shows mojibake/encoding artifacts. This is not a DevOps gate blocker, but should be handled as a product/text quality bug.

## Rollback Risk

- Production deploy: not attempted
- Last known good Worker version: not fetched, production remains blocked
- Production D1 backup: not exported, production remains blocked
- Rollback command for production gate: `wrangler rollback --env production`
- Migration risk: dev migration used idempotent schema statements and D1 reported the import can be safely retried if it fails

## Recommendation

Dev is ready for the next gate.

Do not release production until production has separate secrets, production Telegram webhook reset, production D1 backup, production deploy, and the same production health checks completed successfully.
