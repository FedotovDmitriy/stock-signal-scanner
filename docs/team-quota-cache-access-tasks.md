# Team Tasks: Quota, Cache, Access Contract

Status: active
Owner: stock-signal-scanner Manager
Version target: v1.1

## Accepted Decisions

1. Scanner remains a clean ticker analysis engine.
2. Scanner does not manage users, subscriptions, tariff plans, or billing ledger.
3. `market-signal-ai-bot` owns:
   - user access;
   - quota balance;
   - quota ledger;
   - report ownership;
   - tariff rules;
   - subscription state.
4. Scanner asks `market-signal-ai-bot` for access/quota before analysis.
5. Internal quota endpoint direction:
   - `POST /api/internal/access/check`
6. Internal service auth direction:
   - `Authorization: Bearer <INTERNAL_API_SECRET>`
7. Production behavior:
   - if access/quota check is unavailable, scanner must not run analysis.
   - production must fail closed.
8. Report language:
   - language comes from upstream contract.
   - scanner must not hardcode report language.
9. Cache and billing recommendation accepted:
   - billing, ownership, and quota ledger live in `market-signal-ai-bot`.
   - scanner may store technical analysis results/cache, but does not decide billing.

## Quota Model v1.1

```text
REGULAR_NEW = 1
REGULAR_CACHED = 0.5
REGULAR_REFRESH = 1

FUNDREP_NEW = 3
FUNDREP_CACHED = 1.5

OWN_REPEAT_WITHIN_1H = 0
CACHE_TTL = 1 hour
```

Business rule:

```text
The user does not pay twice for their own recent report.
Another user can receive a fresh cached result with a discount.
Force refresh always creates a new paid operation.
FundRep remains a premium report type.
```

## Proposed Access Check Request

Scanner sends to `market-signal-ai-bot` before analysis:

```json
{
  "contractVersion": "1.0",
  "requestId": "string",
  "userId": "string",
  "chatId": "string",
  "ticker": "AAPL",
  "reportType": "regular",
  "forceRefresh": false,
  "language": "ru"
}
```

Allowed values:

```text
reportType: regular | fundrep
forceRefresh: true | false
language: upstream-defined language code
```

## Proposed Access Check Response

`market-signal-ai-bot` returns:

```json
{
  "contractVersion": "1.0",
  "requestId": "string",
  "allowed": true,
  "chargeUnits": 1,
  "quotaDecision": "new_regular",
  "cacheStatus": "miss",
  "reportSource": "new_analysis",
  "remainingUnits": 42,
  "reason": "Allowed"
}
```

Allowed values:

```text
quotaDecision:
- new_regular
- own_repeat
- cached_regular
- refresh_regular
- new_fundrep
- own_repeat_fundrep
- cached_fundrep
- refresh_fundrep
- rejected_no_quota
- rejected_no_access
- failed_quota_service

cacheStatus:
- miss
- own_recent
- shared_recent

reportSource:
- new_analysis
- cached_report
```

## Task For Grisha - Developer

Priority: P1
Status: open

Goal:
Prepare scanner for quota/access integration while keeping scanner a clean analysis API.

Tasks:

1. Add scanner-side support for access/quota pre-check.
2. Use internal endpoint:
   - `POST /api/internal/access/check`
3. Use internal auth:
   - `Authorization: Bearer <INTERNAL_API_SECRET>`
4. Do not accept quota, user balance, tariff, or subscription data from public payload.
5. Pass upstream language through the analysis/report pipeline.
6. Do not hardcode Russian, Hebrew, or English inside scanner report generation when contract language is available.
7. If quota/access check returns `allowed=false`:
   - do not run analysis;
   - return structured rejected response.
8. If quota/access check is unavailable in production:
   - do not run analysis;
   - return structured failed/rejected response.
9. Keep local/dev behavior configurable only if needed, for example:
   - `BYPASS_QUOTA_CHECK=true`
   - never enable bypass in production.
10. Scanner must not implement tariff decisions.
11. Scanner must not store billing ledger.
12. Scanner may store technical cached analysis result if needed, but billing ownership stays in `market-signal-ai-bot`.

Acceptance criteria:

```text
- Scanner calls access check before paid analysis.
- Scanner does not analyze when access is rejected.
- Scanner fails closed in production when quota service is unavailable.
- Language comes from upstream contract.
- Existing contract tests still pass.
- No Telegram/user subscription logic is added to scanner.
```

### Grisha Report

Status:

```text
DONE
```

Comment:

```text
Implemented scanner-side quota/access pre-check for the contract endpoint.

What was done:
- Added access/quota pre-check before contract analysis in `POST /api/external/analyze`.
- Scanner calls the internal access service with `Authorization: Bearer <INTERNAL_API_SECRET>`.
- Supported endpoint configuration through `ACCESS_CHECK_URL`, or `MARKET_SIGNAL_AI_BOT_URL` + `/api/internal/access/check`.
- Added explicit non-production bypass through `BYPASS_QUOTA_CHECK=true`; bypass is ignored in production.
- If access service returns `allowed=false`, scanner returns structured rejected response and does not run analysis.
- If access service is unavailable or misconfigured, scanner returns `failed_quota_service` and does not run analysis.
- Production fails closed because bypass is disabled when `APP_ENV=production`.
- Public contract validation now rejects quota/balance/tariff/subscription/billing fields in payload.
- Scanner passes upstream `language` into normalized request, orchestrator config, and contract report response.
- Scanner still does not implement tariff decisions, quota ledger, subscription logic, or billing ownership.

What was checked:
- `npm.cmd run test:worker-contract` PASS.
- Added smoke coverage for access allowed, access rejected, production quota-service failure, and forbidden business fields.
```

Files changed:

```text
cloudflare/worker.js
tests/worker-contract-smoke.mjs
CLOUDFLARE_DEPLOY.md
docs/team-quota-cache-access-tasks.md
```

Risks / questions:

```text
Risks:
- Real `market-signal-ai-bot` URL/contract still must be confirmed by manager/Ilya before production.
- `INTERNAL_API_SECRET` and `ACCESS_CHECK_URL`/`MARKET_SIGNAL_AI_BOT_URL` must be configured in Cloudflare.
- Scanner now passes `language` through the pipeline and response, but full user-facing report localization is not complete: existing Telegram/report text still contains hardcoded Russian strings in several report builders. This should be a follow-up localization task.
- Multi-ticker requests call access check per ticker. If the upstream service expects one batched request, contract should be updated before release.

Questions:
- Should `market-signal-ai-bot` return cached report body when `reportSource=cached_report`, or should scanner always return its own technical cached result after access approval?
- Should access rejection use HTTP 400 permanently, or should API consumers receive HTTP 200 with `status=rejected` for business rejections?

Update after manager answers:
- HTTP status policy was aligned with manager decision:
  - invalid contract payload -> HTTP 400 + `status=rejected`;
  - service token failure -> HTTP 403 + `status=rejected`;
  - quota/access business rejection -> HTTP 200 + `status=rejected`;
  - quota/access service unavailable -> HTTP 503 + `status=failed`;
  - internal scanner failure -> HTTP 500 + `status=failed`.
- Regular technical analysis has scanner-owned result cache through `analysis_cache` and `runAnalysisOrchestrator`.
- FundRep cached report support is not complete in the contract API path and should be tracked as separate P1 follow-up: `Implement scanner technical report cache for reportSource=cached_report`.
- Re-ran `node --check cloudflare\worker.js`: PASS.
- Re-ran `npm.cmd run test:worker-contract`: PASS.

Technical cache follow-up:
- Added a dedicated scanner-owned regular report cache keyed by `ticker + reportType + language + generationVersion`.
- Regular cached reports are fresh for 60 minutes; expiry is enforced through `analysis_cache.expires_at`.
- `reportSource=cached_report` now reads only from the dedicated report cache and never silently starts a new provider analysis.
- If the promised regular cached report is missing or expired, scanner returns HTTP 503 + `status=failed` + `cached_report_not_found`.
- FundRep cached reports are not implemented yet. A cached FundRep decision returns HTTP 503 + `status=failed` + `fundrep_cache_unavailable` without provider analysis.
- Mixed multi-ticker requests can combine found cached regular reports with explicitly approved `new_analysis` tickers.
- Added smoke coverage for regular cache hit, missing promised cache, FundRep cache rejection, and zero provider calls on controlled failures.
- Re-ran `node --check cloudflare/worker.js`: PASS.
- Re-ran `npm.cmd run test:worker-contract`: PASS (18 tests).

Report language follow-up:
- Audited technical, FundRep, PromtRep, KPI summary, signal, market-context, and news-message builders for hardcoded user-facing text.
- Added one localization source for `ru`, `en`, and `he`; locale variants such as `en-US`, `ru-RU`, and `he-IL` are normalized.
- Upstream contract `language` now controls signal conditions, ideas, explanations, Telegram report labels, status text, and news labels.
- FundRep HTML declares the selected language and uses RTL layout for Hebrew.
- Removed bilingual FundRep labels and raw provider-error text from user-facing reports.
- Direct Telegram commands use `DEFAULT_LANGUAGE`, with `ru` as the fallback.
- Added contract smoke coverage for English and Hebrew reports and assertions against foreign-language labels.
- Re-ran syntax checks: PASS.
- Re-ran `npm.cmd run test:worker-contract`: PASS (19 tests).

Language contract validation follow-up:
- Fixed supported languages to `ru`, `en`, and `he`.
- Added aliases: `ru-RU -> ru`, `en-US -> en`, `he-IL -> he`, and `iw -> he`.
- Missing language continues to default to `ru` for contract `1.0` backward compatibility.
- Unsupported languages now return HTTP 400 + `status=rejected` + `field=language` + `code=unsupported_language`.
- Validation runs before access check, Yahoo analysis, and Telegram delivery.
- Removed `requestId` from FundRep KPI and verified it is absent from user-facing localized reports; API responses and internal logs keep it.
- Added smoke coverage for all aliases, missing-language fallback, strict unsupported-language rejection, and zero external calls.
- Re-ran `npm.cmd run test:worker-contract`: PASS (20 tests).

P1 FundRep API + Cache follow-up:
- `POST /api/external/analyze` now routes `reportType=fundrep` to fundamental analysis instead of returning a technical report.
- The structured response includes `analysisType=fundamental`, `reportType=fundrep`, language, generation version, KPI summary, key risks, data sources, and per-ticker fundamental results.
- API responses never contain FundRep HTML. HTML is generated only for Telegram document delivery.
- Added per-ticker FundRep cache entries in the existing `analysis_cache` table with a 60-minute TTL and keys isolated by report type, language, and generation version.
- `reportSource=cached_report` returns scanner-owned FundRep without provider calls. Missing or expired cache returns HTTP 503 + `status=failed` + `fundrep_cache_not_found`.
- `forceRefresh=true` bypasses scanner result and candle caches, rebuilds FundRep, and replaces the cache entry.
- Contradictory force-refresh plus cached-report access decisions return HTTP 503 + `invalid_access_decision`.
- Added `report.cacheStatus`: `hit`, `miss`, `refreshed`, or `mixed`.
- Multi-ticker requests can combine cached FundRep entries with explicitly approved new analyses.
- Failed, empty, or structurally invalid FundRep results are not cached.
- Scanner still does not own users, tariffs, balances, report ownership, or billing decisions.
- No D1 migration is required; the existing `analysis_cache` schema is reused.
- Smoke suite PASS: 30 tests, including new/cached/expired/refreshed/mixed FundRep, cache isolation, provider failure, duplicate requestId, Telegram privacy, and delivery=false.

Ready for:
- Oleg QA retest.
- Production deploy remains blocked until QA PASS.

P0 Scanner HMAC integration follow-up:
- Removed scanner-to-Core Bearer authentication and the quota bypass path.
- Scanner now uses Web Crypto HMAC-SHA256 and Core contract `1.1` with `X-Key-Id`, unique transport `X-Request-Id`, Unix `X-Timestamp`, and `X-Signature`.
- The canonical request covers timestamp, key ID, transport request ID, HTTP method, pathname, canonical query, and SHA-256 of the exact JSON body.
- Added dedicated `CORE_HMAC_KEY_ID` and `CORE_HMAC_SECRET`; legacy `INTERNAL_API_SECRET` is not used as a production fallback.
- Core access check always runs before scanner cache reads, Yahoo providers, and Telegram delivery.
- `allowed=false`, Core timeout/unavailability, HMAC rejection, and malformed Core responses fail closed.
- Scanner sends real signed cache metadata hints; Core decides cache eligibility from its committed cache ledger.
- New and refresh decisions require a Core-issued receipt followed by a separate HMAC cache commit after local persistence.
- Signatures, signing secrets, and full authentication headers are never logged or returned.
- Scanner D1 migration: none.
- Smoke suite PASS: 34 tests, including valid HMAC, no Bearer header, unique transport request IDs, body-bound signatures, Core-first ordering, wrong HMAC, denied access, unavailable Core, and invalid/expired/mismatched/missing cache claims.

Integration blocker:
- This report is superseded by the 2026-07-02 receipt/commit implementation report below.
- Production remains blocked until dev end-to-end HMAC QA and Oleg QA pass.
```

## Task For Oleg - QA

Priority: P1
Status: ready for retest after Grisha DONE

Goal:
Validate quota/cache/access behavior and regression safety.

Test scenarios:

1. New regular analysis:
   - expected `chargeUnits=1`;
   - analysis runs.
2. Same user, same ticker, regular report within 1 hour:
   - expected `chargeUnits=0`;
   - cached/recent report is returned.
3. Different user, same ticker, fresh regular cached report:
   - expected `chargeUnits=0.5`;
   - cached report is returned.
4. Force refresh regular:
   - expected `chargeUnits=1`;
   - new analysis runs.
5. New FundRep:
   - expected `chargeUnits=3`;
   - FundRep analysis runs.
6. Same user, same FundRep within 1 hour:
   - expected `chargeUnits=0`;
   - recent FundRep is returned.
7. Different user, fresh cached FundRep:
   - expected `chargeUnits=1.5`;
   - cached FundRep is returned.
8. No quota:
   - scanner does not run analysis;
   - structured rejected response is returned.
9. Quota service unavailable in production:
   - scanner does not run analysis;
   - structured failed/rejected response is returned.
10. Language from upstream contract:
   - report language matches contract value.
11. Regression:
   - valid contract payload still works.
   - missing `contractVersion` still rejected.
   - duplicate `requestId` still idempotent.
   - `delivery.sendToTelegram=false` still does not send Telegram.
   - tokens in payload are still rejected/ignored according to security rules.

Acceptance criteria:

```text
- All quota/cache scenarios are tested.
- Security regressions are checked.
- Contract response format remains stable.
- QA report includes PASS/FAIL per scenario.
```

### Oleg Report

Manager note:

```text
The earlier BLOCKED/FAIL QA result below was recorded before Grisha completed
the scanner-side quota/access implementation.

Grisha now reports DONE, and manager smoke verification passed:
- node --check cloudflare\worker.js
- npm.cmd run test:worker-contract
- result: 13 contract/security/access checks passed

Oleg should now rerun the quota/cache/access QA suite against the current
implementation and update this section with fresh PASS/FAIL results.
```

Status:

```text
BLOCKED / FAIL
```

Command / checks:

```text
Read team-manifest.md and confirmed Oleg/QA scope.

npm.cmd run test:worker-contract - PASS

Regression smoke results:
- valid contract payload - PASS
- missing contractVersion - PASS
- wrong ticker format - PASS
- duplicate requestId idempotency - PASS
- scanner response format - PASS
- delivery.sendToTelegram=false - PASS
- service token must be in header - PASS
- clear-logs admin protection - PASS
- Telegram webhook secret protection - PASS

Quota/access implementation discovery:
- Searched Worker/tests for INTERNAL_API_SECRET, /api/internal/access/check, access/check, quotaDecision, chargeUnits, forceRefresh, reportType, BYPASS_QUOTA_CHECK.
- Result: quota/access integration terms are present only in docs, not in Worker runtime or automated tests.

Production fail-closed smoke:
- Ran POST /api/external/analyze with APP_ENV=production, SERVICE_TOKEN, INTERNAL_API_SECRET, ACCESS_CHECK_URL, userId, chatId, language.
- Expected: scanner calls /api/internal/access/check before analysis and fails closed if unavailable/rejected.
- Actual: accessCheckCalls=0, yahooCalls=1, HTTP 200, contract status=processed, rows=1.

Scenario status:
1. New regular analysis / chargeUnits=1 - BLOCKED, quota pre-check not implemented.
2. Same user same ticker within 1h / chargeUnits=0 - BLOCKED, ownership/quota decision not implemented in scanner contract flow.
3. Different user cached regular / chargeUnits=0.5 - BLOCKED, shared cached billing decision not implemented.
4. Force refresh regular / chargeUnits=1 - BLOCKED, forceRefresh not implemented in scanner contract flow.
5. New FundRep / chargeUnits=3 - BLOCKED, external contract FundRep quota path not implemented.
6. Same user FundRep within 1h / chargeUnits=0 - BLOCKED.
7. Different user cached FundRep / chargeUnits=1.5 - BLOCKED.
8. No quota - FAIL, scanner currently does not call access check and can run analysis.
9. Quota service unavailable in production - FAIL, scanner currently does not fail closed.
10. Language from upstream contract - BLOCKED/PARTIAL, contract accepts extra language field but quota/report language behavior is not proven by implementation.
11. Regression/security - PASS for existing smoke scope.
```

Findings:

```text
1. [P1] Quota/access pre-check is not implemented in cloudflare/worker.js. Scanner does not call POST /api/internal/access/check before analysis.
2. [P1] Production fail-closed requirement is not met. In production-like local smoke, scanner processed AAPL and fetched Yahoo data without any quota/access call.
3. [P1] Required quota/cache scenarios cannot be fully tested yet because scanner does not expose or consume chargeUnits, quotaDecision, cacheStatus, reportSource, forceRefresh, or reportType in the runtime contract flow.
4. [P2] Existing regression/security tests still pass, so current contract/security behavior is stable, but this does not validate v1.1 quota/cache/access acceptance criteria.
```

Recommendation:

```text
Not ready for Ilya dev/prod quota gate.

Return to Grisha for implementation of scanner-side access/quota pre-check:
- call market-signal-ai-bot POST /api/internal/access/check before paid analysis;
- use Authorization: Bearer <INTERNAL_API_SECRET>;
- do not accept quota/balance/tariff decisions from public payload;
- do not run analysis when allowed=false;
- fail closed in production when quota service is unavailable;
- add automated tests for quota allowed, quota denied, quota service unavailable, forceRefresh, language pass-through, and cached/own-repeat metadata.

After Grisha marks implementation DONE, Oleg should rerun this QA suite and update scenario statuses from BLOCKED to PASS/FAIL.
```

### Oleg Retest Report - 2026-06-26

Status:

```text
FAIL
```

What was done:

```text
Reran QA against Grisha's current quota/access implementation after manager marked
the previous BLOCKED/FAIL report as historical.

Verified:
- access allowed path;
- allowed=false path;
- quota service unavailable in production;
- forbidden business fields;
- language/reportType/forceRefresh pass-through;
- delivery.sendToTelegram=false regression;
- duplicate requestId idempotency;
- manager HTTP status policy;
- regular and FundRep cached_report scenarios.
```

What was checked:

```text
npm.cmd run test:worker-contract - PASS

Smoke tests passed:
- testValidContractPayload
- testAccessCheckAllowsAnalysis
- testAccessCheckRejectsBeforeAnalysis
- testProductionFailsClosedWhenAccessUnavailable
- testQuotaBusinessFieldsRejected
- testMissingContractVersion
- testWrongTickerFormat
- testDuplicateRequestId
- testScannerResponseFormat
- testDeliverySendToTelegramFalse
- testServiceTokenRequiredInHeader
- testClearLogsRequiresAdminToken
- testTelegramWebhookSecretRequired

Additional QA matrix:
1. New regular analysis, chargeUnits=1 - PASS
   Access check is called once, analysis runs, Yahoo is called once.

2. Same user regular repeat within 1h, chargeUnits=0, reportSource=cached_report - FAIL
   Access metadata is returned, but scanner still runs a fresh provider call when
   no scanner-owned cached report is available in the test environment.

3. Different user regular cached report, chargeUnits=0.5, reportSource=cached_report - FAIL
   Access metadata is returned, but scanner still runs a fresh provider call.

4. Force refresh regular, chargeUnits=1 - PASS
   forceRefresh=true is passed to access check and analysis runs.

5. New FundRep, chargeUnits=3 - FAIL
   reportType=fundrep is passed to access check, but contract response still has
   report.analysisType=technical instead of fundamental.

6. Same user FundRep repeat within 1h, chargeUnits=0, reportSource=cached_report - FAIL
   Access metadata is returned, but scanner still runs a provider call.

7. Different user cached FundRep, chargeUnits=1.5, reportSource=cached_report - FAIL
   Access metadata is returned, but scanner still runs a provider call.

8. No quota / allowed=false - PASS
   HTTP 200, status=rejected, code=rejected_no_quota, no Yahoo analysis call.

9. Quota service unavailable in production - PASS
   HTTP 503, status=failed, code=failed_quota_service, no Yahoo analysis call.

10. Language from upstream contract - PASS
   language is passed to access check and appears in report.language.

11. Forbidden business fields in public payload - PASS
   HTTP 400, status=rejected, rejected before access check and before analysis.

12. delivery.sendToTelegram=false - PASS
   No Telegram send call.

13. duplicate requestId - PASS
   Previous contract result is returned; no second access check or analysis call.

HTTP status policy spot checks:
- Invalid contract payload - PASS: HTTP 400, status=rejected.
- Authentication failure - PASS: HTTP 403, status=rejected.
- Business access rejection - PASS: HTTP 200, status=rejected.
- Quota service unavailable - PASS: HTTP 503, status=failed.
- Provider HTTP 500 after access allowed - FAIL/POLICY MISMATCH:
  actual HTTP 200, status=processed, error code=data_provider_error.
  Manager policy says provider/scanner failure should be HTTP 500 or 502/503
  with status=failed depending on source.
```

Issues:

```text
1. [P1] cached_report is not honored as a no-new-analysis path.
   When access check returns reportSource=cached_report for regular or FundRep,
   scanner still runs provider analysis if no scanner-owned cached report is
   available in the current runtime path. This can break the quota/cache promise:
   own repeat and shared cached reports should return cached/recent report data.

2. [P1] External contract FundRep path is not implemented as fundamental analysis.
   reportType=fundrep is passed to access check, but /api/external/analyze still
   returns report.analysisType=technical. This fails New FundRep and cached FundRep
   acceptance criteria.

3. [P1] Provider error HTTP/status behavior does not match manager policy.
   Yahoo/provider HTTP 500 after access approval returns HTTP 200 with
   status=processed and errors[0].code=data_provider_error. Manager policy requires
   provider/scanner failure to use failed status with HTTP 500 or 502/503 depending
   on source.

4. [P2] Scanner result cache TTL appears to be 15 minutes, while product quota
   model says CACHE_TTL=1 hour. If scanner-owned cached reports are required for
   reportSource=cached_report, TTL alignment must be confirmed or adjusted.
```

Risks:

```text
- Users may be charged discounted/no-charge cached flows while scanner performs
  fresh provider work, which can create cost, latency, and consistency issues.
- FundRep users may be charged 3 units but receive a technical report.
- API consumers may treat provider failures as successful processed responses.
```

Recommendation:

```text
Not ready for Ilya dev/prod quota gate.

Return to Grisha for fixes:
1. Implement scanner-owned cached_report behavior for regular and FundRep, or
   explicitly fail if access service returns cached_report and scanner has no
   matching cached report.
2. Implement /api/external/analyze reportType=fundrep as fundamental analysis, or
   block FundRep in the contract until the path is ready.
3. Align provider/scanner failure HTTP status with manager policy.
4. Confirm scanner technical cache TTL against the accepted 1 hour cache model.

After fixes, rerun:
- npm.cmd run test:worker-contract
- Oleg quota/cache/access QA matrix above.
```

Suggestions for improvement:

```text
Suggestion:
Add explicit automated tests for reportSource=cached_report and reportType=fundrep.

Why it helps:
The current smoke suite proves access pre-check basics, but not the cached report
or FundRep user-facing outcomes.

Who should handle it:
Grisha for implementation/tests, Oleg for QA validation.

Priority:
P1

Risk:
Without these tests, quota/cache regressions can pass smoke tests.

Estimated effort:
Medium.
```

### Oleg Retest Report - 2026-06-28

Status:

```text
FAIL
```

Checked:

```text
1. Access allowed -> analysis runs - PASS
   HTTP 200, status=processed, accessCalls=1, Yahoo calls=1.

2. allowed=false -> analysis does not run - PASS
   HTTP 200, status=rejected, accessCalls=1, Yahoo calls=0.

3. Quota service unavailable in production -> analysis does not run - PASS
   HTTP 503, status=failed, code=failed_quota_service,
   accessCalls=1, Yahoo calls=0. Production bypass was not honored.

4. Forbidden business fields are rejected before access check - PASS
   Payload with chargeUnits was rejected with HTTP 400/status=rejected;
   accessCalls=0, Yahoo calls=0.

5. Language is passed from upstream contract - FAIL
   Input language=pl was normalized to language=ru before the access request.
   The access service therefore did not receive the upstream-defined language.
   Existing automated coverage only checks language=ru and does not expose this.

6. reportType and forceRefresh are passed to access check - PASS
   Input reportType=fundrep and forceRefresh=true reached the access request
   with the same values.

7. delivery.sendToTelegram=false regression - PASS
   telegram.sendToTelegram=false, delivered=false, Telegram calls=0.

8. Duplicate requestId regression - PASS
   The second request returned the first result; total accessCalls=1 and
   Yahoo calls=1, so access and analysis were not repeated.

9. HTTP status policy - PASS
   - invalid payload: HTTP 400 + status=rejected;
   - authentication failure: HTTP 403 + status=rejected;
   - no quota/no access: HTTP 200 + status=rejected;
   - quota service unavailable: HTTP 503 + status=failed.
```

Regression:

```text
npm.cmd run test:worker-contract - PASS (18/18)

The suite also confirms:
- provider failure -> HTTP 502 + status=failed;
- internal scanner failure -> HTTP 500 + status=failed;
- regular cached report is returned without a provider call;
- missing promised cache fails closed;
- cached FundRep fails closed without a provider call.
```

Findings:

```text
1. [P1] Upstream language is not preserved for unsupported locale codes.
   normalizeLanguage delegates to normalizeReportLanguage, which falls back to
   ru when the input is not in the scanner translation table. This conflicts
   with the accepted contract rule that language is upstream-defined and must
   be passed to the access check.
```

Recommendation:

```text
Cannot mark quota/cache/access QA as PASS yet.

Return to Grisha to separate contract language pass-through from report text
localization, or have the manager explicitly restrict the contract's allowed
language values. Add an automated case with a non-ru/en/he upstream language.

After this fix, rerun npm.cmd run test:worker-contract and the focused language
pass-through smoke. The remaining requested quota/access and HTTP scenarios are
ready for release.
```

### Oleg Language Retest Report - 2026-06-29

Status:

```text
PASS
```

Checked:

```text
1. Unsupported language pl is rejected before access check - PASS
   HTTP 400, status=rejected, field=language, code=unsupported_language.
   Access calls=0, Yahoo calls=0, Telegram calls=0.

2. Supported locale aliases are normalized correctly - PASS
   - en-US -> en;
   - ru-RU -> ru;
   - he-IL -> he;
   - iw -> he.

3. Report language matches the canonical contract language - PASS
   For all four aliases, access request language and report.language matched
   the expected canonical value.

4. Telegram output does not contain requestId - PASS
   Verified by the contract language smoke cases and Telegram webhook regression.

5. FundRep user-facing output does not contain requestId - PASS
   End-to-end Telegram command smoke verified both the FundRep summary message
   and generated HTML document. requestId/request= was absent from all artifacts.

6. Existing tests remain green - PASS
   npm.cmd run test:worker-contract - PASS (20/20).
   node --check cloudflare/worker.js - PASS.
```

Findings:

```text
No release-blocking findings in the requested language and requestId scope.
The language defect recorded in the 2026-06-28 report is fixed.
```

Recommendation:

```text
Quota/cache/access QA language follow-up is ready to pass to the Ilya
dev/production gate. Production release remains subject to the DevOps gate,
secret configuration, deployment smoke checks, and rollback readiness.
```

### Oleg FundRep Cache Retest Report - 2026-06-29

Status:

```text
PASS
```

Checked:

```text
1. New FundRep structured JSON - PASS
   HTTP 200, status=processed, report.analysisType=fundamental,
   report.reportType=fundrep, structured fundamentalResults present.

2. FundRep cache hit without provider calls - PASS
   report.cacheStatus=hit; chart and fundamental provider calls=0.

3. FundRep cache miss/expiry - PASS
   Missing or expired promised cache returns HTTP 503, status=failed,
   code=fundrep_cache_not_found, without provider calls.

4. Force refresh - PASS
   forceRefresh=true bypasses caches, calls chart and fundamental providers,
   returns report.cacheStatus=refreshed, and replaces the cached result.

5. Multi-ticker mixed cache - PASS
   Cached FMIX and fresh FNEW2 were merged in request order;
   report.cacheStatus=mixed and only the fresh ticker called fundamentals.

6. Cache isolation - PASS
   Regular and FundRep caches do not intersect. FundRep cache entries are also
   isolated by canonical language and generationVersion.

7. Provider failure is not cached - PASS
   Fundamental provider failure returns HTTP 502/status=failed. A following
   cached_report request returns HTTP 503/fundrep_cache_not_found.

8. requestId idempotency - PASS
   Duplicate FundRep requestId returned the original ticker/result and did not
   repeat fundamental analysis or Telegram delivery.

9. API contains no HTML - PASS
   Structured report JSON contains no doctype/html document payload.

10. Telegram privacy - PASS
    FundRep summary, caption, and HTML document contain neither requestId nor
    quotaDecision, chargeUnits, remainingUnits, reportSource, or cacheStatus.

11. RU/EN/HE language isolation - PASS
    FundRep API and Telegram artifacts were checked for ru-RU, en-US, and he-IL.
    Canonical report languages were ru/en/he and foreign-language labels did not
    leak into the user-facing output.

12. D1 analysis_cache key and TTL - PASS
    D1-compatible binding smoke captured:
    key=fundrep-report:FD1X:fundrep:he:v42
    kind=fundrep_report
    TTL=3600 seconds (60 minutes)
    cached payload analysisType=fundamental.
```

Regression:

```text
npm.cmd run test:worker-contract - PASS (30/30)
node --check cloudflare/worker.js - PASS
```

Findings:

```text
No release-blocking findings in the requested FundRep/cache scope.
```

Recommendation:

```text
FundRep API/cache implementation is ready for the Ilya dev/production gate.
The D1 assertion above used a local D1-compatible binding; deployed environment
health, real D1 persistence, secrets, and rollback remain part of the DevOps gate.
```

### Oleg P0 HMAC QA Report - 2026-07-01

Status:

```text
FAIL
```

Checked:

```text
1. Correct HMAC signature - PASS
   Core accepted Web Crypto HMAC-SHA256 over timestamp, key ID, unique transport
   request ID, method, path, canonical query, and exact body hash. No Bearer header.

2. Wrong secret and wrong key ID - PASS
   Both fail closed with HTTP 503/status=failed; Yahoo and Telegram calls=0.

3. Body changed after signing - PASS
   Core signature verification rejected the changed body; scanner failed closed.

4. Old timestamp - PASS
   A timestamp 10 minutes old was rejected; Yahoo and Telegram calls=0.

5. Repeated transport nonce - PASS
   Simulated Core HTTP 409 replay rejection produced HTTP 503/status=failed;
   no provider or Telegram calls. Multi-ticker requests use unique transport IDs.

6. Receipt and cache commit protocol - SUPERSEDED
   The current contract uses Core-issued receipts and a separate signed cache
   commit. See the 2026-07-02 Grisha report below.

7. Core allowed=false - PASS
   HTTP 200/status=rejected; Core was the only external call.

8. Core timeout, HTTP 404, HTTP 500, and invalid JSON - PASS
   Every case failed closed with HTTP 503/status=failed/code=failed_quota_service.
   Yahoo and Telegram calls=0 in every case.

9. No cache/provider/Telegram activity on authentication rejection - PASS
   D1-compatible binding smoke: analysis_cache reads=0, Yahoo calls=0,
   Telegram calls=0 after Core HTTP 401.

10. Idempotency without repeated charge decision - FAIL
    First request: Core calls=1, Yahoo calls=1.
    Duplicate business requestId: previous scanner result was returned and Yahoo
    was not repeated, but Core was called again. Total Core calls=2.
    The duplicate uses a new transport nonce and reaches Core before scanner reads
    contract_results, so scanner does not guarantee that charging is performed once.

11. Regular/FundRep/cache regression - PASS
    Existing access, regular cache, FundRep cache, refresh, mixed cache, provider
    failure, language, Telegram privacy, and contract tests remain green.

12. Authentication data is absent from logs - PASS
    Inspected request_logs/ticker_request_logs values after Core auth rejection.
    HMAC secret, key ID, X-Signature, signature value, Authorization header, and
    secret variable names were absent.
```

Regression:

```text
npm.cmd run test:worker-contract - PASS (34/34)
node --check cloudflare/worker.js - PASS
```

Findings:

```text
1. [P0] Duplicate requestId repeats the Core access/charge call.
   runContractAnalysisFromPayload calls checkContractAccessForTickers before
   getContractResult. The saved scanner response prevents repeated analysis and
   Telegram delivery, but it does not prevent a second Core billing decision.

2. [P1] Automated idempotency tests do not assert Core/access call count.
   The current tests assert one Yahoo/fundamental call, so the P0 billing replay
   regression passes the 34-test suite.
```

Recommendation:

```text
Do not release the HMAC/quota integration yet.

Return to Grisha to make billing idempotency explicit and atomic. A duplicate
requestId must return the original result without a second charge, while also
being bound to the original caller/request identity or payload hash. Add regular
and FundRep tests that assert exactly one Core access call across duplicates.

After the fix, rerun the 34-test suite and this focused P0 HMAC matrix.
```

## Task For Ilya - DevOps / Cloudflare

Priority: P0 for production gate, P1 for quota secrets
Status: ready after QA retest, production still blocked until gate passes

Goal:
Prepare production gate and environment for scanner v1.1.

Production gate tasks:

1. Configure production secrets:
   - `TELEGRAM_WEBHOOK_SECRET`
   - `ADMIN_TOKEN`
   - `SERVICE_TOKEN`
   - `INTERNAL_API_SECRET`
2. Confirm no secrets are stored in repository.
3. Backup production D1 before migration:
   - export production D1 to backup file.
4. Apply production D1 migration if needed.
5. Deploy production Worker.
6. Reset Telegram webhook with `secret_token`.
7. Run production health checks:
   - `GET /api/status`
   - `POST /api/external/analyze` with service token
   - duplicate `requestId`
   - `delivery.sendToTelegram=false`
   - Telegram webhook missing/wrong/valid secret
   - `/api/clear-logs` missing/wrong/admin token
   - D1 required tables
8. Add quota/access health check when Grisha finishes implementation.
9. Confirm rollback command and last known good version.

Acceptance criteria:

```text
- Production secrets are configured.
- Production D1 is backed up.
- Production Worker is deployed.
- Telegram webhook is reset with secret_token.
- Production health checks pass.
- Rollback plan is documented.
- Production is not released if quota/access check is required but unavailable.
```

### Ilya Report

Status:

```text
FAIL - production gate not ready; QA current result is FAIL
```

Environment:

```text
dev: PASS for previous P0 security/Telegram gate
production: FAIL / blocked for v1.1 production gate
```

Checks:

```text
2026-06-26 Ilya check:

Config:
- wrangler.worker.toml has separate Workers:
  - dev: stock-signal-scanner-dev
  - production: stock-signal-scanner-production
- wrangler.worker.toml has separate D1 databases:
  - dev: stock_signal_scanner_dev
  - production: stock_signal_scanner_production
- package.json has production commands:
  - npm run cf:d1:migrate:production
  - npm run cf:deploy:production

Repository secret scan:
- PASS: no obvious TELEGRAM_BOT_TOKEN / SERVICE_TOKEN / WEBHOOK_TOKEN / ADMIN_TOKEN /
  TELEGRAM_WEBHOOK_SECRET / INTERNAL_API_SECRET values found in repository scan.
- Note: scan excluded node_modules, .git, .wrangler, .wrangler-config.

Dev reference state:
- Dev P0 gate is PASS in docs/ilya-p0-security-devops-report.md.
- Dev Telegram webhook check is PASS in docs/ilya-dev-telegram-webhook-check.md.
- Dev bot @Stock_Signal_Scanner_bot points to dev Worker.
- Dev GET /api/status is online.

Production status:
- GET https://stock-signal-scanner-production.fnemoy.workers.dev/api/status:
  - HTTP 200
  - environment: production
  - Worker is online
- Production D1 required-table check:
  - request_logs exists
  - contract_results missing
  - analysis_tasks missing
  - analysis_cache missing
  - ticker_request_logs missing
- Production D1 migration has NOT been applied in this pass.
- Production D1 backup has NOT been exported in this pass.
- Production Worker has NOT been deployed in this pass.
- Production Telegram webhook has NOT been reset in this pass.
- Production valid-token health checks have NOT been run in this pass.
- Production versions were read with operator-approved Wrangler access.
  Latest visible production version:
  - d73ccba6-fe20-4475-8df4-3fc5df2cde5a
  - created: 2026-06-22T16:11:43.967Z
  - source: Secret Change
- Production secret names were read with operator-approved Wrangler access.
  Present production secrets:
  - ADMIN_TOKEN
  - SERVICE_TOKEN
  - TELEGRAM_BOT_TOKEN
  - TELEGRAM_CHAT_ID
  - TELEGRAM_WEBHOOK_SECRET
  - WEBHOOK_TOKEN
- Missing required production secret:
  - INTERNAL_API_SECRET
- Current production version view does not show ACCESS_CHECK_URL or MARKET_SIGNAL_AI_BOT_URL.
- Current production version view shows TELEGRAM_BOT_TOKEN also as a plain Environment Variable.
  This must be removed from plain variables and kept only as a secret.

Quota/access readiness:
- Manager now accepted Grisha implementation for QA.
- Runtime code contains scanner-side access/quota integration markers:
  INTERNAL_API_SECRET, ACCESS_CHECK_URL, MARKET_SIGNAL_AI_BOT_URL,
  BYPASS_QUOTA_CHECK, quotaDecision, chargeUnits, reportType, forceRefresh, language.
- CLOUDFLARE_DEPLOY.md documents INTERNAL_API_SECRET and access-check URL setup.
- Current local smoke run from Ilya session before Oleg's updated report:
  - node --check cloudflare/worker.js: PASS
  - npm.cmd run test:worker-contract: FAIL
  - failing test: testAccessCheckRejectsBeforeAnalysis
  - actual HTTP status: 200
  - test expected HTTP status: 400
- This appears aligned with manager's later HTTP policy:
  business rejection from quota/access service should use HTTP 200 with status=rejected.
- Oleg later reran the QA matrix and current result is NOT ready for Ilya dev/prod quota gate.
  Current QA failures include cached_report behavior, FundRep external contract path,
  and provider failure HTTP/status policy.
- Quota/access production health check is still BLOCKED until:
  1. Grisha fixes current QA findings and Oleg returns current QA PASS.
  2. market-signal-ai-bot production access endpoint is available.
  3. production INTERNAL_API_SECRET and ACCESS_CHECK_URL or MARKET_SIGNAL_AI_BOT_URL
     are configured.
```

Issues:

```text
1. [P0] Production D1 is missing required v1.1/P0 tables except request_logs.
2. [P0] Production D1 backup has not been exported before migration.
3. [P0] Production INTERNAL_API_SECRET is missing.
4. [P0] Production ACCESS_CHECK_URL / MARKET_SIGNAL_AI_BOT_URL is not visible in current production version config.
5. [P0] Production deploy and health checks are not complete.
6. [P0] Do not release production until Oleg returns current QA PASS; current QA is FAIL.
7. [P0] Current production Worker config shows TELEGRAM_BOT_TOKEN as a plain Environment Variable.
   It must be removed from plain vars and kept only as a secret.
8. [P1] Production /api/status is online but appears to be old/partially migrated state.
9. [P1] Latest visible production version d73ccba6-fe20-4475-8df4-3fc5df2cde5a is a Secret Change,
   not proof that current v1.1 code is deployed.
```

Rollback:

```text
Before any production deploy:
1. Capture current production Worker version:
   npx.cmd wrangler versions list --config wrangler.worker.toml --env production
   Current captured candidate from 2026-06-26:
   d73ccba6-fe20-4475-8df4-3fc5df2cde5a
2. Export production D1 backup:
   npx.cmd wrangler d1 export stock_signal_scanner_production --remote --output .deploy/backups/stock_signal_scanner_production-YYYYMMDD-HHMMSS.sql
3. Apply migration only after backup exists:
   npm.cmd run cf:d1:migrate:production
4. Deploy production:
   npm.cmd run cf:deploy:production
5. If deploy fails or health checks fail, rollback Worker:
   npx.cmd wrangler rollback <VERSION_ID> --config wrangler.worker.toml --env production
6. If migration partially fails, do not run destructive SQL automatically.
   Assess D1 state from backup/export and restore path before further writes.
```

Recommendation:

```text
Do NOT release production.

Next steps for Ilya:
1. Run production gate from operator-side authenticated PowerShell, not this sandbox.
2. Wait for Grisha fixes and Oleg current QA PASS; do not deploy production before that.
3. Confirm market-signal-ai-bot production access endpoint.
4. Configure missing production INTERNAL_API_SECRET.
5. Configure production ACCESS_CHECK_URL or MARKET_SIGNAL_AI_BOT_URL.
6. Remove TELEGRAM_BOT_TOKEN from plain production environment variables if present;
   keep it only as a secret.
7. Export production D1 backup.
8. Capture/confirm last known good Worker version.
9. Apply production D1 migration.
10. Deploy production Worker.
11. Reset production Telegram webhook with secret_token.
12. Run full production health checks, including quota/access fail-closed check.

Production-gate report must remain FAIL until all acceptance criteria pass.
```

### Ilya Production Release Gate - 2026-06-29

```text
DevOps Report

Environment: production
Status: FAIL - release stopped before backup/migration/deploy

Deployed:
- Worker version: not deployed; active version remains d73ccba6-fe20-4475-8df4-3fc5df2cde5a
- D1 migration: NOT RUN
- D1 backup: NOT CREATED because the gate stopped before production changes
- Secrets checked: FAIL
- Endpoint health: FAIL / blocked

Pre-deploy verification:
- node --check cloudflare/worker.js - PASS
- npm.cmd run test:worker-contract - PASS (30 checks)
- repository secret scan - PASS; only the documented placeholder in .dev.vars.example was found
- active production deployment captured - PASS
- SERVICE_TOKEN secret - PRESENT
- TELEGRAM_WEBHOOK_SECRET secret - PRESENT
- ADMIN_TOKEN secret - PRESENT
- TELEGRAM_BOT_TOKEN secret - PRESENT
- INTERNAL_API_SECRET secret - MISSING
- ACCESS_CHECK_URL / MARKET_SIGNAL_AI_BOT_URL binding - MISSING
- production access endpoint authenticated check - NOT RUN: signing configuration is absent
- unauthenticated endpoint probe - INCONCLUSIVE: network request timed out in the operator session

Security/configuration finding:
- Active Worker version contains a secret_text TELEGRAM_BOT_TOKEN binding.
- Active Worker version also contains an accidental plain_text binding named
  "TELEGRAM_BOT_TOKEN " (trailing space). Its value was not printed or inspected.
- The accidental plain binding must be removed by the next safe deployment/config cleanup.

Integration finding:
- stock-signal-scanner currently authenticates access checks with
  Authorization: Bearer <INTERNAL_API_SECRET>.
- market-signal-ai-bot production contract accepts HMAC-SHA256 only and requires
  X-Key-Id, X-Request-Id, X-Timestamp and X-Signature.
- market-signal-ai-bot explicitly rejects Bearer authentication.
- Therefore the current scanner build cannot pass the real production
  /api/internal/access/check even if INTERNAL_API_SECRET is added.

Checks:
- production /api/internal/access/check - FAIL: availability was not confirmed and authentication contract is incompatible
- production configuration - FAIL
- D1 backup - NOT RUN
- D1 schema migration - NOT RUN
- required D1 tables - NOT RECHECKED; migration was not allowed to start
- Worker deploy with --env production - NOT RUN
- Telegram webhook reset - NOT RUN
- GET /api/status after deploy - NOT RUN
- missing/wrong service token - NOT RUN
- regular analysis - NOT RUN
- duplicate requestId - NOT RUN
- delivery.sendToTelegram=false - NOT RUN
- FundRep new/cache - NOT RUN
- unsupported language - NOT RUN
- Telegram webhook missing/wrong/valid secret - NOT RUN
- clear-logs missing/wrong token - NOT RUN
- successful production clear-logs - NOT RUN as required
- D1 write/read and 60-minute TTL - NOT RUN

Issues:
1. [P0] Production scanner is missing INTERNAL_API_SECRET.
2. [P0] Production scanner is missing ACCESS_CHECK_URL or MARKET_SIGNAL_AI_BOT_URL.
3. [P0] Scanner uses Bearer auth while production core requires HMAC-SHA256 headers.
4. [P0] Accidental plain_text binding "TELEGRAM_BOT_TOKEN " must be removed.

Rollback plan:
- last known good version: d73ccba6-fe20-4475-8df4-3fc5df2cde5a
- exact rollback command:
  npx.cmd wrangler rollback d73ccba6-fe20-4475-8df4-3fc5df2cde5a --config wrangler.worker.toml --env production
- rollback executed: NO; no Worker deploy or D1 change occurred
- migration risk: none introduced during this gate; production D1 was not modified

Required before rerun:
1. Align scanner authentication with the market-signal-ai-bot HMAC contract.
2. Add a production key ID binding and matching signing secret on both services.
3. Configure the exact production ACCESS_CHECK_URL.
4. Remove the accidental plain_text TELEGRAM_BOT_TOKEN binding.
5. Rerun QA for the real HMAC integration, then restart this gate from D1 backup.

Recommendation:
Нельзя выпускать дальше. Production remains unchanged.
```

### Ilya Dev Integration Completion And Production Gate Resume - 2026-06-30

```text
Dev completion:
- Environment: dev
- requestId: news-2026-06-30-il-maya_alerts-8207
- Scanner HTTP status: 200
- Scanner contract status: processed
- access-check: PASS (confirmed by integration owner)
- delivery: PASS (confirmed by integration owner)
- token absent from logs: PASS
- direct retry no longer returns 403: PASS

Production gate resume:
- Status: FAIL / stopped before production changes
- Active rollback version: d73ccba6-fe20-4475-8df4-3fc5df2cde5a
- Local Worker syntax: PASS
- Contract/access/cache tests: PASS (30 checks)
- Production core /api/health: HTTP 200
- Production core /api/internal/access/check: HTTP 404
- Production Scanner INTERNAL_API_SECRET: MISSING
- Production Scanner ACCESS_CHECK_URL / MARKET_SIGNAL_AI_BOT_URL: MISSING
- Accidental plain_text binding "TELEGRAM_BOT_TOKEN ": STILL PRESENT

Actions intentionally not run after P0 detection:
- production D1 backup
- production D1 migration
- Worker deploy
- Telegram webhook reset
- regular/FundRep/cache health checks

P0 blockers:
1. Production access-check endpoint is not deployed at the confirmed production core URL.
2. Production Scanner access secret and access URL are not configured.
3. Scanner/core production authentication contract must be confirmed before deploy.
4. Accidental plain Telegram token binding must be removed.

Rollback readiness:
- No rollback executed because production Worker and D1 were not changed.
- Exact Worker rollback command:
  npx.cmd wrangler rollback d73ccba6-fe20-4475-8df4-3fc5df2cde5a --config wrangler.worker.toml --env production

Recommendation:
Production release remains blocked. Deploy the production core access endpoint and
configure the Scanner production access bindings before restarting the gate from D1 backup.
```

### Ilya P0 HMAC Deployment Readiness - 2026-07-01

```text
Status: BLOCKED / no production deploy

Completed:
- Scanner HMAC request signing is present.
- Local HMAC, cache-claim, replay/fail-closed contract suite: PASS (34 checks).
- Core dev /api/health: HTTP 200.
- Core dev /api/internal/access/check without signature: HTTP 401.
- Core production /api/health: HTTP 200.
- Clock skew: approximately 36 seconds; acceptable for the five-minute window.
- Safe key rotation and two-sided rollback runbook prepared:
  docs/ilya-hmac-deployment-runbook.md

Blocked:
- Core production /api/internal/access/check returns HTTP 404.
- Roman and Lena production PASS is not recorded.
- Core dev already has a protected multi-key map; it must be merged by Core DevOps,
  never overwritten without the protected source.
- Scanner dev/production CORE_HMAC_SECRET is not configured.

Proposed non-secret key IDs pending Core DevOps confirmation:
- dev: scanner-dev-v1
- production: scanner-prod-v1

Decision:
- No Core or Scanner secrets changed.
- No Scanner deploy performed.
- Production remains blocked until Core deploys first and Roman/Lena return PASS.
```

## Task For Anna - Marketing / Product Analyst

Priority: P2
Status: accepted, monitor after release

Goal:
Validate quota model after first user feedback and paid conversion signals.

Current accepted recommendation:

```text
REGULAR_NEW = 1
REGULAR_CACHED = 0.5
REGULAR_REFRESH = 1
FUNDREP_NEW = 3
FUNDREP_CACHED = 1.5
OWN_REPEAT_WITHIN_1H = 0
```

Follow-up tasks:

1. Review user feedback after release.
2. Check whether `0.5` cached regular price feels fair.
3. Check whether `3 units` for FundRep blocks adoption.
4. Decide if first FundRep should be discounted or included as welcome access.
5. Prepare user-facing wording for units, cached report, and force refresh.
6. Give recommendation if pricing should change in v1.2.

### Anna Report

Status:

```text
accepted
```

Comment:

```text
Recommendation accepted for v1.1:

- new regular analysis: 1 unit
- own repeat regular request within 1 hour: 0 units
- cached regular report for another user: 0.5 unit
- force refresh regular: 1 unit
- new FundRep: 3 units
- own repeat FundRep within 1 hour: 0 units
- cached FundRep for another user: 1.5 units

Why this model fits the first paid release:

1. The user does not pay twice for their own recent report.
   This protects trust and prevents the feeling that units were charged unfairly after reopening the same ticker/report.

2. Cached reports for other users are discounted, not free.
   The user still receives value, but the service can monetize popular tickers and avoid making cached analysis feel worthless.

3. Force refresh is priced as a new paid operation.
   The user explicitly asks for a fresh calculation, so the full 1 unit charge is fair if shown before confirmation.

4. FundRep is positioned as a premium report.
   3 units creates a clear value difference between regular analysis and deeper fundamental analysis.

5. Cached FundRep remains paid at 1.5 units.
   This keeps FundRep premium while giving users a visible discount for an already fresh report.

Risks to monitor after release:

- Cached regular at 0.5 unit may feel confusing if the interface does not clearly explain that it is a fresh discounted report.
- FundRep at 3 units may reduce first-time usage if users do not yet understand its extra value.
- Popular tickers may generate many cached purchases; this is good for margin, but the product must avoid looking like users are paying for stale data.
- A 1 hour cache window may be too short for low-volatility days or too long during volatile market events.
- Decimal units can be harder to understand than whole units if the UI does not show balances clearly.

What should be checked after release:

1. Conversion from Free/Basic users after they hit the regular analysis limit.
2. Share of cached regular reports purchased at 0.5 unit.
3. User complaints or confusion around cached report charges.
4. FundRep start rate and completion/open rate.
5. Whether users use force refresh intentionally or by mistake.
6. Support messages containing phrases like "charged twice", "old report", "why 0.5", or "why 3 units".

Recommendation for v1.1:

Keep the accepted model unchanged for the first paid release.
Do not optimize prices before observing real user behavior.

Possible v1.2 decisions:

- If cached regular feels unfair: test cached regular at 0 units only for paid users, or keep 0.5 but improve wording.
- If FundRep adoption is weak: offer first FundRep with a one-time discount or include one welcome FundRep in paid plans.
- If force refresh is clicked accidentally: require confirmation before charging.
- If decimal units confuse users: show "0.5 unit discount price" with clear remaining balance, or move cached charges to whole credits in a later pricing redesign.

Needs from manager/user:

No decision needed now.
After release, Anna needs basic usage data by report type, cache status, chargeUnits, tariff, and user complaints/support notes.

Manager answers reviewed:

- quota model remains accepted for v1.1;
- no pricing change is needed before the first paid release;
- decimal units are acceptable for v1.1 if the UI explains them clearly;
- if users are confused by 0.5 units, v1.2 can switch to whole credits, for example regular = 2 credits and cached regular = 1 credit;
- market-signal-ai-bot should log non-sensitive analytics for reportType, quotaDecision, cacheStatus, chargeUnits, tariff/plan, forceRefresh, language, insufficient quota events, no access events, and support tags.

Anna follow-up:

After release, compare actual user behavior against the accepted model before recommending changes.
Main signals for v1.2:
- cached regular usage and complaints about 0.5 unit;
- FundRep adoption at 3 units;
- accidental force refresh complaints;
- conversion after insufficient quota events;
- whether users understand remaining balance after decimal charges.

P0 HMAC / retry review - 2026-07-01:

Recommendation:

- HMAC does not change the analysis price and must never be a pricing factor.
- `chargeUnits` continues to depend only on report type, cache/ownership decision,
  and explicit force refresh under the accepted quota model.
- A failed HMAC check, replay rejection, Core timeout, or malformed Core response
  is a technical failure with 0 units charged. It is not a quota rejection.
- Production release remains blocked until one business `requestId` is proven to
  produce no more than one Core billing decision for both regular and FundRep.

Why:

- HMAC protects service-to-service transport; it does not create additional value
  for the user and therefore cannot justify a different price.
- A transport retry is not a new user purchase. Charging again would feel unfair
  and would make transient network failures a monetization event.
- Oleg's P0 QA found that the current scanner returns the saved analysis result but
  calls Core again before reading it. Therefore absence of a repeated charge on
  retry is not confirmed in the current implementation.
- A repeated transport nonce is rejected correctly, but this does not solve a retry
  of the same business `requestId` with a new transport nonce.

Risks:

- Core may make a second charge decision when the scanner retries the same business
  request, even though analysis and Telegram delivery are not repeated.
- Mixing Core failures with insufficient-quota events would inflate monetization
  funnel losses and hide reliability or authentication incidents.
- Treating replay protection as billing idempotency can create a false release PASS:
  they protect different layers and both are required.

What the developer must do:

1. Make billing idempotency explicit and atomic by business `requestId`, bound to
   the original caller and payload hash.
2. Return the original decision/result for a duplicate request without a second
   charge or a second Core billing decision.
3. Add regular and FundRep tests asserting exactly one Core charge decision across
   retries/replays of the same business request.
4. Record separate non-sensitive analytics categories:
   - `quota_denied`: `rejected_no_quota`;
   - `access_denied`: `rejected_no_access`;
   - `core_failed`: timeout/unavailable, HTTP 4xx/5xx authentication or contract
     failure, invalid JSON/response, invalid cache claim;
   - `replay_rejected`: repeated or stale transport authentication request;
   - `idempotent_repeat`: duplicate business request returned without a new charge.
5. Never include HMAC secrets, signatures, full authentication headers, or raw
   internal error bodies in analytics.

What the user should see:

- For Core/HMAC/replay technical failures: "Сейчас не удалось проверить доступ к
  анализу. Попробуйте ещё раз чуть позже." No units-charged message is shown.
- For insufficient quota: the separate approved no-quota message.
- For an idempotent retry: the original report and original charge information,
  without a second debit notification.

Decision status:

- HMAC price neutrality: CONFIRMED as product rule.
- Replay protection at transport level: PASS in Oleg's focused QA.
- No repeated billing decision on business retry: FAIL / release blocker until fixed
  and retested.
- Separate Core-versus-quota analytics taxonomy: FIXED in this recommendation;
  implementation remains required in `market-signal-ai-bot` analytics.
```

## Task For Masha - Designer

Priority: P3
Status: done

Goal:
Prepare user-facing wording and simple UI/Telegram presentation only after quota behavior is implemented.

Potential tasks:

1. Design Telegram wording for:
   - new analysis charged;
   - own recent report, no charge;
   - cached report discount;
   - force refresh confirmation;
   - FundRep charge;
   - insufficient quota.
2. Keep messages short and clear.
3. Avoid technical wording like `cache hit`, `quotaDecision`, or `requestId`.
4. Make sure report language follows upstream language.

### Masha Report

Status:

```text
DONE
```

Comment:

```text
What was done:
- Prepared user-facing Telegram wording for quota/cache/access states.
- Covered:
  - new regular analysis charged;
  - own recent regular report with no charge;
  - cached regular report with discount;
  - force refresh confirmation;
  - new FundRep charge;
  - cached FundRep discount;
  - own recent FundRep with no charge;
  - insufficient quota;
  - no access;
  - quota/access service unavailable.
- Kept wording short and avoided technical terms like `cache hit`, `quotaDecision`, and `requestId`.
- Added Russian and English templates so product/dev can map wording by upstream language.
- Added button label suggestions for Refresh/Cancel/Open report/Add units.

File prepared:
- `docs/masha-telegram-quota-wording.md`

Manager answers applied:
- Russian UI uses localized `юнит/юнита/юнитов`, not English `unit`.
- English UI uses `unit/units`.
- No-quota, no-access, quota-service-unavailable, and force-refresh wording now follows manager-approved copy.
- Support/contact target remains owned by `market-signal-ai-bot`; copy uses generic product actions until the final support channel is confirmed.

Recommendation:
- Use these texts in `market-signal-ai-bot`, not inside scanner.
- Keep quota/access wording above the analysis report, separate from the report body.
- Require confirmation before force refresh because it creates a new paid operation.
- Add localization keys for quota states before production release to avoid mixed-language messages.

Finalization update:
- Finalized one approved RU and EN message for every quota/access state.
- Prepared the complete `analysis.quota.*`, `analysis.access.*`, and `analysis.action.*` localization key set.
- Added an implementation-only state-to-key routing table.
- Limited user-facing placeholders to `{ticker}`, `{units}`, and `{remaining_units}`.
- Prohibited direct rendering of raw scanner/access fields, including `quotaDecision`, `cacheStatus`, `reportSource`, `chargeUnits`, `remainingUnits`, `reason`, and `requestId`.
- Added a safe fallback for unknown states: show the localized temporary-unavailability message and log technical details privately.

Access-message confirmation update:
- Confirmed access denied uses the existing `analysis.access.not_in_plan` RU/EN text.
- Confirmed access-check failures use the existing `analysis.access.temporarily_unavailable` RU/EN text.
- HMAC, signature, nonce, Core, stack traces, internal error codes, and raw failure reasons must never appear in user-facing messages.
- HMAC/signature/nonce/Core and unknown internal failures all map to the neutral temporary-unavailability localization key.
- Technical details may be recorded only in protected internal logs.

Risks:
- If bot implementation uses raw scanner fields, users may see technical wording.
- If localization keys are not added, Telegram messages may mix Russian/English.
- If refresh has no confirmation, users may feel accidentally charged.

Needs from manager/user:
- No open questions from Masha after manager answers.
```

## Manager Notes

Current decision:

```text
Billing, ownership, and quota ledger belong to market-signal-ai-bot.
Scanner remains the analysis API and may store only technical analysis/cache data.
```

Current blockers:

```text
1. market-signal-ai-bot must implement or confirm /api/internal/access/check.
2. Grisha must add scanner-side quota/access pre-check.
3. Ilya must finish production gate.
4. Oleg must validate quota/cache scenarios after implementation.
```

Next manager action:

```text
1. Oleg reruns QA on Grisha's DONE implementation.
2. Ilya prepares production gate but does not release until QA PASS and
   production access-check URL/secrets are confirmed.
3. Manager confirms market-signal-ai-bot owns billing, ownership, and quota ledger.
```

## Manager Review After Grisha Report

Status:

```text
ACCEPTED FOR QA
```

Summary:

```text
Grisha reports P1 quota/cache/access integration as DONE.
Manager local verification passed:
- node --check cloudflare\worker.js
- npm.cmd run test:worker-contract
- 13 checks passed

The implementation direction matches the accepted architecture:
- scanner checks access/quota before analysis;
- scanner fails closed in production;
- scanner uses INTERNAL_API_SECRET;
- scanner supports ACCESS_CHECK_URL or MARKET_SIGNAL_AI_BOT_URL;
- scanner keeps billing/tariff/subscription logic outside public payloads;
- scanner passes language/reportType/forceRefresh through the contract flow.
```

Manager comments:

```text
1. Good: scanner remains an Analysis API and does not become a billing service.
2. Good: production fail-closed behavior is implemented and covered by smoke tests.
3. Good: forbidden business fields in public payload are rejected before analysis.
4. Watch item: full report localization is still not complete if old report builders
   contain hardcoded Russian strings. This is acceptable only if v1.1 target language
   is Russian first, but it must become a localization task before multi-language release.
5. Watch item: multi-ticker access check is currently per ticker. If market-signal-ai-bot
   implements only batched quota decisions, contract must be aligned before production.
```

Next assignments:

```text
Oleg:
- rerun quota/cache/access QA on the current implementation;
- replace old BLOCKED/FAIL statuses with current PASS/FAIL;
- specifically verify allowed=false, quota service unavailable, forbidden business
  fields, language pass-through, and delivery.sendToTelegram=false regression.

Ilya:
- prepare production secrets and access-check URL;
- do not deploy production until Oleg returns PASS;
- after QA PASS, run production gate with INTERNAL_API_SECRET and ACCESS_CHECK_URL
  or MARKET_SIGNAL_AI_BOT_URL configured.

Masha:
- no immediate task until QA confirms behavior.
- after QA PASS, prepare user-facing wording for no quota, cached report, and force refresh.

Anna:
- no immediate change to quota model.
- monitor whether decimal units are easy for users to understand after first release.
```

## Manager Answers To Specialist Questions

Status:

```text
ACTIVE DECISIONS
```

## Answers To Grisha

Question:

```text
Should market-signal-ai-bot return cached report body when reportSource=cached_report,
or should scanner always return its own technical cached result after access approval?
```

Decision:

```text
Scanner should return the technical report body.
market-signal-ai-bot should return the access/quota/cache decision, not the analysis body.
```

Reason:

```text
This keeps the service boundary clean:
- market-signal-ai-bot owns user, quota, billing, ownership, and tariff decisions;
- stock-signal-scanner owns analysis results and technical report/cache data.

If market-signal-ai-bot starts returning report bodies, it becomes responsible for
analysis-result storage and report freshness, which blurs the architecture.
```

Implementation direction:

```text
1. market-signal-ai-bot decides whether the request is:
   - new_regular
   - own_repeat
   - cached_regular
   - refresh_regular
   - new_fundrep
   - own_repeat_fundrep
   - cached_fundrep
   - refresh_fundrep

2. market-signal-ai-bot returns:
   - allowed
   - chargeUnits
   - quotaDecision
   - cacheStatus
   - reportSource
   - remainingUnits
   - reason

3. scanner then:
   - runs new analysis if reportSource=new_analysis;
   - returns scanner-owned technical cached result if reportSource=cached_report;
   - returns rejected/failed if allowed=false.
```

Follow-up task:

```text
Grisha should confirm whether scanner already has enough technical cache storage
to return cached_report for regular and FundRep results.

If not, create a separate P1 task:
"Implement scanner technical report cache for reportSource=cached_report".
```

Question:

```text
Should access rejection use HTTP 400 permanently, or should API consumers receive
HTTP 200 with status=rejected for business rejections?
```

Decision:

```text
Use HTTP status by error type:

1. Invalid contract payload:
   - HTTP 400
   - status=rejected

2. Authentication/service token failure:
   - HTTP 403
   - status=rejected

3. Business rejection from quota/access service:
   - HTTP 200
   - status=rejected

4. Quota/access service unavailable:
   - HTTP 503
   - status=failed

5. Internal scanner/provider failure:
   - HTTP 500 or 502/503 depending on source
   - status=failed
```

Reason:

```text
No quota or no access is a valid business outcome, not a malformed request.
API consumers should be able to handle it through the contract body without treating
the whole integration as broken.

But invalid payload and auth failure should remain real HTTP errors.
Quota service unavailable is infrastructure failure and should not look like success.
```

Follow-up task:

```text
Grisha should verify current HTTP status behavior matches this policy.
If not, update worker and tests.
Oleg should add explicit assertions for HTTP status + contract status pairs.
```

## Answers To Oleg

Decision:

```text
Oleg's current BLOCKED/FAIL report is historical and should remain as evidence
of the pre-Grisha state, but it is no longer the current QA verdict.
```

Next action:

```text
Oleg must rerun QA against the current Grisha implementation and write a new report
below the old one with date/status.
```

Required current QA checks:

```text
1. access allowed -> analysis runs.
2. allowed=false -> analysis does not run.
3. quota service unavailable in production -> analysis does not run.
4. forbidden business fields in public payload -> rejected before access check.
5. language is passed from upstream contract.
6. reportType and forceRefresh are passed to access check.
7. delivery.sendToTelegram=false regression.
8. duplicate requestId regression.
9. HTTP status policy from manager decision above.
```

## Answers To Ilya

Decision:

```text
Production release remains blocked until QA retest passes and production gate passes.
```

Updated production gate dependency:

```text
Ilya can prepare the production gate now, but should not release production until:
1. Oleg returns current QA PASS.
2. market-signal-ai-bot production access endpoint is available.
3. production secrets are configured:
   - TELEGRAM_WEBHOOK_SECRET
   - ADMIN_TOKEN
   - SERVICE_TOKEN
   - INTERNAL_API_SECRET
4. production ACCESS_CHECK_URL or MARKET_SIGNAL_AI_BOT_URL is configured.
5. production D1 backup is exported.
6. production D1 migration is applied.
7. rollback version is captured.
8. production health checks pass.
```

Answer to sandbox issue:

```text
Wrangler authentication error code 10000 from sandbox is accepted as an environment
limitation, not a product defect.

Production gate must be run from operator-side authenticated PowerShell.
```

## Answers To Anna

Decision:

```text
Quota model remains accepted for v1.1.
No pricing change now.
```

Data needed after release:

```text
market-signal-ai-bot should log enough non-sensitive analytics for Anna:
- reportType
- quotaDecision
- cacheStatus
- chargeUnits
- tariff/plan
- forceRefresh true/false
- language
- insufficient quota events
- no access events
- user complaints/support tags when available
```

Manager comment:

```text
Decimal units are accepted for v1.1, but UI must explain them clearly.
If users are confused, v1.2 can switch to whole credits internally, for example
1 regular = 2 credits and cached regular = 1 credit.
```

## Answers To Masha

Question:

```text
Should product use unit in all languages, or Russian UI should say юнит?
```

Decision:

```text
Use localized wording.

Russian:
- singular/neutral product wording: "юнит"
- examples:
  - "Списано 1 юнит."
  - "Списано 0.5 юнита."
  - "Units не списаны" should not be used in Russian UI.

English:
- "unit" / "units"

Internal API:
- keep field name chargeUnits.
```

Reason:

```text
Users should not see mixed Russian/English in product messages.
Technical field names stay in API only.
```

Question:

```text
Confirm final support/contact wording for no-access and no-quota messages.
```

Decision:

```text
Use short wording without promising manual fixes.
Support/contact target should be owned by market-signal-ai-bot.
Until final support channel is confirmed, use a generic support action in copy.
```

Russian wording:

```text
No quota:
"Недостаточно юнитов для анализа. Пополните баланс или выберите другой тариф."

No access:
"Этот тип анализа недоступен в вашем тарифе."

Quota service unavailable:
"Сейчас не удалось проверить доступ к анализу. Попробуйте ещё раз чуть позже."

Force refresh confirmation:
"Обновить анализ? Мы пересчитаем отчёт и спишем 1 юнит."
```

English wording:

```text
No quota:
"Not enough units for this analysis. Add units or choose another plan."

No access:
"This analysis type is not available on your plan."

Quota service unavailable:
"We could not verify access right now. Please try again shortly."

Force refresh confirmation:
"Refresh analysis? We will recalculate the report and charge 1 unit."
```

Follow-up task:

```text
Masha should keep these texts in docs/masha-telegram-quota-wording.md.
market-signal-ai-bot should implement them through localization keys, not raw scanner fields.
```

## Updated Manager Summary

Current state:

```text
Grisha: DONE, accepted for QA.
Oleg: old report is stale; retest required.
Ilya: production blocked until QA PASS and production gate.
Anna: quota model accepted; needs analytics after release.
Masha: wording prepared; manager decisions added for units/support wording.
```

Current blockers:

```text
1. Oleg must rerun QA on the current implementation.
2. market-signal-ai-bot must provide production /api/internal/access/check.
3. Ilya must configure production access URL and secrets.
4. Grisha may need follow-up if HTTP status policy does not match manager decision.
5. Scanner technical cache for cached_report must be confirmed or implemented.
6. Full localization remains a follow-up before multi-language launch.
```

## Grisha Report - P0 Scanner HMAC Access Commit 1.1 - 2026-07-02

```text
Developer Report

Task ID: P0-SCANNER-HMAC-ACCESS-COMMIT-1.1
Status: DONE LOCALLY / DEV E2E BLOCKED BY SCANNER TOKEN

Changed:
- files: cloudflare/worker.js, tests/worker-contract-smoke.mjs, CLOUDFLARE_DEPLOY.md
- endpoints: Core POST /api/internal/access/check and POST /api/internal/access/cache/commit
- schema: no migration; existing analysis_cache and contract_results are reused
- env/secrets: CORE_HMAC_KEY_ID, CORE_HMAC_SECRET, ACCESS_CHECK_URL or MARKET_SIGNAL_AI_BOT_URL

Implementation:
- Core calls are HMAC-only. Bearer and quota bypass are not used.
- Access bodies now contain real signed cacheStatus, cacheCreatedAt, and cacheGenerationVersion hints.
- Unsupported legacy cache-response verification was removed.
- Allowed new_* and refresh_* responses require a non-empty cacheReceiptId.
- Each successfully stored per-ticker result is committed separately with SHA-256 of the exact stored JSON.
- Commit retries use a new transport request ID and preserve immutable business fields and digest.
- Provider, analysis, and cache-write failures do not commit.
- Commit failure is logged internally, does not rerun analysis, and does not hide the successful report.
- Exact requestId+ticker replay calls Core again, requires own_repeat, and returns contract_results without provider, Telegram, or commit replay.
- Changed payload for the same business key fails closed.

Tests:
- command: node --check cloudflare/worker.js
- result: PASS
- command: node tests/worker-contract-smoke.mjs
- result: PASS (38 tests)
- covered: signed hit/miss hints, receipt requirement, analysis/cache/commit ordering, digest and immutable fields, commit retry/replay, expired/mismatched/used receipt, commit failure, provider failure without commit, multi-ticker receipts, own_repeat, changed duplicate payload, no Core Bearer header

Dev verification:
- scanner dev deploy: PASS, version 59547fbd-0f2c-4911-aaf6-76eafee3eab6
- GET /api/status: HTTP 200, environment=dev, worker=online
- POST /api/external/analyze: BLOCKED before Core with HTTP 403 authentication_failed because the available historical WEBHOOK_TOKEN no longer matches the deployed dev secret
- Core/provider/cache commit were not reached by the blocked request

Security:
- secrets used: CORE_HMAC_SECRET only through Web Crypto HMAC
- payload tokens accepted: no
- protected endpoints: scanner external endpoint keeps X-Scanner-Token; Core transport uses HMAC headers
- signatures, secrets, and full auth headers are not logged

Risks:
- Dev E2E requires the current dev WEBHOOK_TOKEN or SERVICE_TOKEN to be supplied through a secure local environment; do not paste it into reports or commit it.
- Production remains blocked until Oleg QA PASS and DevOps manual gate.

Ready for:
- Oleg: QA retest
- Roman: contract/idempotency review
- Lena: release decision after QA and dev E2E
```

The older cache-claim and P0 QA sections above describe the superseded pre-receipt implementation. The current scanner follows Core contract 1.1 receipt/commit semantics documented in this report.

## Ilya Report - P0 DEV E2E Scanner Auth Fix - 2026-07-08

```text
Environment: dev
requestId: not executed remotely
HTTP status: not executed remotely
Core decision: local contract PASS; remote Core health PASS; unsigned access/check HTTP 401 as expected
cache commit status: local contract PASS
duplicate/own_repeat result: local contract PASS
checked_at: 2026-07-08T12:57:45.6976306+04:00
final status: FAIL / BLOCKED
```

What was checked:

```text
- Scanner dev Worker active version: 59547fbd-0f2c-4911-aaf6-76eafee3eab6.
- Scanner dev secret names present: SERVICE_TOKEN, WEBHOOK_TOKEN, CORE_HMAC_SECRET, ADMIN_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET.
- Current scanner auth behavior: SERVICE_TOKEN is primary for /api/external/analyze; WEBHOOK_TOKEN is legacy fallback only if SERVICE_TOKEN is absent.
- Caller Worker confirmed: telegram-company-matcher-dev.
- Caller secret name confirmed: STOCK_SIGNAL_SCANNER_TOKEN.
- Caller target confirmed: https://stock-signal-scanner-dev.fnemoy.workers.dev/api/external/analyze.
- Core dev health: HTTP 200.
- Core dev unsigned /api/internal/access/check: HTTP 401, expected for HMAC-protected endpoint.
- Local scanner contract suite: PASS, 38 checks.
- Covered locally: Core access/check before analysis, new analysis, cache commit, duplicate requestId, own_repeat, FundRep, Core denied, Core unavailable/fail-closed.
- Secret scan of scanner repo found no real deployed secret values; only test fixture constant was detected.
```

Blocked:

```text
Remote dev E2E was not executed because the active scanner SERVICE_TOKEN value is not readable back from Cloudflare and no protected local source was available.

Per matcher task-board decision, do not rotate the shared stock-signal-scanner-dev SERVICE_TOKEN without coordinating all clients. Safe next step is either:
1. obtain the active scanner SERVICE_TOKEN from the approved password manager/vault and set only telegram-company-matcher-dev STOCK_SIGNAL_SCANNER_TOKEN through protected input; or
2. get explicit approval for coordinated dev token rotation across all clients, then set scanner SERVICE_TOKEN and caller STOCK_SIGNAL_SCANNER_TOKEN in one protected session.
```

Security:

```text
No secret values were printed, written to Git, added to task board, or included in logs/screenshots.
```

### Ilya Update - coordinated dev rotation and remote retry - 2026-07-08

```text
Environment: dev
requestId: devops-e2e-regular-9a57e179-9c59-48ed-801d-326e6d846729
HTTP status: 503
Core decision: failed_quota_service
cache commit status: not reached
duplicate/own_repeat result: duplicate and own_repeat both failed closed before analysis with failed_quota_service
checked_at: 2026-07-08T13:17:57.1646083+04:00
final status: FAIL / BLOCKED BY CORE 404
```

What changed:

```text
- Coordinated dev token rotation was approved and completed.
- New dev scanner SERVICE_TOKEN was generated in memory only.
- The same token was written to telegram-company-matcher-dev STOCK_SIGNAL_SCANNER_TOKEN through protected stdin.
- Core dev INTERNAL_API_SCOPES_JSON was added with non-secret scope allowlist:
  scanner-dev-v2 -> scanner:access, scanner:cache
  matcher-dev-v1 -> matcher:access, matcher:deliver
```

Remote retry results:

```text
- GET /api/status: HTTP 200.
- wrong scanner token: HTTP 403.
- valid scanner token: no longer returns HTTP 403.
- regular analysis: HTTP 503, status=failed, reason=Access check HTTP 404.
- duplicate requestId: HTTP 503, status=failed, reason=Access check HTTP 404.
- own_repeat attempt: HTTP 503, status=failed, reason=Access check HTTP 404.
- FundRep attempt: HTTP 503, status=failed, reason=Access check HTTP 404.
- delivery.sendToTelegram=false remained false; Telegram was not sent.
- Scanner response bodies did not contain the rotated token literal.
```

Safe log evidence:

```text
Scanner D1 request_logs show:
- External contract analysis started.
- Access check failed with failed_quota_service.
- Final reason: Access check HTTP 404.

This confirms incoming scanner auth is fixed and Scanner calls Core before provider/cache/Telegram, but live Core dev currently returns HTTP 404 to Scanner's access-check call.
```

Next owner:

```text
Core / market-signal-ai-bot owner should verify deployed market-signal-ai-bot-dev route handling for signed scanner-dev-v2 POST /api/internal/access/check.
Production gate remains blocked.
```

### Ilya Report - SCANNER-P0-RETRY-E2E-AFTER-CORE-LIVE - 2026-07-08

```text
Environment: dev
requestId: devops-core-live-regular-a3e04e85-fb5c-45a7-ac6f-1d7d43bf1f1c
HTTP status: 503
Core access/check status: failed_quota_service / Access check HTTP 404
analysis processed or fail reason: failed before provider analysis; reason=Access check HTTP 404
cache commit status: not reached
duplicate own_repeat result: failed closed before analysis; reason=Access check HTTP 404
checked_at: 2026-07-08T15:07:27.7994879+04:00
final status: FAIL / BLOCKED BY CORE 404
```

Remote dev E2E retry:

```text
- Scanner dev deployed version: 105cd2c1-3d35-4aa2-9036-38c10f43cf9a.
- Core dev deployed version: a04d7111-f9fa-4586-97a0-50545e5bc225.
- Runtime ACCESS_CHECK_URL: https://market-signal-ai-bot-dev.fnemoy.workers.dev/api/internal/access/check.
- Runtime CORE_HMAC_KEY_ID: scanner-dev-v2.
- Core dev health: HTTP 200.
- Core unsigned access/check: HTTP 401, expected for protected endpoint.
- Scanner GET /api/status: HTTP 200.
- Wrong scanner token: HTTP 403.
- Valid scanner token: accepted by scanner; no HTTP 403.
- Regular AMD request: HTTP 503, status=failed, reason=Access check HTTP 404.
- Duplicate same requestId/ticker: HTTP 503, status=failed, reason=Access check HTTP 404.
- Own-repeat AMD request with new requestId: HTTP 503, status=failed, reason=Access check HTTP 404.
- FundRep AAPL request: HTTP 503, status=failed, reason=Access check HTTP 404.
- delivery.sendToTelegram=false remained false; Telegram was not sent.
- Response bodies did not contain the rotated token literal.
```

Safe evidence:

```text
Scanner D1 request_logs confirm:
- External contract analysis started for the E2E request IDs.
- Access check executed before analysis.
- Access check failed with failed_quota_service.
- Final detail: Access check HTTP 404.
```

404 checklist:

```text
- Deployed scanner version checked: PASS.
- Runtime ACCESS_CHECK_URL checked: PASS.
- Not old Worker/preview/prod Core URL: PASS; URL points to market-signal-ai-bot-dev.
- Current blocker remains inside market-signal-ai-bot-dev signed scanner access/check handling.
```

Security:

```text
No secrets, signatures, tokens, or Authorization headers were logged in the report.
```

### Ilya Report - SCANNER-P0-LIVE-TAIL-SIGNED-E2E - 2026-07-08

```text
Environment: dev
scanner requestId: devops-live-tail-347cb617-95ac-4878-8e89-5aee0bb99b9b
Core active version: 73345693-a27c-4705-a6c5-1b703ac03d10
Scanner active version: 4cc85c26-4461-4aeb-ad20-afa15e786206
CORE_HMAC_KEY_ID: scanner-dev-v2
Core URL pathname: /api/internal/access/check
Core full URL without query: https://market-signal-ai-bot-dev.fnemoy.workers.dev/api/internal/access/check
Query string: empty
Trailing slash: false
Core HTTP status: 404 as seen by Scanner
Scanner final status: HTTP 503, status=failed, reason=Access check HTTP 404
Cache commit status: not reached
checked_at: 2026-07-08T20:02:43.2198653+04:00
final status: FAIL / CORE TAIL DID NOT OBSERVE THE REQUEST
```

Live-tail evidence:

```text
- Core dev active version check: PASS, exact required version is active.
- Scanner and Core tails were started before the signed E2E request.
- Scanner tail produced events during the window.
- Core tail produced 0 parsed events during the same window.
- Core access/check event was not observed in Core tail.
- Scanner response still reported Access check HTTP 404.
```

Route checks:

```text
- Direct unsigned POST without trailing slash:
  https://market-signal-ai-bot-dev.fnemoy.workers.dev/api/internal/access/check -> HTTP 401.
- Direct unsigned POST with trailing slash:
  https://market-signal-ai-bot-dev.fnemoy.workers.dev/api/internal/access/check/ -> HTTP 404.
- Scanner runtime ACCESS_CHECK_URL has no trailing slash.
- Scanner runtime URL points to market-signal-ai-bot-dev, not preview, old Worker, or production.
- Core deployment time 2026-07-08T11:07:27.407608Z; request time was after that deployment.
```

Conclusion:

```text
Actual Core execution was not proven by Core live tail. The safe evidence proves Scanner uses the intended dev URL and fails closed on a 404 response, but Core tail did not show the inbound signed request. Next step is for Core owner to inspect Cloudflare route/worker execution for signed subrequests around scanner requestId devops-live-tail-347cb617-95ac-4878-8e89-5aee0bb99b9b and time 2026-07-08T16:02Z.
```

Security:

```text
No SERVICE_TOKEN, CORE_HMAC_SECRET, X-Signature, Authorization, or X-Scanner-Token values were logged.
```

### Ilya Report - Remote Signed E2E Retry - 2026-07-09

```text
Environment: dev
requestId: devops-signed-regular-ec1f5a16-1701-4a70-8544-bc384c8e1f19
HTTP status: 503
Core access/check: failed_quota_service / Access check HTTP 404
analysis after allowed=true: not reached
cache commit status: not reached
duplicate/own_repeat result: failed closed before analysis
Telegram delivery: not sent
checked_at: 2026-07-09T18:40:57.9861224+04:00
final status: FAIL / BLOCKED BY CORE 404
```

Runtime details:

```text
- Scanner active version: e826641e-dcf4-479a-a0bc-6042b74778b3.
- Core active version: 6e58f8af-79ca-4260-8649-6278ed5fc9ed.
- Scanner ACCESS_CHECK_URL: https://market-signal-ai-bot-dev.fnemoy.workers.dev/api/internal/access/check.
- Scanner CORE_HMAC_KEY_ID: scanner-dev-v2.
- Scanner /api/status: HTTP 200.
- Wrong scanner token: HTTP 403.
- Valid scanner token: accepted by Scanner; no HTTP 403.
- Direct unsigned Core access/check without trailing slash: HTTP 401 internal_key_and_request_id_required.
- Direct unsigned Core access/check with trailing slash: HTTP 401 internal_key_and_request_id_required.
- Core route exists for both slash variants, but Scanner signed subrequest still receives HTTP 404.
```

E2E results:

```text
- regular AMD request: HTTP 503, status=failed, reason=Access check HTTP 404.
- duplicate same requestId/ticker: HTTP 503, status=failed, reason=Access check HTTP 404.
- own_repeat AMD request with new requestId: HTTP 503, status=failed, reason=Access check HTTP 404.
- FundRep AAPL request: HTTP 503, status=failed, reason=Access check HTTP 404.
- cache commit was not reached in any case.
- delivery.sendToTelegram=false remained false; Telegram was not sent.
- Scanner response bodies did not contain the rotated token literal.
```

Additional safe checks:

```text
- Core dev fixture user dev_test_scanner_user exists.
- Core dev fixture subscriptions for dev_test_scanner_user exist.
- Active quota plan policies exist.
```

Security:

```text
No SERVICE_TOKEN, CORE_HMAC_SECRET, X-Signature, Authorization, or X-Scanner-Token values were logged or written to the report.
```

### Ilya Report - SCANNER-P0-OWN-REPEAT-REMOTE-E2E - 2026-07-13

```text
Task ID: SCANNER-P0-OWN-REPEAT-REMOTE-E2E
Environment: dev
Scanner version: f63fc588-f459-4740-a87a-994296f1b7e4
Core version: 6f5bcfcc-59b2-4c63-a43b-b26687fc20d2
Generation version: devops-own-repeat-a762723d-e605-4d7c-9d8b-b6cafb56000d
First request: PASS, requestId=devops-own-first-94c4d533-d765-4270-a9d9-b31067147d21, HTTP 200, status=processed, quotaDecision=new_regular, chargeUnits=1, reportSource=new_analysis, cache receipt present, cacheCommitStatus=committed, rows=1, errors=0
Exact duplicate: FAIL, same requestId/payload returned HTTP 503; Core decision was new_regular, chargeUnits=1, reportSource=new_analysis; Scanner error=invalid_core_response / Core did not confirm an idempotent repeat
Own repeat: FAIL, requestId=devops-own-repeat-f32c8eeb-2d32-4a04-9f07-6651590ea4a7, Core returned quotaDecision=own_repeat, chargeUnits=0, reportSource=own_repeat, cacheReceiptId=null; Scanner returned HTTP 503 with stored_result_not_found
Shared cache: PASS, requestId=devops-shared-cache-d1f19b42-244e-4d28-b508-7728f3a66757, HTTP 200, status=processed, quotaDecision=cached_regular, chargeUnits=0.5, reportSource=cache, no cache receipt, rows=1, errors=0
Provider calls: PASS for shared cache/no repeat provider inferred from reportSource=cache and scanner cacheStatus=hit; first request performed analysis
Cache commit: PASS for first request; not expected for duplicate/own_repeat/shared cache
Telegram delivery: PASS, sendToTelegram=false, delivered=false in all E2E responses
Secrets exposed: no
Production changed: no
Checked at: 2026-07-13T21:14:59.8223883+04:00
Result: FAIL
Blockers: Scanner/Core duplicate and own_repeat contract behavior is not aligned. Exact duplicate gets Core new_regular instead of an idempotent repeat confirmation accepted by Scanner. Own repeat gets Core own_repeat but Scanner cannot locate the stored Scanner result and fails closed with stored_result_not_found.
```

Setup:

```text
- Confirmed Core dev active version: 6f5bcfcc-59b2-4c63-a43b-b26687fc20d2.
- Confirmed Scanner dev CORE_SERVICE binding target: market-signal-ai-bot-dev.
- Confirmed/created dev-only second fixture user: dev_test_scanner_user_2 with active dev subscription.
- Used clean generationVersion for this E2E run.
- Production was not deployed or modified.
```

Security:

```text
No SERVICE_TOKEN, CORE_HMAC_SECRET, X-Signature, Authorization, or X-Scanner-Token values were logged or written to the report.
```

### Ilya Report - SCANNER-P0-SERVICE-BINDING-DEV-E2E - 2026-07-13

```text
Task ID: SCANNER-P0-SERVICE-BINDING-DEV-E2E
Environment: dev
Scanner version: 97ca7aae-4e1a-41a2-8206-8287b3cd3901
Core version: 84fd8318-b36d-4fbc-9f60-79ad883d417d
CORE_SERVICE target: market-signal-ai-bot-dev
RequestId: devops-service-binding-43c56d9d-3d3d-459e-8bb1-55924da78b67
Core request observed: yes, via service binding response
Access check: PASS, HTTP 200, allowed=true, quotaDecision=new_regular
HMAC validation: PASS, Core accepted signed scanner-dev-v2 request
Analysis: PASS, status=processed, rows=1, errors=0
Cache receipt: PASS, receipt present
Cache commit: PASS, cacheCommitStatus=committed
Duplicate/own_repeat: FAIL, same requestId returned saved new_regular response; new requestId same user/ticker returned cached_regular, not own_repeat
Repeated provider call: PASS for post-commit repeat path by cached_regular/cache response; exact duplicate returned saved response
Telegram delivery: PASS, sendToTelegram=false, delivered=false
Secrets exposed: no
Checked at: 2026-07-13T15:46:49.7765224+04:00
Result: FAIL
Blockers: duplicate/own_repeat contract expectation is not met; Core/Scanner returns saved new_regular for exact duplicate and cached_regular for same user/ticker new requestId.
```

DevOps actions:

```text
- Confirmed Core dev active version: 84fd8318-b36d-4fbc-9f60-79ad883d417d.
- Confirmed dev wrangler binding: CORE_SERVICE -> market-signal-ai-bot-dev.
- Deployed only stock-signal-scanner-dev.
- Production was not touched.
- Confirmed active Scanner binding includes CORE_SERVICE service=market-signal-ai-bot-dev.
- Fixed Scanner access/check body to include explicit chatId:null when chatId is absent, matching Core validation contract.
```

Checks:

```text
- node --check cloudflare/worker.js: PASS.
- npm.cmd run test:worker-contract: PASS.
- service binding access/check local contract test: PASS.
- service binding cache/commit local contract test: PASS.
- missing CORE_SERVICE fail-closed local contract test: PASS.
```

Security:

```text
No SERVICE_TOKEN, CORE_HMAC_SECRET, X-Signature, Authorization, or X-Scanner-Token values were logged or written to the report.
```

### Oleg QA Report - Private API-only Boundary - 2026-07-09

```text
QA Report

Task: SCANNER-P0-PRIVATE-API-ONLY-BOUNDARY
Environment: local code/test QA

Status: PASS for POST /api/external/analyze private API-only boundary

Checked:
- Contract validation
- Response format
- Private API-only delivery boundary
- Telegram delivery blocking
- Core access payload boundary
- JSON-only API response
- Regression smoke

Findings:
1. [info] /api/external/analyze rejects delivery.sendToTelegram=true before access check.
2. [info] /api/external/analyze rejects bot.tokenSecretName before access check.
3. [info] /api/external/analyze clears chatId in the response and does not pass chatId/telegramChatId to Core access/check.
4. [info] /api/external/analyze does not call Telegram API in the private boundary scenario.
5. [info] /api/external/analyze returns application/json and the tested API response contains no HTML.
6. [risk] Legacy Telegram routes still exist outside the private premium flow. This does not fail the /api/external/analyze boundary, but production ownership for those routes remains a separate manager/DevOps decision.

Focused QA:
- valid private payload with chatId + delivery.sendToTelegram=false: PASS
- Core access/check called without chatId/telegramChatId: PASS
- provider analysis runs only after allowed Core decision: PASS
- cache commit after successful new_regular analysis: PASS
- Telegram API calls: PASS, 0 calls
- delivery.sendToTelegram=true rejected before access: PASS
- bot.tokenSecretName rejected before access: PASS
- API response JSON-only/no HTML: PASS

Regression:
- npm.cmd run test:worker-contract - PASS, 40/40
- node --check cloudflare\worker.js - PASS

Recommendation:
Private API-only boundary can be accepted for dev.
Do not release production yet: the broader v1.1 gate remains blocked by remote Core signed E2E / access-check issue.
```

### Oleg QA Report - Service Binding QA - 2026-07-13

```text
Task ID: SCANNER-P0-SERVICE-BINDING-QA
Status: PASS

Contract tests:
PASS
- npm.cmd run test:worker-contract: PASS, 44/44
- node --check cloudflare\worker.js: PASS

Encoding check:
PASS
- Runtime Russian report/error samples are clean:
  Отчёт анализа, Почему, Недостаточно данных для анализа, Фундаментальный отчёт по AAPL, Компания.
- cloudflare/worker.js and cloudflare/report-i18n.js contain no actual U+00D0/U+00D1/U+FFFD mojibake markers by UTF-8 codepoint scan.
- Non-blocking hygiene note: tests/worker-contract-smoke.mjs still has one mojibake-looking Hebrew regex literal in a test assertion. It is not a runtime Russian text/report output and did not break regression.

Access binding:
PASS
- access/check is called through env.CORE_SERVICE.fetch(...).
- Focused QA: allowed request used service binding once for /api/internal/access/check.
- Global/public fetch fallback for access/check was not called.

Cache commit binding:
PASS
- access/cache/commit is called through env.CORE_SERVICE.fetch(...).
- Focused QA: successful new_regular request used service binding once for /api/internal/access/cache/commit.
- Commit HMAC canonical path remained /api/internal/access/cache/commit.

Public fallback absent:
PASS
- Focused QA forced public Core fetch to throw; allowed/deny/error/missing-binding scenarios did not use public Core fetch.
- ACCESS_CHECK_URL/MARKET_SIGNAL_AI_BOT_URL are used only to build canonical/path configuration, not as transport fallback.

Fail-closed:
PASS
- Missing CORE_SERVICE binding: HTTP 503, status=failed, no provider, no cache commit, no Telegram.
- Core deny: HTTP 200, status=rejected, no provider, no cache commit, no Telegram.
- Core HTTP 500/error: HTTP 503, status=failed, no provider, no cache commit, no Telegram.

HMAC canonical path/body:
PASS
- access/check signature was verified against:
  timestamp.keyId.transportRequestId.POST./api/internal/access/check..sha256(body)
- cache/commit signature was verified against:
  timestamp.keyId.transportRequestId.POST./api/internal/access/cache/commit..sha256(body)
- No Bearer Authorization header is required for Core transport.

Production binding absent:
PASS
- wrangler.worker.toml has root/dev CORE_SERVICE binding to market-signal-ai-bot-dev.
- [env.production] has no CORE_SERVICE service binding and no [[env.production.services]] section.

Blocking defects:
None.

Ready for Ilya: yes
- QA accepts local service-binding behavior.
- Ilya can proceed with environment/deployment verification and production binding decision.
```
