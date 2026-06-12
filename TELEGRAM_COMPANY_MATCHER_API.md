# Telegram Company Matcher API Contract

This document defines how `telegram_company_matcher_app` should send news, country details, chatbot id and tickers to Stock Signal Scanner.

Stock Signal Scanner is the backend that receives tickers, runs technical analysis, sends Telegram messages, and returns a JSON result.

## Service Boundary

The default service mode is standard technical/signal analysis.

Do not send a command for ordinary ticker analysis:

```text
AAPL
AAPL, MSFT, NVDA
```

Both examples run ordinary technical/signal analysis. A special command is required only to select a different mode:

```text
FundRep AAPL
FundRep AAPL, MSFT
PromtRep AAPL
```

For API integrations, send raw ticker symbols in `ticker` or `tickers`. Do not wrap ordinary analysis in a command string. `FundRep` and `PromtRep` are Telegram command modes, not the default API format.

## Environments

### Dev

```text
POST https://stock-signal-scanner-dev.fnemoy.workers.dev/api/external/analyze
```

### Production

```text
POST https://stock-signal-scanner-production.fnemoy.workers.dev/api/external/analyze
```

Use dev for testing. Use production only after the format is verified.

## Authentication

Every request must include a webhook token.

Header option 1:

```http
X-Scanner-Token: YOUR_WEBHOOK_TOKEN
```

Header option 2:

```http
Authorization: Bearer YOUR_WEBHOOK_TOKEN
```

Required content type:

```http
Content-Type: application/json
```

## Message Order Requirement

When the request contains a news item, Stock Signal Scanner must send Telegram messages in this order:

1. News.
2. Tickers mentioned in that news.
3. Analysis for those tickers.
4. Signals for those tickers.

`telegram_company_matcher_app` should send one news item per request if strict ordering is important.

## Minimal Request

Use this format when there is no news context and only ticker analysis is needed.

```json
{
  "country": {
    "id": "us",
    "iso2": "US",
    "name": "United States"
  },
  "bot": {
    "id": "us-stocks-bot"
  },
  "telegramChatId": "123456789",
  "tickers": ["AAPL", "MSFT", "NVDA"],
  "source": "telegram_company_matcher_app"
}
```

## Unified Response Format

Every accepted analysis request returns a `requestId`. If the caller did not provide one, Stock Signal Scanner generates it.

The canonical result list is `items`. Each item has the same structure for API responses and Telegram-rendered reports:

```json
{
  "requestId": "generated-or-client-request-id",
  "items": [
    {
      "ticker": "AAPL",
      "status": "signal_found",
      "analysisType": "technical",
      "price": {
        "value": 210.25,
        "previousClose": 208.1,
        "change": 2.15,
        "changePercent": 1.03,
        "direction": "up"
      },
      "indicators": {
        "ema200": 190.4,
        "mma150": 195.2,
        "mma150DistancePercent": 7.71,
        "avwap": 201.3,
        "atr14": 4.2,
        "poc": 205.5,
        "rsi14": 58.4,
        "roc20": 6.2,
        "volume": 1234567
      },
      "signals": [
        {
          "strategy": "Trend Following",
          "side": "long",
          "condition": "price above EMA200 and AVWAP",
          "idea": "possible long",
          "risk": 1,
          "stop": 201.85,
          "target": 222.85,
          "explanation": "Why this signal was generated."
        }
      ],
      "fundamentalSummary": null,
      "dataSources": ["Yahoo Finance chart"],
      "errors": []
    }
  ]
}
```

Possible item statuses:

- `signal_found`
- `no_signal`
- `not_enough_data`
- `invalid_ticker`
- `data_provider_error`
- `partial_result`

Legacy fields such as `rows` and `errors` may still be present for compatibility, but new integrations should read `items`.

## Full Recommended Request

Use this format for daily country news digest items.

```json
{
  "requestId": "news-2026-05-27-us-001",
  "source": "telegram_company_matcher_app",
  "country": {
    "id": "us",
    "iso2": "US",
    "name": "United States",
    "marketCode": "US",
    "timezone": "America/New_York"
  },
  "bot": {
    "id": "us-stocks-bot",
    "username": "USStocksExampleBot",
    "displayName": "US Stocks Bot"
  },
  "telegramChatId": "123456789",
  "news": {
    "id": "news-us-001",
    "title": "Apple shares rise after new AI product announcement",
    "summary": "Apple gained after investors reacted positively to the company's AI roadmap.",
    "url": "https://example.com/apple-ai-news",
    "publishedAt": "2026-05-27T10:30:00Z",
    "source": "Reuters",
    "language": "en"
  },
  "tickers": [
    {
      "symbol": "AAPL",
      "companyName": "Apple Inc.",
      "exchange": "NASDAQ",
      "countryIso2": "US",
      "confidence": 0.96,
      "reason": "The news directly mentions Apple."
    },
    {
      "symbol": "MSFT",
      "companyName": "Microsoft Corporation",
      "exchange": "NASDAQ",
      "countryIso2": "US",
      "confidence": 0.72,
      "reason": "Microsoft is mentioned as an AI competitor."
    }
  ],
  "analysis": {
    "timeframe": "1d",
    "risk": 1,
    "anchorBars": 120,
    "strategies": ["trend", "momentum", "breakout", "volume_avwap"]
  },
  "delivery": {
    "sendToTelegram": true,
    "messageOrder": "news_then_analysis"
  }
}
```

## Required Fields

The current minimum required fields are:

```json
{
  "bot": { "id": "us-stocks-bot" },
  "telegramChatId": "123456789",
  "tickers": ["AAPL"]
}
```

For production news flow, these fields should also be sent:

- `requestId`
- `source`
- `country.id`
- `country.iso2`
- `country.name`
- `news.id`
- `news.title`
- `news.summary`
- `news.url`
- `news.publishedAt`
- `tickers[].symbol`
- `tickers[].companyName`
- `tickers[].confidence`

## Field Rules

### `requestId`

Unique id generated by `telegram_company_matcher_app`.

Purpose:

- idempotency;
- duplicate prevention;
- tracing logs across systems.

Example:

```text
news-2026-05-27-us-001
```

### `country.id`

Internal country id.

Recommended values for v1:

```text
us
il
```

### `country.iso2`

ISO country code.

Recommended values for v1:

```text
US
IL
```

### `bot.id`

Internal bot id. This tells Stock Signal Scanner which country bot/context this message belongs to.

Recommended values for v1:

```text
us-stocks-bot
israel-stocks-bot
```

### `telegramChatId`

Telegram chat id where Stock Signal Scanner should send the analysis.

For direct user delivery, this is the user's chat id with the country bot.

### `news`

One news item per request is recommended. This keeps message order simple and predictable.

### `tickers`

Can be either an array of strings:

```json
["AAPL", "MSFT"]
```

or an array of objects:

```json
[
  {
    "symbol": "AAPL",
    "companyName": "Apple Inc.",
    "confidence": 0.96
  }
]
```

### `analysis.timeframe`

Supported values:

```text
1m, 2m, 5m, 15m, 30m, 1h, 1d, 1wk
```

Default:

```text
1d
```

### `analysis.strategies`

Supported values:

```text
trend
breakout
volume_avwap
momentum
```

## Expected Response

Successful response:

```json
{
  "timestamp": "2026-05-27T10:35:00Z",
  "timeframe": "1d",
  "rows": [
    {
      "ticker": "AAPL",
      "price": 192.4,
      "previous_close": 190.2,
      "change": 2.2,
      "change_percent": 1.16,
      "direction": "up",
      "ema200": 187.2,
      "avwap": 190.1,
      "poc": 189.8,
      "rsi14": 61.5,
      "roc20": 4.2,
      "volume": 52100000,
      "signals": [
        {
          "ticker": "AAPL",
          "strategy": "Trend Following",
          "side": "long",
          "price": 192.4,
          "condition": "цена выше EMA200 и выше AVWAP",
          "idea": "возможный long",
          "stop": 187.5,
          "target": 201,
          "risk": 1,
          "message": "📈 Сигнал по AAPL..."
        }
      ]
    }
  ],
  "errors": [],
  "sent": [
    {
      "ticker": "ALL",
      "strategy": "Analysis report",
      "side": "report"
    }
  ]
}
```

Partial success:

```json
{
  "timestamp": "2026-05-27T10:35:00Z",
  "timeframe": "1d",
  "rows": [
    {
      "ticker": "AAPL",
      "price": 192.4,
      "signals": []
    }
  ],
  "errors": [
    {
      "ticker": "THISISVERYLONGTICKER",
      "error": "слишком длинный тикер, максимум 12 символов"
    }
  ]
}
```

Auth error:

```json
{
  "ok": false,
  "error": "Неверный Webhook/API token"
}
```

## Example Request From Node.js

```js
const response = await fetch("https://stock-signal-scanner-dev.fnemoy.workers.dev/api/external/analyze", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Scanner-Token": process.env.STOCK_SIGNAL_SCANNER_TOKEN,
  },
  body: JSON.stringify({
    requestId: "news-2026-05-27-us-001",
    source: "telegram_company_matcher_app",
    country: {
      id: "us",
      iso2: "US",
      name: "United States",
    },
    bot: {
      id: "us-stocks-bot",
    },
    telegramChatId: "123456789",
    news: {
      id: "news-us-001",
      title: "Apple shares rise after AI announcement",
      summary: "Apple shares moved higher after investors reacted to AI news.",
      url: "https://example.com/news",
      publishedAt: "2026-05-27T10:30:00Z",
      source: "Reuters",
    },
    tickers: [
      { symbol: "AAPL", companyName: "Apple Inc.", confidence: 0.96 },
      { symbol: "MSFT", companyName: "Microsoft Corporation", confidence: 0.72 },
    ],
    analysis: {
      timeframe: "1d",
      risk: 1,
      strategies: ["trend", "momentum"],
    },
  }),
});

const result = await response.json();
```

## Example Request From Python

```python
import os
import requests

url = "https://stock-signal-scanner-dev.fnemoy.workers.dev/api/external/analyze"
headers = {
    "Content-Type": "application/json",
    "X-Scanner-Token": os.environ["STOCK_SIGNAL_SCANNER_TOKEN"],
}
payload = {
    "requestId": "news-2026-05-27-us-001",
    "source": "telegram_company_matcher_app",
    "country": {"id": "us", "iso2": "US", "name": "United States"},
    "bot": {"id": "us-stocks-bot"},
    "telegramChatId": "123456789",
    "news": {
        "id": "news-us-001",
        "title": "Apple shares rise after AI announcement",
        "summary": "Apple shares moved higher after investors reacted to AI news.",
        "url": "https://example.com/news",
        "publishedAt": "2026-05-27T10:30:00Z",
        "source": "Reuters",
    },
    "tickers": [
        {"symbol": "AAPL", "companyName": "Apple Inc.", "confidence": 0.96},
        {"symbol": "MSFT", "companyName": "Microsoft Corporation", "confidence": 0.72},
    ],
    "analysis": {"timeframe": "1d", "risk": 1, "strategies": ["trend", "momentum"]},
}

response = requests.post(url, headers=headers, json=payload, timeout=30)
response.raise_for_status()
print(response.json())
```

## Idempotency And Duplicates

`telegram_company_matcher_app` should send a stable `requestId` for each news item.

Stock Signal Scanner will use it later to prevent duplicate delivery.

Recommended format:

```text
news-{date}-{countryIso2}-{sequence}
```

Example:

```text
news-2026-05-27-us-001
```

## Current Implementation Note

Cloudflare Worker accepts:

- `ticker`
- `tickers`
- `telegramChatId`
- `timeframe`
- `risk`
- `strategies`
- `country`
- `bot`
- `news`
- object-style `tickers[].symbol`
- `analysis.timeframe`
- `analysis.risk`
- `analysis.anchorBars`
- `analysis.strategies`
- `delivery.sendToTelegram`

When a request contains `news`, the Worker:

- stores `country`, `bot`, `news_items`, and `news_tickers` in D1 when the database binding is available;
- sends the Telegram news message first;
- sends the analysis report second;
- returns the same JSON analysis result with `requestId`, `country`, `bot`, and `news` echoed back for tracing.

Telegram bot token resolution:

1. `bot.tokenSecretName` if provided.
2. `TELEGRAM_BOT_TOKEN_<BOT_ID>` where non-alphanumeric characters in `bot.id` become `_`.
3. `TELEGRAM_BOT_TOKEN`.
