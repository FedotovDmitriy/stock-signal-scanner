# Задание для Гриши: сделать scanner чистым Analysis API

## Решение менеджера

`stock-signal-scanner` должен стать чистым `analysis API`.

Scanner не занимается пользователями, подписками, тарифами, странами, watchlist или бизнес-логикой доступа. Он принимает валидный service request, проверяет контракт, проверяет service token, при необходимости спрашивает лимиты у `market-signal-ai-bot`, выполняет анализ тикеров и возвращает структурированный отчёт.

## Цель

Сделать `POST /api/external/analyze` стабильным API для анализа тикеров с contract payload, idempotency, структурированным response и внешней проверкой тарифных лимитов.

---

## Что уже частично закрыто

В текущем Worker уже есть базовые элементы:

- contract version `1.0`;
- runtime validation;
- API/service token через `WEBHOOK_TOKEN`;
- idempotency по `requestId`;
- structured response;
- запрет Telegram token в payload;
- локальные smoke tests.

Грише нужно проверить, довести до production-quality и добавить недостающую интеграцию с `market-signal-ai-bot`.

---

## Задание 1. Зафиксировать scanner как Analysis API

### Что сделать

Переименовать в документации и кодовых комментариях смысл сервиса:

- не bot backend;
- не subscription service;
- не user management service;
- не country/news preference service;
- а `analysis API`.

### Требования

Scanner должен:

- принимать request на анализ;
- валидировать payload;
- выполнять анализ;
- возвращать structured report.

Scanner не должен:

- хранить пользователей;
- принимать решения по подпискам;
- считать тарифы самостоятельно;
- хранить тарифные планы;
- управлять payment/subscription lifecycle.

### Acceptance criteria

- В новых изменениях нет логики подписок и пользователей внутри scanner.
- Вся бизнес-логика доступа вынесена наружу, в `market-signal-ai-bot`.

---

## Задание 2. Строгий API contract

### Endpoint

```text
POST /api/external/analyze
```

### Required payload

```json
{
  "contractVersion": "1.0",
  "requestId": "string",
  "serviceClientId": "string",
  "tickers": ["AAPL"],
  "country": {},
  "news": {},
  "analysis": {},
  "delivery": {}
}
```

### Runtime validation

Проверять:

- `contractVersion` обязателен и равен `"1.0"`;
- `requestId` обязателен;
- `tickers` обязателен и не пустой;
- каждый ticker должен соответствовать формату scanner;
- `country` обязателен;
- `news` обязателен;
- `analysis` обязателен;
- `delivery` обязателен;
- Telegram tokens запрещены в payload.

### Rejected response

```json
{
  "contractVersion": "1.0",
  "requestId": "string | null",
  "status": "rejected",
  "errors": []
}
```

---

## Задание 3. API key / service token

### Что сделать

Scanner должен принимать запросы только от доверенных сервисов.

Поддержать:

- `Authorization: Bearer <SERVICE_TOKEN>`;
- или `X-Scanner-Token: <SERVICE_TOKEN>`.

### Важно

Это service-to-service token, не user token.

Scanner не должен принимать:

- Telegram token;
- user token;
- subscription token;
- payment token.

### Acceptance criteria

- Без token endpoint возвращает `403`.
- С неверным token endpoint возвращает `403`.
- С верным service token endpoint продолжает validation payload.

---

## Задание 4. Idempotency по `requestId`

### Что сделать

Если `requestId` уже обработан:

- не выполнять анализ повторно;
- не отправлять Telegram повторно;
- вернуть сохранённый response.

### Хранение

Использовать D1 table:

```text
contract_results
```

### Acceptance criteria

- Первый request выполняет анализ.
- Второй request с тем же `requestId` возвращает старый response.
- Duplicate request не вызывает повторный fetch market data.
- Duplicate request не вызывает повторную Telegram delivery.

---

## Задание 5. Структурированный отчёт

### Response contract

```json
{
  "contractVersion": "1.0",
  "requestId": "string",
  "status": "processed | rejected | failed",
  "report": {
    "analysisType": "technical | fundamental",
    "timeframe": "1d",
    "risk": 1,
    "anchorBars": 120,
    "strategies": ["trend", "breakout", "volume_avwap", "momentum"],
    "tickers": ["AAPL"],
    "rows": [],
    "items": [],
    "signalCount": 0,
    "generatedAt": "ISO datetime"
  },
  "telegram": {
    "sendToTelegram": false,
    "delivered": false,
    "chatId": null
  },
  "errors": []
}
```

### Final formats

- `risk`: positive number, percent risk per trade.
- `anchorBars`: positive integer.
- `strategies`: only:
  - `trend`;
  - `breakout`;
  - `volume_avwap`;
  - `momentum`.

---

## Задание 6. Лимиты через `market-signal-ai-bot`

### Решение

Scanner не проверяет подписки и пользователей сам.

Перед выполнением анализа scanner должен спросить `market-signal-ai-bot`, можно ли выполнить request.

### Новый env

Добавить env/secrets:

```text
MARKET_SIGNAL_AI_BOT_URL
MARKET_SIGNAL_AI_BOT_TOKEN
```

### Proposed quota check request

Scanner отправляет в `market-signal-ai-bot`:

```json
{
  "contractVersion": "1.0",
  "requestId": "string",
  "serviceClientId": "string",
  "operation": "ticker_analysis",
  "tickers": ["AAPL"],
  "analysisType": "technical",
  "estimatedUnits": 1
}
```

### Proposed quota check response

```json
{
  "allowed": true,
  "reason": null,
  "plan": "pro",
  "remaining": 123,
  "resetAt": "ISO datetime"
}
```

Если лимит превышен:

```json
{
  "allowed": false,
  "reason": "quota_exceeded",
  "plan": "free",
  "remaining": 0,
  "resetAt": "ISO datetime"
}
```

### Scanner behavior

Если `allowed: true`:

- продолжить анализ.

Если `allowed: false`:

- не выполнять анализ;
- не вызывать market data providers;
- не отправлять Telegram;
- вернуть `rejected`.

Suggested response:

```json
{
  "contractVersion": "1.0",
  "requestId": "string",
  "status": "rejected",
  "errors": [
    {
      "field": "quota",
      "code": "quota_exceeded",
      "message": "Analysis quota exceeded"
    }
  ]
}
```

### Вопросы, которые нужно подтвердить у владельца `market-signal-ai-bot`

1. Какой exact endpoint для quota check?
2. Какой auth header использовать?
3. Что является `serviceClientId`?
4. Как считать `estimatedUnits`:
   - 1 unit per ticker?
   - больше units за `FundRep`?
5. Нужно ли после успешного анализа делать usage commit?
6. Что делать, если `market-signal-ai-bot` недоступен:
   - fail-closed;
   - или временно allow для dev?

### Acceptance criteria

- Scanner вызывает quota check до анализа.
- При denied quota анализ не запускается.
- При unavailable quota service production ведёт себя fail-closed.
- Для dev можно разрешить bypass только через явный env, например `BYPASS_QUOTA_CHECK=true`.
- Tests покрывают allowed/denied/unavailable.

---

## Задание 7. Не заниматься подписками и пользователями внутри scanner

### Что удалить/не развивать

Не добавлять в scanner:

- subscription checks;
- user profile;
- watchlist;
- country preferences;
- topic preferences;
- payment logic;
- plan calculation.

### Что допустимо хранить

Scanner может хранить только технические данные:

- request logs;
- contract result by `requestId`;
- analysis tasks;
- analysis cache;
- provider errors;
- delivery status.

---

## Тесты

Добавить/обновить tests:

- valid contract payload;
- missing contractVersion;
- wrong ticker format;
- duplicate requestId;
- scanner response format;
- delivery.sendToTelegram=false;
- missing service token;
- wrong service token;
- quota allowed;
- quota denied;
- quota service unavailable;
- Telegram token in payload rejected.

## Definition of Done

Готово, если:

- `POST /api/external/analyze` работает как Analysis API;
- scanner не содержит новой user/subscription логики;
- quota проверяется через `market-signal-ai-bot`;
- idempotency работает;
- structured response стабилен;
- tests проходят;
- Илья может проверить deploy/security gate;
- QA может пройти regression без дополнительных уточнений.
