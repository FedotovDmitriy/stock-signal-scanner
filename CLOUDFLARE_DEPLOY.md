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

## 7. Connect Telegram webhook

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

## 8. External server request

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

## First-stage limitations

- `FundRep` PDF and `PromtRep` PDF are not yet moved to Workers.
- Fundamental providers FMP/Polygon/Finnhub are not yet moved to Workers.
- Monitoring UI is not yet moved to Cloudflare Pages.

Next stages:

1. Add environment-specific Telegram bots: onboarding-dev, US-dev, Israel-dev, then production bots.
2. Move monitoring UI to Cloudflare Pages.
3. Add payment-provider integration.
4. Add premium report generation through a PDF service or separate rendering worker/service.
