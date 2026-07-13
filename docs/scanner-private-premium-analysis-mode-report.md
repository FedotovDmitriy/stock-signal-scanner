# Scanner Private Premium Analysis Mode Report

Task ID: SCANNER-PRIVATE-PREMIUM-ANALYSIS-MODE
Date: 2026-07-09
Environment: code review / dev readiness
Scanner version: latest local commit `f07bd0f`; latest reported dev Worker version `4cc85c26-4461-4aeb-ad20-afa15e786206`
Core URL: `https://market-signal-ai-bot-dev.fnemoy.workers.dev/api/internal/access/check`
Result: PASS for `/api/external/analyze` private premium boundary / production still blocked by Core E2E and QA

## Goal

Confirm that scanner remains a ticker analysis service and does not participate in Telegram-channel broadcast or subscription management.

Target private premium flow:

```text
Core/private bot/site/API
  -> scanner
  -> Core/private response
```

The personal analysis result must not be published to a shared Telegram broadcast channel.

## Update - Grisha Implementation Review - 2026-07-09

Developer report:

```text
Task: SCANNER-P0-PRIVATE-API-ONLY-BOUNDARY
Status: DONE
```

Manager verification:

```text
npm.cmd run test:worker-contract -> PASS
40/40 contract smoke scenarios passed
```

Confirmed in code/tests:

- `delivery.sendToTelegram=true` in `/api/external/analyze` is rejected with `400`, `status=rejected`, `field=delivery.sendToTelegram`, `code=telegram_delivery_not_allowed`.
- `bot.tokenSecretName` is rejected in the private premium API.
- Contract API response always reports `telegram.sendToTelegram=false`, `delivered=false`, `chatId=null`.
- Contract API clears `chatId` before ticker request logging.
- Contract API no longer passes `chatId` to Core access/check.
- Contract API does not call Telegram fetch when analysis is requested.
- Legacy Telegram paths remain separate.

Current decision:

```text
The private premium boundary is accepted for /api/external/analyze.
Legacy Telegram routes are not part of private premium flow and remain a separate follow-up decision.
Production remains blocked by remote Core signed E2E and QA gate.
```

## Findings

### 1. Scanner Analysis Boundary

Status: PASS

Scanner is still primarily an analysis service:

- external Analysis API endpoint: `POST /api/external/analyze`;
- contract validation exists;
- regular technical analysis exists;
- FundRep fundamental analysis exists;
- Core access/check is called before provider analysis in the contract path;
- scanner rejects subscription/billing/quota fields in the external payload.

### 2. Core Permission Before Analysis

Status: PASS locally / BLOCKED in remote dev E2E

Scanner contract flow calls Core before provider analysis:

```text
POST /api/internal/access/check
```

If Core returns denied or fails, scanner returns a failed/rejected contract response and does not run provider analysis.

Current remote blocker remains the Core access/check E2E issue:

```text
Scanner sees Access check HTTP 404 from Core.
Scanner fails closed before analysis.
Cache commit is not reached.
```

### 3. Cache Receipt Flow

Status: PASS locally / NOT REACHED in remote dev E2E

Implemented flow:

```text
access/check -> analysis -> local cache write -> access/cache/commit
```

Cache commit is performed only after successful analysis/cache write and only when Core returns a receipt for new/refresh decisions.

Remote dev E2E has not reached commit because Core access/check currently fails before analysis.

### 4. Subscription/Billing Ownership

Status: PASS for worker logic / SCHEMA LEGACY NOTE

Scanner worker rejects forbidden business fields in incoming payload:

- `quota`;
- `quotaBalance`;
- `quotaDecision`;
- `chargeUnits`;
- `remainingUnits`;
- `tariff`;
- `tariffPlan`;
- `subscription`;
- `subscriptionState`;
- `userBalance`;
- `balance`;
- `billingLedger`.

Scanner worker does not use subscription ownership or billing ledger as source of truth.

Note: `cloudflare/schema.sql` still contains legacy subscription-related tables. The current worker code does not use them for access decisions. This should be cleaned up or explicitly marked legacy later to avoid architectural confusion.

### 5. Telegram Direct Input Boundary

Status: LEGACY / OUTSIDE PRIVATE PREMIUM FLOW

Scanner still exposes and handles direct Telegram input:

```text
POST /telegram/webhook
```

The webhook accepts Telegram updates after `TELEGRAM_WEBHOOK_SECRET` verification and can parse ticker commands directly from Telegram messages.

This means scanner still has legacy Telegram capability, but it is now separated from the private premium `/api/external/analyze` flow.

Legacy capability does not satisfy a future "no Telegram in scanner production" target:

```text
scanner does not accept user tickers from shared Telegram channels directly
```

Scanner does not currently distinguish private chat, group, supergroup, or channel chat types in the analysis boundary.

### 6. Telegram Delivery Boundary

Status: PASS for `/api/external/analyze` / LEGACY elsewhere

Scanner can still send Telegram messages in legacy paths:

- contract path if `chatId` exists and `delivery.sendToTelegram=true`;
- legacy `/scan` or `/api/webhook/analyze` path;
- `/api/test-telegram`;
- direct Telegram bot command path;
- FundRep Telegram document delivery path.

The code uses Telegram send APIs:

```text
sendMessage
sendDocument
```

For `/api/external/analyze`, Grisha's change now enforces API-only behavior.

For a broader future target, legacy paths still do not satisfy:

```text
scanner does not send Telegram messages
scanner does not publish personal analysis to a shared channel
Telegram delivery ownership: Core only
```

Current behavior is safer when upstream sends:

```json
{
  "delivery": {
    "sendToTelegram": false
  }
}
```

But the boundary is not enforced by scanner for private premium mode.

### 7. Telegram Token / Raw Chat ID Handling

Status: PASS for `/api/external/analyze` / LEGACY elsewhere

Scanner does not accept Telegram tokens in payload. That is good.

However legacy scanner paths still use Telegram bot tokens from Cloudflare secrets:

- `TELEGRAM_BOT_TOKEN`;
- bot-specific token secret names such as `TELEGRAM_BOT_TOKEN_US_STOCKS_BOT`.

Legacy flows may still store/log raw `chatId` in ticker request logs:

```text
ticker_request_logs.chat_id
```

For `/api/external/analyze`, chatId is now cleared. For the broader future target, legacy paths still do not satisfy:

```text
scanner does not store/use Telegram bot token
scanner does not store/use raw channel chatId
```

## Acceptance Criteria Status

| Acceptance Criteria | Status | Comment |
| --- | --- | --- |
| scanner does analysis only after Core `allowed=true` | PASS locally / remote E2E blocked | Contract path calls Core first and fails closed. |
| scanner fail-closed on Core error/deny | PASS | Observed remote dev fail-closed on Core 404. |
| scanner does not know subscription source of truth | PASS | Worker rejects subscription/billing fields and relies on Core. |
| scanner does not send Telegram messages | PASS for `/api/external/analyze` | Legacy Telegram routes still exist separately. |
| scanner does not publish personal analysis to shared channel | PASS for `/api/external/analyze` | Contract API now rejects Telegram delivery and clears chatId. |
| cache commit works after successful analysis | PASS locally / remote not reached | Remote blocked before analysis. |
| E2E private analysis ready after Core private bot flow | PARTIAL | API-only boundary is ready; remote Core E2E remains blocked. |

## Required Changes

### P0 - Add Private Analysis Mode To Contract

Owner: Grisha

Status: DONE for current contract behavior

Add a contract-level mode that enforces API-only/private response behavior.

Recommended fields:

```json
{
  "delivery": {
    "mode": "api_only",
    "sendToTelegram": false
  }
}
```

Rules:

- for private premium requests, scanner must ignore/reject `chatId`;
- scanner must reject `delivery.sendToTelegram=true`;
- scanner must not call Telegram APIs;
- scanner response must return JSON only.

### P0 - Disable Telegram Delivery For `/api/external/analyze`

Owner: Grisha

Status: DONE

For the premium/private Analysis API, enforce:

```text
delivery.sendToTelegram=false
```

If upstream sends `sendToTelegram=true`, scanner should either:

1. reject the payload with `400 status=rejected`, or
2. override to `false` and return `telegram.sendToTelegram=false`.

Recommended decision: reject with a clear contract error so upstream fixes ownership.

### P0 - Move Telegram Delivery Ownership To Core/Private Bot

Owner: Core/private bot team

Status: READY FOR E2E after Core signed access/check is unblocked

Core/private bot/site/API should own:

- user chat destination;
- private response delivery;
- channel/broadcast rules;
- user subscription state;
- quota display;
- user-facing delivery wording.

Scanner should return structured JSON only for private premium flow.

### P1 - Legacy Telegram Scanner Path Decision

Owner: Manager + Grisha + Ilya

Decide what to do with existing scanner Telegram features:

- `/telegram/webhook`;
- direct ticker messages to `@Stock_Signal_Scanner_bot`;
- `/api/test-telegram`;
- legacy `/scan` Telegram delivery.

Options:

1. Keep as internal/dev legacy only and disable in production.
2. Move to a separate service.
3. Remove after Core/private bot flow is ready.

Recommended for private premium architecture:

```text
Production scanner should not own Telegram delivery.
Keep Telegram paths only in dev until replacement is complete.
```

### P1 - Raw Chat ID Storage

Owner: Grisha

Status: DONE for `/api/external/analyze`; still legacy follow-up for Telegram routes

For private premium requests:

- do not store raw channel chat IDs in scanner logs;
- if a correlation field is needed, store a non-sensitive upstream request ID instead;
- keep user/chat identity in Core/private bot.

## Report

```text
Task ID: SCANNER-PRIVATE-PREMIUM-ANALYSIS-MODE
Environment: code review / dev
Scanner version: latest local commit f07bd0f; latest reported dev Worker 4cc85c26-4461-4aeb-ad20-afa15e786206
Core URL: https://market-signal-ai-bot-dev.fnemoy.workers.dev/api/internal/access/check
Access check status: PASS locally; remote dev E2E blocked by Core 404
Cache commit status: PASS locally; not reached remotely
Fail-closed status: PASS
Telegram delivery ownership: PASS for /api/external/analyze; legacy scanner Telegram routes remain separate
Secrets exposed: no
Result: PASS for private premium API boundary / remote E2E still blocked
Blockers:
1. Remote Core signed E2E is still blocked before analysis/cache commit.
2. Legacy Telegram routes remain a separate product/production decision.
```

## Manager Decision

Scanner `/api/external/analyze` is ready for private premium API-only mode at code/test level.

The next implementation task should be:

```text
Run QA and remote signed E2E after Core access/check is stable.
```

Production release remains blocked.
