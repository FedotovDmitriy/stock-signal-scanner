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

Required secrets:

- `WEBHOOK_TOKEN` - token used by the Pages monitor and `telegram_company_matcher_app`.
- `TELEGRAM_BOT_TOKEN` - default Telegram bot token.
- `TELEGRAM_CHAT_ID` - optional default chat for tests and fallback delivery.

Optional per-bot secrets:

- `TELEGRAM_BOT_TOKEN_US_STOCKS_BOT` for `bot.id = "us-stocks-bot"`.
- `TELEGRAM_BOT_TOKEN_ISRAEL_STOCKS_BOT` for `bot.id = "israel-stocks-bot"`.

The Worker resolves Telegram token in this order: `bot.tokenSecretName`, then `TELEGRAM_BOT_TOKEN_<BOT_ID>`, then `TELEGRAM_BOT_TOKEN`.

For dev environment:

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put WEBHOOK_TOKEN
```

For production environment:

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN --env production
npx wrangler secret put TELEGRAM_CHAT_ID --env production
npx wrangler secret put WEBHOOK_TOKEN --env production
```

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
Invoke-RestMethod "https://api.telegram.org/bot$botToken/setWebhook?url=$workerUrl/telegram/webhook"
```

Production bot:

```powershell
$botToken = "PRODUCTION_TELEGRAM_BOT_TOKEN"
$workerUrl = "https://stock-signal-scanner-production.USERNAME.workers.dev"
Invoke-RestMethod "https://api.telegram.org/bot$botToken/setWebhook?url=$workerUrl/telegram/webhook"
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

- `FundRep` PDF and `PromtRep` PDF are not yet moved to Workers.
- Fundamental providers FMP/Polygon/Finnhub are not yet moved to Workers.

Next stages:

1. Add environment-specific Telegram bots: onboarding-dev, US-dev, Israel-dev, then production bots.
2. Add payment-provider integration.
3. Add premium report generation through a PDF service or separate rendering worker/service.
