# Production Smoke Checklist

Date: 2026-07-15
Owner: Oleg / QA
Environment: production

## Status

```text
Status: FAIL / BLOCKED
Reason: production is not configured for v1.1 Core service-binding flow.
```

## Checklist

```text
1. /api/status
   Status: PASS
   Evidence: https://stock-signal-scanner-production.fnemoy.workers.dev/api/status returned ok=true, environment=production.

2. Production active version
   Status: FAIL
   Evidence: active production version is d73ccba6-fe20-4475-8df4-3fc5df2cde5a from 2026-06-22, not the v1.1 dev-accepted version.

3. Production Core binding
   Status: FAIL
   Evidence: active production version does not have CORE_SERVICE.
   Evidence: wrangler env.production config does not include CORE_SERVICE.

4. Production Core HMAC/config vars
   Status: FAIL
   Evidence: active production version does not have ACCESS_CHECK_URL or CORE_HMAC_KEY_ID.
   Evidence: wrangler warned that top-level ACCESS_CHECK_URL, CORE_HMAC_KEY_ID, and services are not inherited by env.production.

5. regular analysis through production Core
   Status: BLOCKED
   Reason: production lacks CORE_SERVICE/HMAC config for v1.1 Core flow.
   Safety: no production token was read, printed, rotated, or stored.

6. exact duplicate
   Status: BLOCKED
   Reason: regular production Core analysis is blocked.

7. own repeat
   Status: BLOCKED
   Reason: regular production Core analysis is blocked.

8. shared cache
   Status: BLOCKED
   Reason: regular production Core analysis is blocked.

9. delivery.sendToTelegram=false
   Status: BLOCKED for authenticated production analysis.
   Evidence: unauthenticated production POST returned HTTP 403.

10. secrets in API responses
    Status: PASS for checked public responses.
    Evidence: /api/status response scan found no TOKEN/SECRET/header markers and no Telegram bot-token pattern.
    Evidence: unauthenticated /api/external/analyze returned HTTP 403 with empty body.

11. secrets in D1 logs
    Status: PASS for request_logs scan.
    Evidence: request_logs suspicious marker count was 0 for TOKEN/SECRET/Authorization/X-Scanner/bot-token-like pattern.
    Note: production D1 currently does not have ticker_request_logs table, so that table could not be checked.

12. production secret/binding hygiene
    Status: FAIL
    Evidence: active production version contains an accidental plain_text binding named like a Telegram bot token with a trailing space.
    Safety: the secret value is intentionally not copied into this report.
```

## Recommendation

```text
Do not proceed with production smoke as PASS.

Before rerunning authenticated smoke:
1. Deploy the accepted v1.1 scanner build to production through a controlled production gate.
2. Add production CORE_SERVICE binding to the real production Core Worker.
3. Add production ACCESS_CHECK_URL and CORE_HMAC_KEY_ID under env.production vars.
4. Ensure CORE_HMAC_SECRET and SERVICE_TOKEN are configured as secret_text.
5. Remove the accidental plain_text Telegram token binding with the trailing-space name.
6. Apply/verify required v1.1 production D1 schema, including contract_results, analysis_cache, and ticker_request_logs if expected by the release gate.
7. Rerun production smoke with a protected SERVICE_TOKEN provided through secure local environment only.
```
