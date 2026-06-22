# Incident: @Stock_Signal_Scanner_bot does not return analysis

## Report

User reports:

```text
из @Stock_Signal_Scanner_bot посылаю тикер и не получаю анализ
```

Date: 2026-06-22

## Current manager assessment

This is a runtime incident, not a confirmed scanner logic bug yet.

Most likely causes, in priority order:

1. Production Worker is not updated yet.
   - Dev gate is PASS.
   - Production gate was explicitly not completed.
   - If `@Stock_Signal_Scanner_bot` points to production, it may still run old or mismatched behavior.

2. Telegram webhook for `@Stock_Signal_Scanner_bot` is not reset with `secret_token`.
   - Current Worker requires `X-Telegram-Bot-Api-Secret-Token`.
   - Telegram sends that header only if webhook was set with `secret_token`.

3. Webhook points to wrong Worker URL.
   - Bot may be connected to dev/prod/old Worker URL.

4. Missing or wrong production secrets.
   - `TELEGRAM_WEBHOOK_SECRET`
   - `TELEGRAM_BOT_TOKEN`
   - `SERVICE_TOKEN`
   - `ADMIN_TOKEN`

5. Access list blocks the user/chat.
   - Code checks `allowed_users` and `allowed_chats`.
   - If either table has entries, only listed users/chats pass.
   - Expected bot reply in that case: access denied message.

6. Telegram send fails after analysis.
   - Update may be received, analysis may run, but `sendTelegram` can fail if bot token is wrong.

## Immediate checks for Ilya

Owner: Ilya
Priority: P0 incident

### 1. Identify bot webhook

Check webhook info for `@Stock_Signal_Scanner_bot` token:

```text
getWebhookInfo
```

Report:

- webhook URL;
- whether it points to dev or production Worker;
- whether `has_custom_certificate` or pending errors exist;
- `last_error_message`;
- `pending_update_count`;
- do not print token.

### 2. Verify webhook secret setup

Confirm webhook was set with:

```text
secret_token = TELEGRAM_WEBHOOK_SECRET
```

If not, reset webhook.

### 3. Verify target Worker health

For the exact Worker URL from webhook:

- `GET /api/status`
- confirm environment: `dev` or `production`;
- confirm this is expected for `@Stock_Signal_Scanner_bot`.

### 4. Verify Telegram webhook endpoint behavior

For the exact Worker URL:

- `POST /telegram/webhook` missing secret -> expect `403`;
- wrong secret -> expect `403`;
- valid secret -> expect `200`.

### 5. Check request logs

Check latest logs after user sends ticker:

- `request_logs`;
- `ticker_request_logs`;
- Worker logs if available.

Look for:

- `Telegram access denied`;
- `Telegram analysis started`;
- provider errors;
- sendTelegram errors.

### 6. Verify access list

Check:

- whether `allowed_users` has entries;
- whether `allowed_chats` has entries;
- whether user's Telegram user id or chat id is allowed.

If access list is enabled and user is missing, add user/chat or clear allowlist policy deliberately.

## Checks for Grisha

Owner: Grisha
Priority: P1 unless Ilya finds code error

Grisha should verify:

1. `handleTelegramUpdate` flow for plain ticker:
   - `AAPL` -> `parseTelegramText` -> `runAnalysisOrchestrator` -> `sendTelegram`.

2. Error visibility:
   - If analysis fails, user should receive an error/partial report.
   - Silent failures should be logged and visible.

3. Access denied UX:
   - If user/chat is not allowed, message should be clear.

4. Add incident smoke test if missing:
   - Telegram update with valid secret and ticker returns `{ ok: true }`;
   - waitUntil handler sends analysis message;
   - denied user gets access denied message.

## Checks for Oleg

Owner: Oleg
Priority: after Ilya confirms target environment

Oleg should run a real-user scenario:

1. Send `AAPL` to `@Stock_Signal_Scanner_bot`.
2. Confirm bot returns analysis.
3. Send invalid ticker.
4. Confirm bot returns validation/error response.
5. Send `FundRep AAPL`.
6. Confirm fundamental flow starts or returns expected response.

## Manager decision

Do not debug random scanner logic first.

First determine where `@Stock_Signal_Scanner_bot` points:

- dev Worker;
- production Worker;
- old Worker;
- wrong URL;
- missing secret token.

Production remains blocked unless production gate has passed.

## Expected Ilya incident report

```text
Incident Report

Bot: @Stock_Signal_Scanner_bot
Status: RESOLVED / NOT RESOLVED

Webhook:
- URL:
- environment:
- pending_update_count:
- last_error_message:
- secret_token configured: yes/no

Worker health:
- GET /api/status:
- webhook missing secret:
- webhook wrong secret:
- webhook valid secret:

Logs after user ticker:
- update received: yes/no
- access allowed: yes/no
- analysis started: yes/no
- Telegram response sent: yes/no
- error:

Root cause:

Fix applied:

Next owner:
```

## 2026-06-22 Ilya dev check update

Ilya report:

```text
Dev Telegram webhook check: PASS
Bot: @Stock_Signal_Scanner_bot
Worker: https://stock-signal-scanner-dev.fnemoy.workers.dev
Telegram update received: PASS
tickerLogs source=telegram: PASS
AAPL parsed: PASS
analysis started: PASS
analysis completed: PASS
errors=0: PASS
report delivered to Telegram: PASS
```

Key evidence:

```text
Telegram analysis / AAPL / started
Telegram analysis / AAPL / ok
requestId=9e1c220d-2d40-4ddc-bb75-601401b357e6
orchestrator status=completed
response_ms=1659
signal_count=2
errors=0
```

Observed Telegram identity:

```text
username: @feddmi
user_id: 993841366
chat_id: 993841366
```

Allowlist:

```text
allowed_users: 0
allowed_chats: 0
```

Manager interpretation:

- Dev Worker receives the update.
- Plain ticker parsing works.
- Analysis runs successfully.
- Telegram delivery is reported as successful.
- Allowlist is not blocking.

Current status:

```text
Backend/dev incident: resolved
User-visible issue: needs confirmation
```

Remaining checks:

1. Confirm the user is looking at the same Telegram chat/user id `993841366`.
2. Confirm the report did not arrive delayed or in another bot/chat.
3. If the user still cannot see the message, ask Oleg to run a real-user verification from a second Telegram account/device.

## 2026-06-22 UX issue: Telegram report language and requestId

User showed the delivered Telegram report.

Observed issues:

1. User-facing Telegram report included internal `requestId`.
2. `Почему` explanation mixed Russian and Hebrew.

Manager decision:

- Do not show `requestId` in user-facing Telegram analysis messages.
- Keep `requestId` in API/contract responses and logs.
- Telegram analysis report for this bot must be one language. Current user language: Russian.

Fix applied:

- Removed trailing `requestId:` from `analysisReportMessage()`.
- Changed `marketContext()` from Hebrew text to Russian text.
- Added smoke assertion that Telegram report does not include `requestId:` and does not contain Hebrew characters.

Verification:

```text
node --check cloudflare/worker.js — PASS
npm.cmd run test:worker-contract — PASS
```
