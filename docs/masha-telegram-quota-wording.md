# Masha: Telegram Quota And Access Wording

Status: final, ready for implementation
Owner: Masha - Designer
Languages: Russian and English
Implementation owner: `market-signal-ai-bot`

## Product Rules

1. The bot selects a localization key from the user's language.
2. Scanner response fields are used only for internal routing and are never inserted into user-facing text.
3. Allowed user-facing placeholders:
   - `{ticker}`: normalized ticker;
   - `{units}`: localized and formatted charge;
   - `{remaining_units}`: localized and formatted balance.
4. Do not expose internal values, IDs, error reasons, or service names.
5. A paid refresh always requires confirmation before the request is sent.
6. Quota/access messages appear before the report and never inside its analysis body.

## Final Localization Copy

| Localization key | Russian | English |
| --- | --- | --- |
| `analysis.quota.new_regular` | Готовлю новый анализ по {ticker}. Стоимость: {units}. | Preparing a new analysis for {ticker}. Cost: {units}. |
| `analysis.quota.own_recent_regular` | Свежий отчёт по {ticker} уже готов. Показываю его снова без списания. | A fresh report for {ticker} is already available. Showing it again at no charge. |
| `analysis.quota.cached_regular` | По {ticker} есть свежий отчёт. Стоимость со скидкой: {units}. | A fresh report for {ticker} is available. Discounted price: {units}. |
| `analysis.quota.refresh_regular_confirm` | Обновить анализ? Мы пересчитаем отчёт и спишем 1 юнит. | Refresh analysis? We will recalculate the report and charge 1 unit. |
| `analysis.quota.new_fundrep` | Готовлю расширенный фундаментальный отчёт по {ticker}. Стоимость: {units}. | Preparing an extended fundamental report for {ticker}. Cost: {units}. |
| `analysis.quota.own_recent_fundrep` | Свежий фундаментальный отчёт по {ticker} уже готов. Показываю его снова без списания. | A fresh fundamental report for {ticker} is already available. Showing it again at no charge. |
| `analysis.quota.cached_fundrep` | По {ticker} есть свежий фундаментальный отчёт. Стоимость со скидкой: {units}. | A fresh fundamental report for {ticker} is available. Discounted price: {units}. |
| `analysis.quota.refresh_fundrep_confirm` | Обновить фундаментальный отчёт? Мы пересчитаем его и спишем {units}. | Refresh the fundamental report? We will recalculate it and charge {units}. |
| `analysis.access.insufficient_units` | Недостаточно юнитов для анализа. Пополните баланс или выберите другой тариф. | Not enough units for this analysis. Add units or choose another plan. |
| `analysis.access.not_in_plan` | Этот тип анализа недоступен в вашем тарифе. | This analysis type is not available on your plan. |
| `analysis.access.temporarily_unavailable` | Сейчас не удалось проверить доступ к анализу. Попробуйте ещё раз чуть позже. | We could not verify access right now. Please try again shortly. |
| `analysis.balance.remaining` | После анализа останется: {remaining_units}. | Remaining after this analysis: {remaining_units}. |
| `analysis.action.refresh` | Обновить | Refresh |
| `analysis.action.cancel` | Отмена | Cancel |
| `analysis.action.add_units` | Пополнить баланс | Add units |
| `analysis.action.change_plan` | Выбрать тариф | Choose plan |
| `analysis.action.retry` | Повторить | Try again |

## State-To-Key Routing

This table is for implementation only. Values in the left column must never be shown to users.

| Internal decision | Localization key |
| --- | --- |
| `new_regular` | `analysis.quota.new_regular` |
| `own_repeat` | `analysis.quota.own_recent_regular` |
| `cached_regular` | `analysis.quota.cached_regular` |
| `refresh_regular` | `analysis.quota.refresh_regular_confirm` |
| `new_fundrep` | `analysis.quota.new_fundrep` |
| `own_repeat_fundrep` | `analysis.quota.own_recent_fundrep` |
| `cached_fundrep` | `analysis.quota.cached_fundrep` |
| `refresh_fundrep` | `analysis.quota.refresh_fundrep_confirm` |
| `rejected_no_quota` | `analysis.access.insufficient_units` |
| `rejected_no_access` | `analysis.access.not_in_plan` |
| `failed_quota_service` | `analysis.access.temporarily_unavailable` |

## Confirmed Access Messages

Access denied uses the existing key `analysis.access.not_in_plan`:

```text
RU: Этот тип анализа недоступен в вашем тарифе.
EN: This analysis type is not available on your plan.
```

Temporarily unavailable uses the existing key `analysis.access.temporarily_unavailable`:

```text
RU: Сейчас не удалось проверить доступ к анализу. Попробуйте ещё раз чуть позже.
EN: We could not verify access right now. Please try again shortly.
```

Security and infrastructure failures must not create additional user-facing variants:

| Internal outcome | User-facing key |
| --- | --- |
| Access or plan denied | `analysis.access.not_in_plan` |
| HMAC or signature validation failure | `analysis.access.temporarily_unavailable` |
| Repeated, expired, or invalid nonce | `analysis.access.temporarily_unavailable` |
| Core timeout, invalid response, or unavailable service | `analysis.access.temporarily_unavailable` |
| Unknown internal error while checking access | `analysis.access.temporarily_unavailable` |

The internal outcome column is implementation guidance only and must never be rendered in Telegram.

## Unit Formatting

The application formats the number before inserting `{units}` or `{remaining_units}`.

Russian examples:

```text
0 юнитов
0.5 юнита
1 юнит
1.5 юнита
2 юнита
3 юнита
5 юнитов
12 юнитов
```

English examples:

```text
0 units
0.5 units
1 unit
1.5 units
2 units
3 units
5 units
12 units
```

Use a dot as the decimal separator because the supported prices are product values: `0.5` and `1.5`.

## Raw Field Safety

Never render these scanner/access response fields directly:

```text
quotaDecision
cacheStatus
reportSource
chargeUnits
remainingUnits
reason
requestId
contractVersion
allowed
HMAC
signature
nonce
Core
stack trace
internal error code
```

Implementation requirements:

1. Map the internal decision to a known localization key.
2. Ignore the raw `reason` value in the Telegram message.
3. Format numeric values through the locale-aware unit formatter.
4. If a decision is unknown, show `analysis.access.temporarily_unavailable` and log the technical value privately.
5. Do not fall back to another language inside the same message.
6. Do not mention authentication, signatures, nonce validation, Core, service topology, or internal errors.

## Recommended Presentation

- Show one short status message before analysis starts.
- Show the remaining balance only when the value is available and confirmed.
- For a recent report, say "fresh report" and "no charge"; do not mention caching.
- For a discounted report, explain the discount without exposing its technical source.
- For rejected requests, show no partial report.
- Keep support destination and tariff actions inside `market-signal-ai-bot`.
