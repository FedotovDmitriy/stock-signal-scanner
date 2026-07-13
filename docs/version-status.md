# Stock Signal Scanner Version Status

Date: 2026-07-09
Owner: stock-signal-scanner Manager
Status: active

## Current Summary

`stock-signal-scanner` is being turned into a clean Analysis API for ticker analysis.

The service responsibility is:

- accept a ticker analysis request;
- validate the external contract payload;
- check access/quota through `market-signal-ai-bot`;
- run technical or FundRep analysis only after access is allowed;
- return a structured analysis response;
- optionally deliver a Telegram-ready report when requested by upstream.

The service must not own:

- users;
- subscriptions;
- billing;
- quota ledger;
- plan logic;
- user settings.

Those responsibilities belong to `market-signal-ai-bot`.

## Version Timeline

| Version | Status | Summary |
| --- | --- | --- |
| v1.0 | Done | Basic scanner behavior, ticker analysis, Telegram flow, initial Cloudflare Worker setup. |
| v1.1 | In progress / dev blocked | Strict Analysis API contract, security hardening, localization, quota/access integration, regular and FundRep cache, Core 1.1 HMAC access/commit flow. |
| v1.2 | Future | Pricing/credits tuning, UX improvements, analytics-based quota changes, possible whole-credit model if decimal units confuse users. |

## v1.1 Goal

Make scanner a production-ready analysis engine that receives a contract payload and returns a structured ticker analysis result.

The target flow:

```text
External service
  -> POST /api/external/analyze
  -> Scanner validates contract 1.0
  -> Scanner calls Core access/check contract 1.1 with HMAC
  -> Core returns allowed/rejected + quota/cache decision
  -> Scanner runs analysis only if allowed
  -> Scanner writes local analysis cache
  -> Scanner commits cache receipt to Core
  -> Scanner returns structured JSON response
```

## What Is Done

### API Contract

- `POST /api/external/analyze` exists as the main Analysis API endpoint.
- External contract version is `1.0`.
- Required payload validation is implemented:
  - `contractVersion`;
  - `requestId`;
  - non-empty `tickers`;
  - `country`;
  - `news`;
  - `analysis`;
  - `delivery`.
- Invalid payload returns structured rejected response.
- Wrong or missing scanner service token returns `403`.
- Forbidden business fields are rejected before analysis.
- Telegram tokens are forbidden in payload.

### Service Boundaries

- Scanner remains the analysis engine.
- User/subscription/quota ownership stays outside scanner.
- Quota/access decisions are delegated to `market-signal-ai-bot`.
- `telegram-company-matcher` remains responsible for news publishing and user-facing Telegram orchestration.

### Security

- `/telegram/webhook` requires Telegram webhook secret.
- `/api/clear-logs` requires admin token.
- `/api/external/analyze` accepts service token only from headers.
- Body tokens are rejected/ignored.
- Secrets must not appear in payload, logs, GitHub, task boards, or screenshots.

### Reports And Localization

- Reports no longer show `requestId` to users.
- Upstream language controls report language.
- Supported languages: `ru`, `en`, `he`.
- Unsupported language is rejected before external calls.
- Direct Telegram ticker commands default to Russian unless configured otherwise.
- RU/EN access/quota user wording is finalized.
- Raw scanner/access fields must not be rendered directly to users.

### Analysis Types

- `reportType=regular` is the regular technical/signal analysis.
- `reportType=fundrep` is the fundamental report flow.
- Structured FundRep API response is implemented.
- FundRep HTML is generated only for Telegram delivery, not returned as API body.

### Cache

- Regular reports are cached by:
  - ticker;
  - report type;
  - language;
  - generation version.
- FundRep cache is implemented with the same isolation direction.
- Cache TTL is 60 minutes.
- Cached report requests do not silently run new analysis if Core promised cache.
- Missing promised cache fails closed.

### Core Access / Quota Integration

- Scanner calls Core before provider/cache/Telegram analysis.
- Scanner uses Core contract `1.1` for access checks.
- Scanner-to-Core auth is HMAC-only.
- Bearer fallback and quota bypass were removed.
- Scanner sends signed cache hints.
- Core must return `cacheReceiptId` for new/refresh decisions.
- Scanner commits successful cached results through Core cache commit endpoint.
- Scanner computes SHA-256 digest for committed analysis result.
- Provider, analysis, and cache-write failures do not commit.
- Commit failure does not rerun analysis or hide an already produced report.

### Testing

Reported local contract smoke coverage includes:

- valid contract payload;
- missing contract fields;
- invalid ticker;
- auth failure;
- access allowed;
- access denied;
- Core unavailable;
- HMAC validation;
- cache receipt requirement;
- cache commit flow;
- commit retry;
- provider failure without commit;
- duplicate request behavior;
- FundRep cache scenarios;
- localization behavior;
- no user-facing `requestId`;
- no secret leakage in tested responses.

Latest developer report for HMAC/cache receipt flow reported:

```text
worker contract tests: 38/38 PASS
```

## Current Blocker

v1.1 dev E2E is blocked by Scanner -> Core signed access/check behavior.

Current observed behavior:

```text
Scanner calls:
POST https://market-signal-ai-bot-dev.fnemoy.workers.dev/api/internal/access/check

Scanner runtime path:
/api/internal/access/check

Trailing slash:
false

Scanner sees:
HTTP 404 from Core access/check

Scanner final response:
HTTP 503
status=failed
reason=Access check HTTP 404
```

Important evidence:

- Scanner incoming `SERVICE_TOKEN` auth is fixed.
- Wrong scanner token returns `403`.
- Valid scanner token is accepted.
- Scanner calls Core before analysis.
- Scanner does not call provider/cache/Telegram after Core failure.
- `delivery.sendToTelegram=false` does not send Telegram.
- Runtime `ACCESS_CHECK_URL` is correct.
- Runtime `CORE_HMAC_KEY_ID` is `scanner-dev-v2`.
- Scanner request has no trailing slash.
- Core direct unsigned request without trailing slash returns `401`, proving the route exists.
- Core direct unsigned trailing slash alias was requested and Core agreed to support it.
- In live-tail E2E, Core tail did not observe the signed Scanner request, while Scanner still saw `404`.

Latest known live-tail E2E:

```text
Environment: dev
scanner requestId: devops-live-tail-347cb617-95ac-4878-8e89-5aee0bb99b9b
Core active version: 73345693-a27c-4705-a6c5-1b703ac03d10
Scanner active version: 4cc85c26-4461-4aeb-ad20-afa15e786206
CORE_HMAC_KEY_ID: scanner-dev-v2
Core URL pathname: /api/internal/access/check
Query string: empty
Trailing slash: false
Core HTTP status seen by Scanner: 404
Scanner final status: HTTP 503, status=failed
Cache commit status: not reached
Final status: FAIL / Core tail did not observe the request
```

## Private Premium Analysis Mode Status

Task ID: `SCANNER-PRIVATE-PREMIUM-ANALYSIS-MODE`

Status: PASS for `/api/external/analyze` / production still blocked by Core E2E and QA

Private premium flow target:

```text
Core/private bot/site/API -> scanner -> Core/private response
```

Current result:

- scanner remains an analysis API and calls Core before contract analysis;
- scanner fails closed when Core fails or denies;
- scanner does not use subscription ownership as source of truth;
- cache receipt flow is implemented locally;
- remote E2E still cannot reach analysis/cache commit because Core access/check fails first.

Private premium API boundary now enforced:

- `/api/external/analyze` rejects `delivery.sendToTelegram=true`;
- `/api/external/analyze` rejects `bot.tokenSecretName`;
- `/api/external/analyze` returns JSON only;
- `/api/external/analyze` clears `chatId`;
- `/api/external/analyze` does not pass `chatId` to Core access/check;
- `/api/external/analyze` response has `telegram.sendToTelegram=false`, `delivered=false`, `chatId=null`;
- contract smoke tests pass.

Legacy separation note:

- scanner still has legacy Telegram routes such as `POST /telegram/webhook`, `/scan`, `/api/webhook/analyze`, and `/api/test-telegram`;
- those routes are not part of private premium flow;
- a later production decision is still needed: keep legacy only in dev, move to another service, or remove after Core/private bot flow is ready.

Completed change:

```text
For private premium requests, /api/external/analyze must be API-only:
- reject or ignore chatId;
- reject delivery.sendToTelegram=true;
- never call Telegram APIs;
- return structured JSON only.
```

Verification:

```text
npm.cmd run test:worker-contract -> PASS
40/40 contract smoke scenarios passed
```

Detailed report:

```text
docs/scanner-private-premium-analysis-mode-report.md
```

## What Needs To Be Done Next

Current task board for closing v1.1 and preparing v1.2:

```text
docs/v1.1-closeout-and-v1.2-transition-tasks.md
```

### P0 - Core Dev Deploy Confirmation

Owner: `market-signal-ai-bot` Core team

Core must deploy and confirm:

- `POST /api/internal/access/check` returns `401` without HMAC, not `404`;
- `POST /api/internal/access/check/` returns `401` without HMAC, not `404`;
- active key id for scanner dev is `scanner-dev-v2`;
- Core live version is reported;
- secrets are not exposed.

### P0 - Repeat Signed Dev E2E

Owner: Ilya

After Core confirms dev readiness, repeat signed E2E during live tail and report:

```text
environment:
scanner version:
scanner requestId:
actual method:
actual URL pathname:
key id:
Core response status:
Core response body without secrets:
analysis result:
cache commit result:
duplicate/own_repeat result:
checked_at:
result: PASS/FAIL
blockers:
```

Do not report:

- `SERVICE_TOKEN`;
- `CORE_HMAC_SECRET`;
- `X-Signature`;
- raw auth headers;
- Telegram tokens.

### P0 - QA After E2E PASS

Owner: Oleg

After Ilya reports dev E2E PASS, QA must verify:

- valid scanner token passes;
- wrong scanner token returns `403`;
- Core access check happens before analysis;
- denied Core decision blocks analysis;
- Core unavailable fails closed;
- new analysis runs only after allowed decision;
- cache commit is performed for new/refresh decisions;
- duplicate `requestId + ticker` does not rerun provider or Telegram;
- user-facing report does not expose internal access/cache fields;
- secrets do not appear in responses/logs.

### P0 - Production Gate

Owner: Ilya

Production remains blocked until all are true:

- Core production access endpoint exists;
- Core production key id and secret map are configured;
- Scanner production `CORE_HMAC_SECRET`, `CORE_HMAC_KEY_ID`, and access URL are configured;
- production D1 backup is exported;
- migrations are applied if needed;
- production Worker deploy is completed;
- rollback version is captured;
- production health checks pass;
- Telegram webhook production checks pass;
- Oleg QA is PASS;
- Roman and Lena pass required Core/security/integration reviews.

## Current Production Status

Production is blocked.

Do not deploy production automatically.

Production must wait for:

1. dev signed E2E PASS;
2. QA PASS;
3. Core production readiness;
4. DevOps production gate;
5. rollback plan confirmation.

## Accepted Quota Model For v1.1

```text
REGULAR_NEW = 1
REGULAR_CACHED = 0.5
REGULAR_REFRESH = 1

FUNDREP_NEW = 3
FUNDREP_CACHED = 1.5

OWN_REPEAT_WITHIN_1H = 0
CACHE_TTL = 1 hour
```

Rules:

- same user reopening the same fresh report within one hour should not pay again;
- another user receiving a fresh cached regular report pays discounted units;
- another user receiving a fresh cached FundRep pays discounted units;
- force refresh costs full price;
- technical Core errors cost `0 units`;
- pricing is owned by Core, not scanner.

## Possible v1.2 Items

- Decide whether decimal units are clear enough for users.
- Consider whole-credit model if `0.5 unit` creates confusion.
- Improve usage analytics by report type, cache status, charge units, language, tariff, and failure reason.
- Refine user-facing copy after first user feedback.
- Add richer UI presentation for technical and FundRep results without exposing internal API fields.

## Team Ownership

| Area | Owner |
| --- | --- |
| Scanner API/code | Grisha |
| Scanner QA/regression | Oleg |
| Scanner Cloudflare/dev/prod gate | Ilya |
| Telegram/access wording | Masha |
| Quota/pricing/product economics | Anna |
| Users/subscriptions/quota ledger | market-signal-ai-bot/Core |
| News/user-facing Telegram orchestration | telegram-company-matcher |

## Manager Decision

Current release decision:

```text
v1.1 is not production-ready yet.
Continue dev E2E work.
Do not deploy production.
Next blocking owner: Core + Ilya live signed E2E.
```
