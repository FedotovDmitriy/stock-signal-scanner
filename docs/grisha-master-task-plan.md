# Master task plan для Гриши

## Роль Гриши

Гриша отвечает за backend-разработку `stock-signal-scanner` как чистого `Analysis API`.

Главная цель: scanner должен принимать contract payload, проверять service token, валидировать request, проверять лимиты через `market-signal-ai-bot`, выполнять анализ тикеров и возвращать структурированный report. Scanner не занимается подписками, пользователями, тарифами и бизнес-логикой доступа.

## Правило управления комментариями Гриши

Каждый комментарий, отчёт, вопрос или замечание от Гриши должен быть зафиксирован.

Формат фиксации:

```text
Grisha Comment Log

Date:
Topic:
Comment from Grisha:
Manager interpretation:
Decision:
Action required:
Owner:
Priority:
Follow-up task:
Status:
```

После каждого комментария Гриши менеджер должен:

1. Прокомментировать, что означает замечание.
2. Решить: это blocker, improvement, question или no-action.
3. Если нужно, создать задачу для:
   - Олега, если нужна проверка/QA/regression;
   - Ильи, если нужен deploy/secrets/D1/Cloudflare/security gate;
   - Маши, если нужен UX текста, Telegram message format, документация или визуализация.
4. Обновить статус задачи.

---

## Приоритеты выполнения

### P0. Security и production blockers

Эти задачи блокируют production.

#### P0.1 Защитить `POST /telegram/webhook`

Гриша:

- добавить проверку `X-Telegram-Bot-Api-Secret-Token`;
- сравнивать с `TELEGRAM_WEBHOOK_SECRET`;
- возвращать `403` при missing/wrong secret;
- не принимать secret из body;
- не логировать secret.

Олег:

- проверить missing secret;
- проверить wrong secret;
- проверить valid secret;
- проверить, что Telegram update обрабатывается только при valid secret.

Илья:

- добавить `TELEGRAM_WEBHOOK_SECRET` в Cloudflare secrets для dev/prod;
- обновить Telegram webhook setup;
- проверить remote webhook health.

Маша:

- задача не нужна.

#### P0.2 Перевести `POST /api/clear-logs` на `ADMIN_TOKEN`

Гриша:

- заменить `assertWebhookToken` на `assertAdminToken`;
- поддержать `X-Admin-Token` и `Authorization: Bearer`;
- сохранить response `{ ok: true, logs: [] }`.

Олег:

- проверить, что `WEBHOOK_TOKEN` больше не очищает логи;
- проверить, что `ADMIN_TOKEN` очищает логи;
- проверить unauthorized/forbidden responses.

Илья:

- проверить наличие `ADMIN_TOKEN` в dev/prod secrets.

Маша:

- задача не нужна.

#### P0.3 API key / service token для Analysis API

Гриша:

- подтвердить, что `POST /api/external/analyze` принимает только service token;
- поддержать `Authorization: Bearer <SERVICE_TOKEN>` и `X-Scanner-Token`;
- не принимать user/subscription/payment tokens.

Олег:

- тесты missing token;
- wrong token;
- valid token.

Илья:

- проверить `WEBHOOK_TOKEN` или переименованный service token в Cloudflare secrets.

Маша:

- задача не нужна.

---

### P1. Core Analysis API contract

#### P1.1 Строгий API contract `1.0`

Гриша:

- `contractVersion` обязателен и равен `"1.0"`;
- `requestId` обязателен;
- `tickers` обязателен и не пустой;
- `country` обязателен;
- `news` обязателен;
- `analysis` обязателен;
- `delivery` обязателен;
- Telegram tokens запрещены в payload.

Олег:

- проверить valid contract payload;
- missing `contractVersion`;
- missing `requestId`;
- empty `tickers`;
- wrong ticker format;
- missing required objects;
- Telegram token in payload rejected.

Илья:

- задача не нужна, кроме review env после deploy.

Маша:

- подготовить короткий contract example для документации, если потребуется.

#### P1.2 Runtime validation

Гриша:

- возвращать `400` для invalid payload;
- response:

```json
{
  "contractVersion": "1.0",
  "requestId": "string | null",
  "status": "rejected",
  "errors": []
}
```

Олег:

- проверить форму ошибок;
- проверить, что scanner не запускает анализ при rejected request.

Илья:

- задача не нужна.

Маша:

- задача не нужна.

#### P1.3 Финальные форматы scanner config

Гриша:

- `risk`: positive number, percent risk per trade;
- `anchorBars`: positive integer;
- `strategies`: только `trend`, `breakout`, `volume_avwap`, `momentum`.

Олег:

- проверить invalid risk;
- invalid anchorBars;
- invalid strategy;
- aliases, если они поддерживаются;
- response содержит нормализованные значения.

Илья:

- задача не нужна.

Маша:

- задача не нужна.

---

### P2. Idempotency и structured response

#### P2.1 Idempotency по `requestId`

Гриша:

- сохранять response в `contract_results`;
- при duplicate `requestId` возвращать предыдущий response;
- не запускать анализ повторно;
- не отправлять Telegram повторно.

Олег:

- проверить duplicate requestId;
- проверить, что market provider не вызывается второй раз;
- проверить, что Telegram не вызывается второй раз.

Илья:

- применить D1 migration;
- проверить таблицу `contract_results` в dev/prod.

Маша:

- задача не нужна.

#### P2.2 Structured report

Гриша:

Возвращать:

```json
{
  "contractVersion": "1.0",
  "requestId": "...",
  "status": "processed | rejected | failed",
  "report": {},
  "telegram": {},
  "errors": []
}
```

Олег:

- проверить response format;
- проверить `processed`;
- проверить `rejected`;
- проверить `failed`;
- проверить `delivery.sendToTelegram=false`.

Илья:

- задача не нужна.

Маша:

- проверить читаемость Telegram message format, если report отправляется в Telegram.

---

### P3. Лимиты через `market-signal-ai-bot`

#### P3.1 Quota check до анализа

Гриша:

- добавить env:
  - `MARKET_SIGNAL_AI_BOT_URL`;
  - `MARKET_SIGNAL_AI_BOT_TOKEN`;
- до анализа отправлять quota check в `market-signal-ai-bot`;
- не хранить тарифы и подписки внутри scanner;
- при `allowed: false` не выполнять анализ;
- при quota service unavailable в production вести себя fail-closed;
- для dev разрешить bypass только через явный env, например `BYPASS_QUOTA_CHECK=true`.

Олег:

- quota allowed;
- quota denied;
- quota service unavailable;
- dev bypass enabled;
- dev bypass disabled.

Илья:

- добавить secrets/env в Cloudflare;
- проверить network доступ Worker к `market-signal-ai-bot`;
- проверить production fail-closed.

Маша:

- если нужен текст ошибки для Telegram/API consumer, подготовить короткий user-facing вариант.

#### P3.2 Подтвердить contract с `market-signal-ai-bot`

Гриша должен уточнить:

1. Exact endpoint для quota check.
2. Auth header.
3. Что такое `serviceClientId`.
4. Как считать `estimatedUnits`.
5. Нужен ли usage commit после успешного анализа.
6. Какой expected response при лимите.

Олег:

- после подтверждения contract обновить test cases.

Илья:

- после подтверждения endpoint добавить env/secrets.

Маша:

- задача не нужна.

---

### P4. CORS и production readiness

#### P4.1 Ограничить CORS для production

Гриша:

- добавить `ALLOWED_ORIGINS`;
- если allowlist задан, отдавать CORS только для разрешённых origins;
- requests без `Origin` должны работать;
- local/dev workflow не ломать.

Олег:

- allowed origin;
- unknown origin;
- no origin;
- preflight `OPTIONS`.

Илья:

- указать production allowed origins;
- настроить env в Cloudflare.

Маша:

- дать URL monitor/admin UI, если он используется.

#### P4.2 Production-gate checklist

Гриша:

- подготовить checklist или обновить существующий документ.

Олег:

- добавить regression checklist.

Илья:

- пройти checklist в dev;
- затем пройти production checklist.

Маша:

- задача не нужна.

---

## Формат отчёта Гриши после каждого блока

```text
Developer Report

Task ID:
Status: DONE / BLOCKED / NEEDS_DECISION

Changed:
- files:
- endpoints:
- schema:
- env/secrets:

Tests:
- command:
- result:

Questions / Comments:
1.

Risks:
1.

Needs tasks for:
- Oleg: yes/no
- Ilya: yes/no
- Masha: yes/no
```

## Как менеджер обрабатывает отчёт Гриши

После каждого отчёта Гриши нужно создать follow-up:

### Если нужен Олег

```text
Task for Oleg

Scope:
Test cases:
Expected result:
Command:
Release impact:
```

### Если нужен Илья

```text
Task for Ilya

Environment:
Secrets/env:
D1 migration:
Deploy check:
Rollback risk:
Expected report:
```

### Если нужна Маша

```text
Task for Masha

Scope:
Text/UX/doc artifact:
Audience:
Expected output:
```

## Definition of Done для всего пакета

Пакет задач закрыт, если:

- scanner работает как `Analysis API`;
- все P0 security blockers закрыты;
- contract `1.0` строго валидируется;
- service token обязателен;
- idempotency работает;
- structured response стабилен;
- quota check выполняется через `market-signal-ai-bot`;
- scanner не содержит новой логики пользователей, подписок и тарифов;
- Олег подтвердил regression PASS;
- Илья подтвердил dev deploy PASS;
- перед production есть backup, rollback plan и production-gate report.
