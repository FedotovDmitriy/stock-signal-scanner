# Cloudflare deployment

Goal: the server side runs in Cloudflare, not on a local computer.

V1 Cloudflare architecture:

- Cloudflare Worker - HTTP API and Telegram webhooks.
- Cloudflare D1 - users, subscriptions, preferences, logs, analysis data.
- Telegram Bot API - sending messages and receiving webhook updates.
- Yahoo Finance chart endpoint - market candles for technical analysis.

The project uses one GitHub repository and two Cloudflare environments:

- `dev` - test Worker, test D1 database, test Telegram bots, test secrets.
- `production` - production Worker, production D1 database, production Telegram bots, production secrets.

## Supported endpoints

- `GET /` - service information.
- `GET /api/status` - environment, status and recent logs.
- `POST /api/external/analyze` - request from an external application.
- `POST /api/webhook/analyze` - alternative external webhook URL.
- `POST /api/test-telegram` - send a test Telegram message through Worker secrets.
- `POST /api/clear-logs` - clear monitoring request logs.
- `POST /telegram/webhook` - Telegram webhook.

## 1. Install tools

```powershell
cd C:\Users\fnemo\Desktop\Trade\stock-signal-scanner
npm install
```

## 2. Log in to Cloudflare

```powershell
npx wrangler login
```

## 3. Create D1 databases

Create dev database:

```powershell
npm run cf:d1:create:dev
```

Create production database:

```powershell
npm run cf:d1:create:production
```

Wrangler will return two `database_id` values. Put them in `wrangler.toml`:

```toml
database_name = "stock_signal_scanner_dev"
database_id = "DEV_DATABASE_ID"

[[env.production.d1_databases]]
database_name = "stock_signal_scanner_production"
database_id = "PRODUCTION_DATABASE_ID"
```

## 4. Create D1 tables

Dev:

```powershell
npm run cf:d1:migrate:dev
```

Production:

```powershell
npm run cf:d1:migrate:production
```

## 5. Secrets

For local development, create `.dev.vars` from `.dev.vars.example`.

You can add secrets from the Cloudflare dashboard UI:

1. Open Cloudflare Dashboard.
2. Go to Workers & Pages.
3. Open `stock-signal-scanner-dev` or `stock-signal-scanner-production`.
4. Open Settings -> Variables.
5. Add each value as a Secret, not as a plain text variable.

Required Worker settings (store token/secret values as Cloudflare secrets and URLs/key IDs as variables):

- `SERVICE_TOKEN` - preferred service token for `POST /api/external/analyze`.
- `WEBHOOK_TOKEN` - legacy scanner token and fallback service token.
- `CORE_HMAC_SECRET` - scanner-specific HMAC secret shared with Core; store only as a Cloudflare secret and use at least 32 random bytes.
- `CORE_HMAC_KEY_ID` - non-secret scanner signing key ID configured as an environment variable, with different values in dev and production.
- `CORE_SERVICE` - required Cloudflare service binding to the Core Worker. Scanner calls Core access/check and cache/commit only through this binding.
- `ACCESS_CHECK_URL` - optional non-secret Core access/check URL used only to preserve the signed canonical pathname/query. It is not used as a public HTTP transport.
- `MARKET_SIGNAL_AI_BOT_URL` - optional base URL alternative for canonical path construction only. It is not used as a public HTTP transport.
- `REPORT_GENERATION_VERSION` - optional report cache generation version; defaults to `1`. Change it when report-generation logic changes and old cached reports must not be reused.
- `DEFAULT_LANGUAGE` - optional language for direct Telegram commands; supports `ru`, `en`, and `he`, and defaults to `ru`. Contract requests use their upstream `language` value.
- `TELEGRAM_WEBHOOK_SECRET` - secret checked against Telegram `X-Telegram-Bot-Api-Secret-Token`.
- `TELEGRAM_BOT_TOKEN` - default Telegram bot token.
- `ADMIN_TOKEN` - admin token for monitoring/admin actions such as log cleanup.
- `TELEGRAM_CHAT_ID` - optional default chat for tests and fallback delivery.

Optional per-bot secrets:

- `TELEGRAM_BOT_TOKEN_US_STOCKS_BOT` for `bot.id = "us-stocks-bot"`.
- `TELEGRAM_BOT_TOKEN_ISRAEL_STOCKS_BOT` for `bot.id = "israel-stocks-bot"`.

The Worker resolves Telegram token in this order: `bot.tokenSecretName`, then `TELEGRAM_BOT_TOKEN_<BOT_ID>`, then `TELEGRAM_BOT_TOKEN`.

For dev environment:

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put SERVICE_TOKEN
npx wrangler secret put WEBHOOK_TOKEN
npx wrangler secret put CORE_HMAC_SECRET
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ADMIN_TOKEN
```

Add `CORE_HMAC_KEY_ID` as an environment variable and configure the `CORE_SERVICE` service binding in Cloudflare. `ACCESS_CHECK_URL` or `MARKET_SIGNAL_AI_BOT_URL` may remain as canonical path configuration, but Scanner does not use public HTTP fallback for Core. There is no access-check bypass: dev and production both fail closed when Core service binding, signing configuration, or Core itself is unavailable.

For production environment:

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN --env production
npx wrangler secret put TELEGRAM_CHAT_ID --env production
npx wrangler secret put SERVICE_TOKEN --env production
npx wrangler secret put WEBHOOK_TOKEN --env production
npx wrangler secret put CORE_HMAC_SECRET --env production
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --env production
npx wrangler secret put ADMIN_TOKEN --env production
```

Production must have `CORE_SERVICE`, `CORE_HMAC_KEY_ID`, and `CORE_HMAC_SECRET` configured. Scanner signs every access and cache-commit request with HMAC-SHA256 over `<timestamp>.<key_id>.<transport_request_id>.<method>.<pathname>.<canonical_query>.<sha256_raw_body>` and sends `X-Key-Id`, a unique transport `X-Request-Id`, `X-Timestamp`, and `X-Signature` through the service binding. Scanner never sends the HMAC secret as Bearer authorization and never falls back to public `fetch()` for Core in dev or production. If Core binding is missing, Core is unavailable, rejects HMAC, or returns an invalid response, `POST /api/external/analyze` fails closed before analysis, providers, cache commit, or Telegram.

Current repository config includes the dev `CORE_SERVICE` binding only. Production bindings are not inherited from dev and must be added separately by DevOps after Ilya confirms the real Core production Worker name.

Before `POST /api/internal/access/check`, scanner reads only local cache metadata and signs the real `cacheStatus`, `cacheCreatedAt`, and `cacheGenerationVersion` as part of the request body. These fields are diagnostic hints; Core alone decides billing and whether `reportSource=cache` is valid.

Allowed `new_*` and `refresh_*` decisions must contain a non-empty Core-issued `cacheReceiptId`. After a successful per-ticker analysis and local `analysis_cache` write, scanner computes SHA-256 over the exact stored JSON and calls HMAC-only `POST /api/internal/access/cache/commit` separately for every ticker. Commit retries use a new transport request ID and the same immutable receipt payload. Provider, analysis, or cache-write failures never commit. A commit failure is logged internally and does not discard or rerun the already paid successful report; because Core has no committed entry, scanner does not promise a future cache discount.

Regular technical reports and structured FundRep reports are cached in `analysis_cache` for 60 minutes. Cache keys isolate ticker, report type, language, and generation version. When Core returns `reportSource=cache`, scanner returns only the matching scanner-owned report and makes no Yahoo call. Missing or expired regular cache returns `cached_report_not_found`; missing or expired FundRep cache returns `fundrep_cache_not_found`. Both fail closed with HTTP 503 and never start a new paid analysis silently. An identical business replay (`requestId + ticker`) still calls Core with a new transport ID, requires `own_repeat`, returns the stored Scanner response, and does not repeat providers, Telegram, or cache commit.

`POST /api/external/analyze` with `reportType=fundrep` returns structured JSON with `analysisType=fundamental`, localized KPI summaries, risks, data sources, and `cacheStatus`. Supported cache statuses are `hit`, `miss`, `refreshed`, and `mixed`. `forceRefresh=true` bypasses scanner result and market-data caches, rebuilds FundRep, and replaces its cache entry. A contradictory access decision combining force refresh with `reportSource=cached_report` returns HTTP 503 with `invalid_access_decision`.

Supported contract languages are `ru`, `en`, and `he`. Regional and legacy aliases are normalized: `ru-RU` to `ru`, `en-US` to `en`, and `he-IL` or `iw` to `he`. If `language` is absent, contract `1.0` temporarily defaults to `ru` for backward compatibility. An unsupported value such as `pl` returns HTTP 400 with `status=rejected`, `field=language`, and `code=unsupported_language` before access, market-data, or Telegram calls.

Technical Telegram reports, signal explanations, market context, news labels, FundRep HTML, KPI summaries, and PromtRep prompts use one selected language per report. International ticker symbols and indicator names such as EMA200, RSI, AVWAP, and CAPE are not translated. Internal `requestId` values remain in API responses and logs but are not shown in user-facing messages.

Use different bot tokens and webhook tokens for dev and production.

## 6. Deploy

Deploy dev first:

```powershell
npm run cf:deploy:dev
```

Deploy production only after testing dev:

```powershell
npm run cf:deploy:production
```

Expected Worker URLs:

```text
https://stock-signal-scanner-dev.USERNAME.workers.dev
https://stock-signal-scanner-production.USERNAME.workers.dev
```

## 7. Deploy monitoring UI to Cloudflare Pages

The monitoring UI lives in:

```text
cloudflare/pages/index.html
```

Run it locally:

```powershell
npm run cf:pages:dev
```

Deploy dev Pages:

```powershell
npm run cf:pages:deploy:dev
```

Deploy production Pages:

```powershell
npm run cf:pages:deploy:production
```

After opening the Pages URL, fill in:

- Worker API URL, for example `https://stock-signal-scanner-dev.USERNAME.workers.dev`.
- `WEBHOOK_TOKEN` value.
- Optional Telegram Chat ID for the test message.
- Optional bot id, for example `us-stocks-bot`.

The Pages app does not store Telegram bot tokens. Telegram tokens stay in Worker secrets.

## 8. Connect Telegram webhook

Dev bot:

```powershell
$botToken = "DEV_TELEGRAM_BOT_TOKEN"
$workerUrl = "https://stock-signal-scanner-dev.USERNAME.workers.dev"
$telegramWebhookSecret = "DEV_TELEGRAM_WEBHOOK_SECRET"
Invoke-RestMethod `
  -Method Post `
  -Uri "https://api.telegram.org/bot$botToken/setWebhook" `
  -Body @{ url = "$workerUrl/telegram/webhook"; secret_token = $telegramWebhookSecret }
```

Production bot:

```powershell
$botToken = "PRODUCTION_TELEGRAM_BOT_TOKEN"
$workerUrl = "https://stock-signal-scanner-production.USERNAME.workers.dev"
$telegramWebhookSecret = "PRODUCTION_TELEGRAM_WEBHOOK_SECRET"
Invoke-RestMethod `
  -Method Post `
  -Uri "https://api.telegram.org/bot$botToken/setWebhook" `
  -Body @{ url = "$workerUrl/telegram/webhook"; secret_token = $telegramWebhookSecret }
```

Check webhook:

```powershell
Invoke-RestMethod "https://api.telegram.org/bot$botToken/getWebhookInfo"
```

## 9. External server request

Dev:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "https://stock-signal-scanner-dev.USERNAME.workers.dev/api/external/analyze" `
  -Headers @{ "X-Scanner-Token" = "DEV_WEBHOOK_TOKEN" } `
  -ContentType "application/json" `
  -Body '{"ticker":"AAPL"}'
```

Production:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "https://stock-signal-scanner-production.USERNAME.workers.dev/api/external/analyze" `
  -Headers @{ "X-Scanner-Token" = "PRODUCTION_WEBHOOK_TOKEN" } `
  -ContentType "application/json" `
  -Body '{"ticker":"AAPL"}'
```

List of tickers:

```json
{"tickers":"AAPL, MSFT, NVDA"}
```

One-request overrides:

```json
{
  "tickers": "AAPL, MSFT",
  "timeframe": "1d",
  "risk": 1,
  "strategies": ["trend", "momentum"]
}
```

`telegram_company_matcher_app` can send the full news payload with `country`, `bot`, `telegramChatId`, `news`, object-style `tickers`, and `analysis`. The Worker stores the news and ticker links in D1, sends the news first, then sends the analysis report.

## First-stage limitations

- FundRep PDF rendering is not implemented. The API returns structured JSON; localized FundRep HTML is created only as a Telegram document artifact.
- Fundamental providers FMP/Polygon/Finnhub are not yet moved to Workers.

Next stages:

1. Add environment-specific Telegram bots: onboarding-dev, US-dev, Israel-dev, then production bots.
2. Add payment-provider integration.
3. Add premium report generation through a PDF service or separate rendering worker/service.
