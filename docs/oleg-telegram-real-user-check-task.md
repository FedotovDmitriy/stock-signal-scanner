# Task for Oleg: real-user Telegram verification

## Context

User reported that sending ticker to `@Stock_Signal_Scanner_bot` did not return analysis.

Ilya checked dev Worker and found:

- Telegram update received.
- Ticker `AAPL` parsed.
- Analysis completed.
- `errors=0`.
- `signal_count=2`.
- Report delivered to Telegram.
- Allowlist is empty and not blocking.

Observed chat:

```text
user_id=993841366
chat_id=993841366
username=@feddmi
```

## Goal

Verify whether the issue is still visible from a real Telegram client.

## Test cases

### 1. Same user/chat check

From the same Telegram account `@feddmi`, send:

```text
AAPL
```

Expected:

- bot returns analysis report;
- response arrives in the same private chat;
- response includes `requestId`.

### 2. Second ticker

Send:

```text
MSFT
```

Expected:

- bot returns analysis report;
- logs show `source=telegram`, `tickers=MSFT`, `status=ok`.

### 3. Invalid ticker

Send:

```text
BAD!
```

Expected:

- bot returns validation/error response or no-valid-ticker prompt;
- no silent failure.

### 4. FundRep path

Send:

```text
FundRep AAPL
```

Expected:

- bot starts/sends fundamental report flow;
- if unavailable, user receives clear error.

## Expected QA report

```text
QA Report

Task: Telegram real-user check
Status: PASS / FAIL

Account:
- username:
- user_id:
- chat_id:

Checks:
- AAPL:
- MSFT:
- BAD!:
- FundRep AAPL:

Findings:
1.

Recommendation:
Resolved / needs Grisha / needs Ilya.
```
