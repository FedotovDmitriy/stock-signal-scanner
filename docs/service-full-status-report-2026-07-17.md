# Stock Signal Scanner - полный отчет по сервису

Дата: 2026-07-17  
Владелец отчета: stock-signal-scanner Manager  
Статус отчета: актуальный управленческий снимок состояния сервиса

## 1. Краткий вывод

`stock-signal-scanner` сейчас является сервисом анализа тикеров. Его задача - получить запрос на анализ тикера или списка тикеров, проверить контракт входящего payload, запросить разрешение у Core-сервиса, выполнить технический или фундаментальный анализ и вернуть структурированный результат.

Dev-версия v1.1 закрыта и принята:

```text
v1.1 dev closeout: ACCEPTED
Gates 1-5: PASS / ACCEPTED
Production changed during dev gates: no
Secrets exposed: no
```

Production-релиз сейчас заблокирован:

```text
Production status: BLOCKED / DO NOT DEPLOY
Main blocker: production Core is not ready for v1.1 access/cache flow.
```

Главная причина блокировки production: сервис `market-signal-ai-bot` в production еще не содержит live endpoints для Scanner v1.1:

```text
POST /api/internal/access/check -> 404
POST /api/internal/access/cache/commit -> 404
Core migrations 0007-0016 are pending
Core production HMAC key/secret map is not configured
```

## 2. Назначение сервиса

`stock-signal-scanner` - это analysis API для тикеров публичных компаний.

Сервис должен:

- принимать тикер или список тикеров;
- валидировать входящий contract payload;
- проверять право на анализ через Core;
- выполнять regular technical analysis;
- выполнять FundRep fundamental analysis;
- возвращать структурированный JSON response;
- сохранять технический cache результата;
- поддерживать idempotency по `requestId`;
- уважать язык отчета из upstream contract;
- fail-closed, если Core недоступен или отказал.

Сервис не должен:

- управлять пользователями;
- управлять подписками;
- хранить billing/quota ledger как источник истины;
- владеть тарифами;
- владеть пользовательскими настройками;
- отправлять персональный analysis result в общий Telegram-канал;
- принимать Telegram bot token из payload;
- хранить raw Telegram chatId вне разрешенных legacy/dev сценариев.

## 3. Границы ответственности между сервисами

### stock-signal-scanner

Отвечает за:

- анализ тикеров;
- технические сигналы;
- FundRep;
- contract validation;
- structured report response;
- scanner-side idempotency;
- scanner-owned technical cache;
- HMAC-запросы к Core через `CORE_SERVICE`;
- fail-closed поведение до анализа.

### market-signal-ai-bot / Core

Отвечает за:

- пользователя;
- подписку;
- тариф;
- quota balance;
- quota ledger;
- право доступа;
- ownership отчета;
- billing decision;
- cache ownership;
- private delivery flow.

### telegram-company-matcher

Отвечает за:

- новости;
- сопоставление новости с компанией/тикером;
- запрос анализа у scanner;
- пользовательский Telegram/news flow вокруг новости.

### Telegram / UI / private bot

Должны работать через Core/private flow. Scanner не должен сам становиться владельцем пользовательской доставки.

## 4. Основной API flow v1.1

```text
External service / Core/private bot/site/API
  -> POST /api/external/analyze
  -> Scanner validates contractVersion/requestId/tickers/country/news/analysis/delivery
  -> Scanner calls Core access/check through CORE_SERVICE with HMAC
  -> Core returns allowed/denied + quota/cache decision
  -> Scanner runs analysis only if allowed and needed
  -> Scanner writes local analysis cache
  -> Scanner commits cache result to Core when required
  -> Scanner returns structured JSON response
```

Production rule:

```text
If Core is unavailable, denies access, or returns an invalid decision:
Scanner must not run analysis.
```

## 5. Основные endpoint'ы

### Активный contract API

```text
POST /api/external/analyze
```

Назначение:

- основной внешний endpoint для анализа;
- требует scanner service token;
- принимает только header-based auth;
- выполняет runtime validation;
- не принимает Telegram tokens в payload;
- в private premium/API-only flow не отправляет Telegram.

### Status endpoint

```text
GET /api/status
```

Назначение:

- health/status check;
- используется DevOps и QA.

### Legacy/dev endpoints

```text
POST /telegram/webhook
POST /api/webhook/analyze
POST /scan
POST /api/clear-logs
```

Важно:

- Telegram webhook и legacy paths остаются отдельно от private contract API;
- `/api/clear-logs` должен быть admin-protected;
- `/telegram/webhook` должен быть protected через Telegram secret.

## 6. Contract response

Scanner возвращает response по контракту:

```json
{
  "contractVersion": "1.0",
  "requestId": "...",
  "status": "processed",
  "report": {},
  "telegram": {},
  "errors": []
}
```

Возможные статусы:

```text
processed
rejected
failed
```

User-facing сообщения не должны показывать:

- `requestId`;
- raw access fields;
- internal quota fields;
- stack traces;
- secrets;
- HMAC details.

## 7. Анализ и отчеты

### Regular analysis

Обычный анализ тикера. Запускается по валидному тикеру без специальной команды.

Примеры:

```text
AAPL
AAPL, MSFT, NVDA
```

В API это соответствует `reportType=regular`.

### FundRep

Фундаментальный анализ. Запускается только если request явно требует FundRep.

Примеры:

```text
FundRep AAPL
reportType=fundrep
```

Текущий статус:

- структурированный FundRep API реализован;
- FundRep cache реализован;
- FundRep HTML генерируется только для Telegram/legacy delivery context, не как API body.

### PromtRep

Legacy/report helper flow, присутствует в старой документации. Не является основным production API flow v1.1.

## 8. Языки отчетов

Поддержанные языки:

```text
ru
en
he
```

Alias normalization:

```text
ru-RU -> ru
en-US -> en
he-IL / iw -> he
```

Правила:

- язык приходит из upstream contract;
- unsupported language отклоняется до внешних вызовов;
- прямые Telegram-команды могут использовать `DEFAULT_LANGUAGE`, по умолчанию `ru`;
- mixed-language report запрещен;
- `requestId` не показывается пользователю.

## 9. Cache и quota модель

Business decisions живут в Core. Scanner хранит только технический cache результата.

Принятая quota модель v1.1:

```text
REGULAR_NEW = 1
REGULAR_CACHED = 0.5
REGULAR_REFRESH = 1

FUNDREP_NEW = 3
FUNDREP_CACHED = 1.5

OWN_REPEAT_WITHIN_1H = 0
CACHE_TTL = 1 hour
```

Главное правило:

```text
Пользователь не платит дважды за свой свежий отчет.
Другой пользователь может получить свежий cached report со скидкой.
Force refresh стоит как новый анализ.
```

Scanner-side cache:

- TTL: 60 минут;
- regular cache key включает ticker, reportType, language, generationVersion;
- FundRep cache использует ту же изоляцию;
- если Core обещал cache, но Scanner cache отсутствует, Scanner fail-closed;
- Scanner не запускает новый анализ молча вместо обещанного cached результата.

## 10. Core integration

Текущий approved dev transport:

```text
CORE_SERVICE Service Binding
```

Правила:

- public Core fetch fallback удален;
- Scanner вызывает Core через `env.CORE_SERVICE.fetch(...)`;
- HMAC обязателен;
- без `CORE_SERVICE` Scanner fail-closed;
- Core вызывается до provider/cache/Telegram;
- новые/refresh анализы используют flow:

```text
access/check -> analysis -> access/cache/commit
```

Core HMAC dev:

```text
CORE_HMAC_KEY_ID=scanner-dev-v2
```

Production planned:

```text
CORE_HMAC_KEY_ID=scanner-prod-v1
CORE_SERVICE -> market-signal-ai-bot
```

Production Core пока не готов.

## 11. Security decisions

Уже принято и реализовано в dev:

- `/api/external/analyze` требует service token только из headers;
- body tokens запрещены/игнорируются;
- Telegram tokens в payload запрещены;
- `/telegram/webhook` требует Telegram webhook secret;
- `/api/clear-logs` должен быть admin protected;
- HMAC signatures/secrets/service tokens нельзя писать в chat/GitHub/task board/logs/screenshots;
- Scanner private API-only flow не отправляет Telegram;
- `delivery.sendToTelegram=true` в contract API отклоняется;
- `bot.tokenSecretName` в contract API отклоняется;
- raw `chatId` не должен передаваться/храниться вне Core-owned контекста.

Production blocker по security:

- в активной production версии найден подозрительный `plain_text` binding с Telegram-token-like именем и trailing space;
- значение не раскрывалось;
- binding нужно удалить/нейтрализовать до production release.

## 12. Dev status v1.1

Dev closeout принят.

Документ:

```text
docs/v1.1-p0-sequential-gate-board.md
```

Итог:

```text
Gate 1 - Grisha implementation: PASS
Gate 2 - Oleg local QA: PASS
Gate 3 - Ilya dev remote E2E: PASS
Gate 4 - Oleg final remote QA: PASS
Gate 5 - Manager decision: ACCEPTED
```

Подтверждено:

- exact duplicate возвращает сохраненный оригинальный response;
- changed duplicate остается fail-closed;
- same-user own repeat возвращает `own_repeat`, `chargeUnits=0`;
- other-user shared cache возвращает `cached_regular`, `chargeUnits=0.5`;
- first request commits cache;
- Telegram не вызывается в contract API flow;
- secrets не раскрыты;
- production не менялся.

## 13. Production status

Документ:

```text
docs/v1.1-production-gate-board.md
```

Текущий статус:

```text
Production Scanner deploy: BLOCKED
Gate 1 Core production readiness: ACTIVE
Gates 2-5: LOCKED
```

Production Core confirmed:

```text
Production Core Worker name: market-signal-ai-bot
Production URL: https://market-signal-ai-bot.fnemoy.workers.dev
Active production version: 967192f3-12cc-4176-8dc5-ceb0b0d21ae7
Health: 200, ok=true
```

Production Core blockers:

```text
Production HMAC key id: not configured / not confirmed
POST /api/internal/access/check -> 404
POST /api/internal/access/cache/commit -> 404
Pending migrations: 0007-0016
Missing tables/fields:
- quota_decisions_v11
- cache_receipts
- core_cache_entries
- cache_entry_id
- cache_receipt_id
```

Production Scanner blockers:

```text
CORE_HMAC_SECRET missing in production Scanner
Scanner production D1 schema incomplete
Active production version is old
Active production currently lacks v1.1 runtime bindings
Suspicious plain_text Telegram-token-like binding exists in active production
```

Production backup:

```text
backups/stock_signal_scanner_production-20260715-203425.sql
```

Rollback candidate:

```text
d73ccba6-fe20-4475-8df4-3fc5df2cde5a
```

## 14. Команда и роли

### Scanner Manager

Ответственность:

- управляет приоритетами;
- принимает gate decisions;
- фиксирует статус;
- распределяет задачи между специалистами;
- контролирует границы сервиса;
- не разрешает production deploy без PASS по gate.

### Гриша - Developer

Ответственность:

- implementation;
- API contract;
- runtime validation;
- idempotency;
- HMAC/Core integration;
- cache behavior;
- service boundary in code;
- local regression.

Текущий статус:

- v1.1 dev задачи закрыты;
- production config review нужен повторно после изменений Ильи в `wrangler.worker.toml`;
- не должен добавлять новые production changes до PASS Core Gate 1.

### Олег - QA

Ответственность:

- contract QA;
- regression QA;
- production smoke;
- fail-closed checks;
- secret exposure checks;
- user-visible behavior.

Текущий статус:

- v1.1 dev QA: PASS;
- production smoke: FAIL / BLOCKED;
- ждет production deploy gate после Core/Scanner readiness.

### Илья - DevOps / Cloudflare Engineer

Ответственность:

- Cloudflare Workers deploy;
- D1 backup/migrations;
- secrets and bindings by name only;
- rollback plan;
- health checks;
- production gate execution.

Текущий статус:

- production deploy не выполнял;
- Scanner production D1 backup создан;
- production dry-run показал planned `CORE_SERVICE -> market-signal-ai-bot`;
- выявил P0 blockers по `CORE_HMAC_SECRET`, D1 schema, Core production endpoint.

### Маша - Designer / UX wording

Ответственность:

- user-facing texts;
- RU/EN wording;
- Telegram/report clarity;
- запрет raw internal fields в пользовательском сообщении.

Текущий статус:

- quota/access wording подготовлен;
- technical details должны оставаться во внутренних логах;
- пользователь должен видеть понятное сообщение, а не внутренние ошибки.

### Анна - Product / Monetization

Ответственность:

- quota model;
- pricing logic;
- cache pricing;
- fairness model for repeated requests;
- product value clarity.

Текущий статус:

- quota/cache model v1.1 рекомендован и принят;
- HMAC не влияет на стоимость анализа;
- technical Core errors = `0 units`.

### Core team / market-signal-ai-bot manager

Ответственность:

- Core production readiness;
- subscriptions;
- quota ledger;
- HMAC key map;
- ownership;
- cache receipt/commit;
- production Core migrations.

Текущий статус:

- dev Core flow готов;
- production Core пока главный blocker.

## 15. Что уже сделано

### API и contract

- Добавлен и принят `POST /api/external/analyze`.
- Поддерживается `contractVersion=1.0`.
- Добавлена runtime validation обязательных полей.
- Неверный payload возвращает structured `rejected`.
- Response приведен к contract shape.
- Auth через header token.
- Body token не принимается.

### Security

- Telegram webhook защищен secret header.
- Admin clear-logs отделен от webhook/service token.
- Telegram tokens запрещены в payload.
- Contract API переведен в API-only boundary.
- Secrets не должны попадать в board/logs/responses.

### Core / quota / cache

- Scanner вызывает Core до анализа.
- Bearer fallback удален.
- HMAC-only Core integration реализован.
- Service Binding transport внедрен.
- Cache receipt/commit flow реализован.
- Exact duplicate / own_repeat / shared cache согласованы с Core.

### Analysis

- Regular technical analysis работает.
- FundRep API/cache реализован.
- Report language управляется upstream contract.
- `requestId` убран из user-facing messages.

### QA / DevOps

- Dev gates 1-5 пройдены.
- Local regression проходила по отчетам Олега/Гриши.
- Dev remote E2E через Service Binding пройден.
- Production smoke показал BLOCKED, что корректно остановило release.

## 16. Что сейчас не готово

Production release не готов из-за следующих P0:

1. Core production не содержит live `access/check`.
2. Core production не содержит live `cache/commit`.
3. Core production migrations `0007-0016` pending.
4. Core production HMAC key/secret map не настроен.
5. Scanner production `CORE_HMAC_SECRET` отсутствует.
6. Scanner production D1 schema неполная.
7. Active Scanner production version старая.
8. Active production содержит подозрительный `plain_text` binding с Telegram-token-like именем.

P1 / documentation debt:

1. Часть старой документации содержит mojibake/поврежденную кодировку.
2. Старый `README.md` и `ARCHITECTURE.md` описывают более широкий Telegram/watchlist/product scope, который сейчас частично принадлежит другим сервисам.
3. Нужно обновить публичную документацию под текущую границу: scanner = analysis API.

## 17. Следующие шаги

### Gate 1 - Core production readiness

Owner: Core team.

Нужно получить PASS по:

- Core production backup;
- migrations `0007-0016`;
- HMAC key id/secret map;
- live `access/check`;
- live `cache/commit`;
- ownership logic in production;
- rollback plan.

### Gate 2 - Scanner production config and secret hygiene

Owners: Grisha + Ilya.

Старт только после Core PASS.

Нужно:

- повторно проверить текущий `wrangler.worker.toml`;
- подтвердить `CORE_SERVICE -> market-signal-ai-bot`;
- настроить `CORE_HMAC_SECRET`;
- убрать suspicious plain_text binding;
- dry-run без deploy.

### Gate 3 - Scanner production D1 and deploy

Owner: Ilya.

Старт только после Gate 2 PASS.

Нужно:

- fresh production D1 backup;
- schema/migrations for Scanner tables;
- deploy;
- active version and bindings confirmation;
- minimal health.

### Gate 4 - Production smoke QA

Owner: Oleg.

Нужно:

- regular analysis;
- exact duplicate;
- own repeat;
- shared cache;
- private API boundary;
- Telegram not sent;
- secret scan.

### Gate 5 - Manager decision

Owner: Scanner Manager.

Production release принимается только после PASS всех gate.

## 18. Перечень файлов сервиса

Ниже список файлов, связанных с текущим сервисом, по состоянию репозитория на 2026-07-17.

### Root / runtime / deploy

```text
README.md
ARCHITECTURE.md
SERVICE_BOUNDARIES.md
TELEGRAM_COMPANY_MATCHER_API.md
CLOUDFLARE_DEPLOY.md
package.json
package-lock.json
wrangler.worker.toml
wrangler.toml
app.py
Dockerfile
docker-compose.yml
render.yaml
```

### Cloudflare Worker

```text
cloudflare/worker.js
cloudflare/report-i18n.js
cloudflare/schema.sql
```

### Cloudflare Pages / monitor / privacy pages

```text
cloudflare/pages/_worker.js
cloudflare/pages/_redirects
cloudflare/pages/index.html
cloudflare/pages/privacy/tickerlab-dev-bot/index.html
cloudflare/pages/privacy/tickerlab-bot/index.html
```

### Tests

```text
tests/worker-contract-smoke.mjs
```

### Assets

```text
assets/tickerlab-dev-botpic.png
assets/tickerlab-botpic.png
```

### Backups

```text
backups/stock_signal_scanner_production-20260715-203425.sql
```

### Current status / gate documents

```text
docs/service-full-status-report-2026-07-17.md
docs/version-status.md
docs/v1.1-p0-sequential-gate-board.md
docs/v1.1-production-gate-board.md
docs/v1.1-closeout-and-v1.2-transition-tasks.md
docs/production-smoke-checklist.md
```

### Team and task management

```text
docs/team-manifest.md
docs/team-quota-cache-access-tasks.md
docs/grisha-master-task-plan.md
docs/grisha-analysis-api-tasks.md
docs/grisha-comment-log.md
docs/grisha-production-gate-tasks.md
docs/oleg-p0-security-qa-task.md
docs/oleg-qa-report-log.md
docs/oleg-telegram-real-user-check-task.md
docs/ilya-p0-security-devops-task.md
docs/ilya-p0-security-devops-report.md
docs/ilya-hmac-deployment-runbook.md
docs/ilya-devops-report-log.md
docs/ilya-dev-telegram-webhook-check.md
docs/ilya-dev-deploy-retry-task.md
docs/ilya-production-gate-task.md
docs/masha-telegram-quota-wording.md
```

### Product / privacy / incident / reports

```text
docs/scanner-private-premium-analysis-mode-report.md
docs/team-manifest.md
docs/tickerlab-dev-bot-privacy-policy.md
docs/tickerlab-bot-privacy-policy.md
docs/incident-stock-signal-scanner-bot-no-analysis.md
docs/manager-service-improvement-infographic.html
```

## 19. Файлы, которые требуют внимания

### Нужно обновить / привести к текущей архитектуре

```text
README.md
ARCHITECTURE.md
SERVICE_BOUNDARIES.md
docs/version-status.md
docs/grisha-production-gate-tasks.md
docs/ilya-production-gate-task.md
```

Причина:

- часть документов описывает старую или более широкую архитектуру;
- часть документов содержит поврежденную кодировку;
- текущая truth source для release сейчас:
  - `docs/v1.1-p0-sequential-gate-board.md`;
  - `docs/v1.1-production-gate-board.md`;
  - этот отчет.

### Нельзя публиковать секреты

Ни один файл не должен получить:

- service token value;
- HMAC secret;
- Telegram bot token;
- raw auth headers;
- screenshots/logs с секретами.

## 20. Финальный статус

```text
Service direction: correct
Dev v1.1: accepted
Production: blocked
Main blocker owner: Core team / market-signal-ai-bot
Scanner next action: wait for Core Gate 1 PASS, then run Scanner config/secret hygiene gate
Production deployment: not authorized now
```

Менеджерское решение:

```text
Не деплоить production Scanner, пока Core production readiness не даст PASS.
Работать только по docs/v1.1-production-gate-board.md.
```
