# Задание для Гриши: закрыть production-gate после DevOps отчёта

## Контекст

Илья проверил текущее состояние `stock-signal-scanner` после внедрения contract endpoint `POST /api/external/analyze`.

Итог DevOps:

- Локальный contract smoke: `PASS`.
- Production-gate: `FAIL`.
- Worker не деплоился.
- D1 migration remote не применялась.
- Remote health не проверялся.

Главные блокеры перед production:

1. `POST /telegram/webhook` принимает внешний POST без проверки secret/header/path-token.
2. CORS открыт на `*`.
3. `POST /api/clear-logs` защищён `WEBHOOK_TOKEN`, хотя это admin/destructive action.
4. Dry-run/deploy check не подтверждён.

## Цель задачи

Закрыть security и production-readiness замечания из отчёта Ильи, не меняя продуктовую логику анализа тикеров.

Границы сервиса остаются прежними:

- обычный ticker запускает обычный анализ;
- `FundRep` запускает фундаментальный анализ;
- `POST /api/external/analyze` работает по contract `1.0`;
- Telegram tokens не принимаются из payload.

---

## Задание 1. Защитить `POST /telegram/webhook`

### Проблема

Сейчас любой внешний POST может вызвать Telegram webhook handler.

### Что сделать

Добавить проверку Telegram webhook secret.

Поддержать один из вариантов, предпочтительно первый:

1. Header-based:
   - Cloudflare Worker ожидает header `X-Telegram-Bot-Api-Secret-Token`.
   - Значение сравнивается с secret из env, например `TELEGRAM_WEBHOOK_SECRET`.

2. Path-based fallback, если понадобится:
   - webhook URL вида `/telegram/webhook/<secret>`.
   - secret сравнивается с env.

### Требования

- Если secret не настроен в env для production, endpoint должен возвращать ошибку конфигурации.
- Если header отсутствует или неверный, вернуть `403`.
- Не логировать значение secret.
- Не принимать secret из body payload.

### Acceptance criteria

- `POST /telegram/webhook` без secret возвращает `403`.
- `POST /telegram/webhook` с неверным secret возвращает `403`.
- `POST /telegram/webhook` с верным secret принимает update и возвращает `{ ok: true }`.
- Existing Telegram processing не ломается.

### Тесты

Добавить smoke tests:

- telegram webhook missing secret;
- telegram webhook wrong secret;
- telegram webhook valid secret.

---

## Задание 2. Перевести `POST /api/clear-logs` на `ADMIN_TOKEN`

### Проблема

`/api/clear-logs` удаляет данные, но сейчас защищён `WEBHOOK_TOKEN`.

### Что сделать

- Заменить проверку `assertWebhookToken` на `assertAdminToken`.
- Поддерживать header:
  - `X-Admin-Token`;
  - или `Authorization: Bearer <ADMIN_TOKEN>`.

### Требования

- `WEBHOOK_TOKEN` больше не должен очищать логи.
- `ADMIN_TOKEN` должен очищать логи.
- Ответ endpoint оставить совместимым: `{ ok: true, logs: [] }`.

### Acceptance criteria

- `POST /api/clear-logs` с `WEBHOOK_TOKEN` возвращает `403`.
- `POST /api/clear-logs` с `ADMIN_TOKEN` возвращает `200`.
- Логи и cache очищаются как раньше.

---

## Задание 3. Ограничить CORS для production

### Проблема

CORS сейчас открыт на `*`. Для production лучше ограничить origin monitor/admin UI.

### Что сделать

Добавить env-based allowlist:

- `ALLOWED_ORIGINS`, строка через запятую.
- Пример:
  - `https://stock-signal-scanner-monitor.pages.dev`
  - `https://scanner-admin.example.com`

### Логика

- Если `ALLOWED_ORIGINS` задан:
  - разрешать только origin из списка;
  - выставлять `Access-Control-Allow-Origin` в конкретный origin;
  - unknown origin не получает permissive CORS.

- Если `ALLOWED_ORIGINS` не задан:
  - для dev можно оставить `*`;
  - для production лучше fail-closed или явно документировать default.

### Требования

- Не сломать local/dev workflow.
- Не открывать admin endpoints для любого browser origin.
- Preflight `OPTIONS` должен работать для разрешённых origins.

### Acceptance criteria

- Allowed origin получает CORS headers.
- Unknown origin не получает `Access-Control-Allow-Origin: *` в production.
- Requests без browser `Origin` продолжают работать.

---

## Задание 4. Добавить production-gate smoke checklist

### Что сделать

Добавить документ или script checklist для релиза:

1. Run local tests:
   - `npm.cmd run test:worker-contract`

2. Apply D1 migration dev:
   - `npm.cmd run cf:d1:migrate:dev`

3. Deploy dev:
   - `npm.cmd run cf:deploy:dev`

4. Проверить dev:
   - `GET /api/status`
   - `POST /api/external/analyze`
   - duplicate `requestId`
   - `delivery.sendToTelegram=false`
   - `POST /telegram/webhook` с valid/invalid secret
   - `POST /api/clear-logs` с admin token

5. Перед production:
   - сделать D1 export backup;
   - получить last known good Worker version;
   - записать rollback command.

### Acceptance criteria

- В репозитории есть понятная инструкция production-gate.
- Илья может пройти checklist без дополнительных уточнений.

---

## Задание 5. Проверить Wrangler dry-run/deploy вне sandbox

### Проблема

Илья не смог подтвердить Wrangler dry-run из-за `Access is denied` в sandbox.

### Что сделать

На обычной машине/окружении выполнить:

- `npm.cmd run cf:deploy:dev`
- или wrangler dry-run/equivalent, если используется.

### Acceptance criteria

- Worker build проходит.
- Deploy в dev проходит.
- `GET /api/status` dev возвращает `worker: "online"`.
- Результат передать Илье в DevOps Report update.

---

## Приоритет выполнения

1. Защита `/telegram/webhook` — blocker.
2. `ADMIN_TOKEN` для `/api/clear-logs` — blocker.
3. CORS allowlist — important before production.
4. Tests for security endpoints — required before merge/deploy.
5. Production-gate checklist — required before release.
6. Wrangler/deploy check — required before production release.

## Что не делать в этой задаче

- Не менять алгоритмы анализа тикеров.
- Не менять contract response format без отдельного согласования.
- Не добавлять watchlist, страны, digest, подписки.
- Не переносить Telegram tokens в payload.
- Не делать бизнес-dashboard.

## Definition of Done

Задача считается закрытой, если:

- все blocker issues из отчёта Ильи исправлены;
- добавлены тесты на webhook secret и admin clear-logs;
- contract smoke tests продолжают проходить;
- production-gate checklist создан;
- Илья может повторить проверку и изменить статус с `FAIL` на `PASS for dev`, а затем после remote checks на `PASS for production`.
