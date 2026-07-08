# Scanner/Core HMAC Deployment Runbook

Date: 2026-07-01
Owner: Ilya (Scanner DevOps)
Status: BLOCKED pending Core production deployment and QA PASS from Roman and Lena

## Environment Matrix

| Environment | Proposed key ID | Scanner secret | Core secret map | Access URL |
| --- | --- | --- | --- | --- |
| dev | `scanner-dev-v1` | `CORE_HMAC_SECRET` | `INTERNAL_API_SECRETS_JSON` | `https://market-signal-ai-bot-dev.fnemoy.workers.dev/api/internal/access/check` |
| production | `scanner-prod-v1` | `CORE_HMAC_SECRET` | `INTERNAL_API_SECRETS_JSON` | `https://market-signal-ai-bot.fnemoy.workers.dev/api/internal/access/check` |

The key IDs are non-secret proposals and require Core DevOps confirmation. Dev and
production must use different random secrets. Secret values must never be stored in
Wrangler vars, Git, documentation, command arguments, terminal output, or logs.

## Current Gate

- Scanner HMAC and fail-closed contract tests: PASS.
- Core dev health: HTTP 200.
- Core dev access endpoint without HMAC: HTTP 401 (route deployed).
- Core production health: HTTP 200.
- Core production access endpoint: HTTP 404 (route not deployed).
- Observed HTTP clock skew: approximately 36 seconds, within the five-minute HMAC window.
- Core dev already has `INTERNAL_API_SECRETS_JSON`; never overwrite it blindly.
- Scanner dev and production do not yet have `CORE_HMAC_SECRET`.
- Roman/Lena production PASS is not recorded.

## Initial Setup

1. Core DevOps confirms the proposed key ID for the target environment.
2. Core DevOps merges the new key ID into the protected multi-key secret map.
3. Keep every currently active key during the overlap window.
4. Confirm Core health and that an unsigned access request returns HTTP 401, not 404.
5. Set the same new value as Scanner `CORE_HMAC_SECRET` through protected stdin.
6. Configure Scanner `CORE_HMAC_KEY_ID` and `ACCESS_CHECK_URL` as non-secret vars.
7. Deploy Scanner dev first and run valid HMAC, invalid HMAC, replay, clock, and fail-closed checks.
8. Deploy production only after Core production is deployed and Roman/Lena return PASS.

## Rotation

1. Create a new environment-specific key ID, for example `scanner-dev-v2`.
2. Add the new key to the Core protected map while retaining the old key.
3. Verify Core accepts a request signed by the new key.
4. Update Scanner secret and key ID in one controlled maintenance window.
5. Deploy Scanner and run health checks.
6. Keep the old Core key through the agreed rollback window.
7. Remove the old key only after logs show no use and rollback is no longer required.

## Rollback

Before deployment, capture the active version IDs for both Workers.

Scanner production rollback candidate:

```powershell
npx.cmd wrangler rollback d73ccba6-fe20-4475-8df4-3fc5df2cde5a --config wrangler.worker.toml --env production
```

Core rollback template:

```powershell
npx.cmd wrangler rollback <CORE_VERSION_ID> --config wrangler.jsonc --env production
```

Rollback order:

1. Stop new Scanner traffic or leave Scanner fail-closed.
2. Roll back the failing side to its captured version.
3. Keep both HMAC keys active during rollback.
4. Re-run health, clock, valid HMAC, invalid HMAC, replay, and fail-closed checks.
5. Never attempt to recover a secret from Cloudflare; use the retained protected key material.

## Release Gate

Production remains blocked until all conditions pass:

- Core production access endpoint is deployed.
- Core DevOps confirms production key ID and protected secret-map update.
- Scanner production secret and non-secret bindings are configured.
- Roman PASS and Lena PASS are recorded.
- D1 backup, migration, Scanner deploy, Telegram webhook, regular/FundRep/cache checks pass.
- Both Worker rollback version IDs and retained old HMAC keys are available.
