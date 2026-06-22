# Task for Oleg: QA regression for P0 security blockers

## Context

Grisha reported `P0 Security blockers` as `DONE`.

Manager verification:

- Worker syntax check passed.
- Contract/security smoke tests passed locally.

Oleg must independently verify the security behavior before Ilya treats this as deploy-ready.

## Scope

Test these endpoints:

- `POST /telegram/webhook`
- `POST /api/clear-logs`
- `POST /api/external/analyze`

## Test cases

### 1. Telegram webhook secret

Check:

- Missing `X-Telegram-Bot-Api-Secret-Token` returns `403`.
- Wrong `X-Telegram-Bot-Api-Secret-Token` returns `403`.
- Valid `X-Telegram-Bot-Api-Secret-Token` returns `{ ok: true }`.
- Secret is not accepted from request body.
- Secret value is not present in logs or response.

### 2. clear-logs admin protection

Check:

- `POST /api/clear-logs` with `WEBHOOK_TOKEN` returns `403`.
- `POST /api/clear-logs` with missing token returns `403`.
- `POST /api/clear-logs` with wrong admin token returns `403`.
- `POST /api/clear-logs` with valid `X-Admin-Token` returns `200`.
- `POST /api/clear-logs` with `Authorization: Bearer <ADMIN_TOKEN>` returns `200`.

### 3. external analyze service token

Check:

- `POST /api/external/analyze` with missing service token returns `403`.
- Wrong service token returns `403`.
- Valid header token returns contract validation or processed response.
- Token in body is rejected or ignored.
- Telegram token in payload is rejected.

### 4. Regression checks

Run:

```text
npm.cmd run test:worker-contract
```

Expected:

```text
All tests PASS
```

## Expected QA report

```text
QA Report

Task: P0 Security blockers
Status: PASS / FAIL

Checked:
- Telegram webhook secret
- clear-logs admin protection
- external analyze service token
- token in body rejected/ignored
- regression smoke

Findings:
1.

Command:
- npm.cmd run test:worker-contract

Recommendation:
Ready / not ready for Ilya dev deploy gate.
```

## Release impact

If QA fails, do not send to Ilya for production gate.

If QA passes, Ilya can proceed with Cloudflare dev configuration and remote gate.
