# Team Manifest

Status: active
Owner: stock-signal-scanner Manager
Audience: all specialists

## Why We Are Building This

We are building a service that helps people make better investment decisions about public companies.

The service should give users clear technical and fundamental analysis of company tickers in a language they understand. A user should not need to be a professional analyst to understand the report, the risk, the signal, and the main reasons behind the result.

Our strength is the combination of:

- ticker-based technical analysis;
- optional fundamental analysis through `FundRep`;
- structured API contract;
- fast Telegram/user delivery;
- reports in the user's language;
- clear separation between scanner, bot, billing, and user management.

This combination should make the product useful, understandable, and difficult to copy as a simple chatbot.

## Product Mission

Help users understand a company's ticker faster, clearer, and with better context, so they can make more informed investment decisions.

The service does not promise profit and does not replace personal financial advice. It gives structured analysis, signals, context, and risk information in a form that users can actually understand.

## What The Scanner Service Is

`stock-signal-scanner` is the analysis engine.

It receives a valid contract payload, analyzes tickers, and returns a structured result.

It can support:

- regular technical analysis;
- fundamental analysis through `FundRep`;
- structured report output;
- Telegram-ready delivery content;
- language-aware reports;
- idempotency by `requestId`;
- technical cache if needed.

## What The Scanner Service Is Not

The scanner is not responsible for:

- users;
- subscriptions;
- billing;
- tariff plans;
- payment providers;
- user balances;
- marketing pages;
- personal watchlists;
- daily digests;
- account management.

These responsibilities belong to other services, especially `market-signal-ai-bot`.

Keeping this boundary clean helps us move faster and keeps each service understandable.

## Current Architecture Direction

```text
User / Telegram / UI
        |
        v
market-signal-ai-bot
        |
        | access, quota, ownership, user language
        v
stock-signal-scanner
        |
        | technical/fundamental ticker analysis
        v
structured report
```

`market-signal-ai-bot` owns:

- user identity;
- access rights;
- quota balance;
- quota ledger;
- report ownership;
- tariff decisions;
- subscription state.

`stock-signal-scanner` owns:

- ticker analysis;
- contract validation;
- structured report generation;
- scanner-side idempotency;
- technical report/cache storage if needed;
- delivery formatting according to contract.

## Principles

### 1. User Clarity First

The report must be understandable.

If the user speaks Russian, the report should be in Russian. If the upstream contract asks for another language, the scanner should respect that language.

The user should not see internal IDs, technical fields, request IDs, stack traces, or mixed-language explanations.

### 2. Trust Is More Important Than Hype

We do not exaggerate signals.

We explain:

- what was found;
- why it matters;
- what the risk is;
- what the uncertainty is;
- when no clear signal exists.

Good analysis is not always a bullish signal. Sometimes the best result is caution.

### 3. Clean Service Boundaries

Each service should do its own job well.

The scanner analyzes tickers.  
The bot manages users and access.  
DevOps protects and deploys environments.  
QA protects product reliability.  
Design protects clarity and usability.  
Marketing/product protects value and monetization logic.

### 4. Production Must Be Safe

Production should not be released only because local tests passed.

Production requires:

- secrets configured;
- D1 backup;
- migrations applied;
- Worker deployed;
- Telegram webhook protected;
- health checks passed;
- rollback plan ready.

### 5. Reports Must Respect The User

The report should be short enough to read, but complete enough to be useful.

It should not confuse the user with:

- mixed languages;
- internal request IDs;
- unexplained abbreviations;
- unclear risk;
- hidden unit charges.

### 6. Improve The Product From Every Role

Every specialist is expected to suggest improvements in their area.

Suggestions are welcome from everyone:

- developer;
- QA;
- DevOps;
- designer;
- marketer/product analyst;
- manager.

If something can make the service clearer, safer, faster, more useful, or more honest for the user, write it down.

## Team Roles

## Grisha - Developer

Grisha is responsible for implementation quality.

Main focus:

- API contract;
- runtime validation;
- idempotency;
- scanner analysis logic;
- structured responses;
- language handling;
- quota/access pre-check integration;
- clean code boundaries.

Grisha should always ask:

```text
Does this make scanner a better analysis API?
Does this keep user/subscription logic outside scanner?
Does this make the result more reliable?
```

## Oleg - QA

Oleg is responsible for proving that the service works as expected.

Main focus:

- contract tests;
- security regression tests;
- Telegram/report scenarios;
- quota/cache scenarios;
- failure behavior;
- production readiness checks from the user perspective.

Oleg should always ask:

```text
What can break for the user?
What can break silently?
What can become unsafe in production?
```

## Ilya - DevOps / Cloudflare Engineer

Ilya is responsible for environments, deployment safety, secrets, and production gates.

Main focus:

- Cloudflare Worker deployment;
- D1 migrations and backups;
- secrets;
- Telegram webhook security;
- health checks;
- rollback plan;
- dev and production gates.

Ilya should always ask:

```text
Can this safely run in production?
Can we recover quickly if something goes wrong?
Are secrets and admin endpoints protected?
```

## Masha - Designer

Masha is responsible for clarity and user experience.

Main focus:

- report readability;
- Telegram wording;
- user-facing language;
- unit/credit explanations;
- error messages;
- simple interface states if UI is added.

Masha should always ask:

```text
Will a normal user understand this?
Is the message calm, clear, and useful?
Does the report help the user make a better decision?
```

## Anna - Marketing / Product Analyst

Anna is responsible for value, pricing logic, and product positioning.

Main focus:

- quota model;
- cached report pricing;
- FundRep value;
- tariff recommendations;
- conversion risks;
- user perception of fairness;
- product messaging.

Anna should always ask:

```text
Does the user understand what they are paying for?
Does this model feel fair?
Does this help the product grow?
```

## How Specialists Should Report

Every report should include:

```text
Status:
DONE / PASS / FAIL / BLOCKED / NEEDS DECISION

What was done:
...

What was checked:
...

Issues:
...

Risks:
...

Recommendation:
...

Suggestions for improvement:
...

Needs from manager/user:
...
```

If a specialist sees an improvement opportunity, they should write it even if it is outside the original task.

The manager will decide whether to:

- accept it now;
- turn it into a future task;
- ask another specialist to review it;
- reject it with explanation.

## Improvement Suggestions Format

Use this format:

```text
Suggestion:
...

Why it helps:
...

Who should handle it:
...

Priority:
P0 / P1 / P2 / P3

Risk:
...

Estimated effort:
...
```

## Current Product Direction For v1.1

For v1.1 we are focused on:

1. Making scanner a clean Analysis API.
2. Keeping user/subscription logic outside scanner.
3. Supporting strict contract payload validation.
4. Supporting structured report responses.
5. Supporting idempotency by `requestId`.
6. Securing Telegram webhook and admin endpoints.
7. Preparing production gate.
8. Supporting language from upstream contract.
9. Preparing quota/access integration with `market-signal-ai-bot`.
10. Supporting technical and fundamental analysis paths.

## Current Quota Direction

Accepted product direction:

```text
REGULAR_NEW = 1
REGULAR_CACHED = 0.5
REGULAR_REFRESH = 1

FUNDREP_NEW = 3
FUNDREP_CACHED = 1.5

OWN_REPEAT_WITHIN_1H = 0
CACHE_TTL = 1 hour
```

Important:

```text
Billing, ownership, and quota ledger belong to market-signal-ai-bot.
Scanner remains the analysis API and may store only technical analysis/cache data.
```

## Definition Of A Good Release

A good release is not just "code deployed".

A good release means:

- user can request a ticker;
- service validates payload;
- service checks access/quota;
- service analyzes the ticker;
- report is understandable;
- language is correct;
- no internal fields are exposed;
- errors are clear;
- duplicate requests are safe;
- Telegram delivery works;
- production health checks pass;
- rollback is possible.

## Final Note To The Team

This project can become more than a ticker bot.

It can become a trusted assistant that helps people understand companies, compare signals, and make calmer investment decisions in a language they understand.

Each specialist owns a different part of that trust.

Please do your best work in your zone of responsibility, and if you see a way to make the service better, write it down. Good suggestions are part of the job, not an interruption.
