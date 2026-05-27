# Stock Signal Scanner: v1 architecture

## Vision

Stock Signal Scanner is the cloud backend for a Telegram-based stock news and signal product.

User journey:

1. User discovers the product through a Telegram channel.
2. User opens the onboarding bot.
3. The bot asks what countries and market/news topics interest the user.
4. Backend creates or updates the user account and stores preferences.
5. If the user has an active subscription, backend gives links to country-specific bots.
6. Country bots send daily digests: news, related tickers, analysis, signals.
7. User can manually send tickers and receive analysis while subscription is active.

Decision: country bots are created manually through BotFather. Their tokens are stored as Cloudflare secrets or encrypted backend values. The backend manages them through Telegram Bot API webhooks.

## V1 Scope

Countries:

- Israel
- United States

Included:

- Onboarding bot.
- Country-specific bots: US Stocks Bot, Israel Stocks Bot.
- Country and topic preferences.
- User watchlists.
- Subscription status and paid-until logic.
- Daily digest orchestration.
- Manual ticker analysis.
- Logs and monitoring.
- Dev and production environments.

Not included in v1:

- Automatic BotFather bot creation.
- Premium PDF reports.
- Full payment-provider automation until provider is selected.
- Integration with `telegram_company_matcher_app`, because it will work independently for now.

## Watchlist Meaning

Watchlist is a user's personal list of tickers.

Ticker sources:

1. News-linked tickers: tickers related to a country news item.
2. Manual ticker requests: user sends `AAPL` or `AAPL, MSFT` to a bot.
3. Watchlist tickers: user saves tickers they always want monitored.

For v1, watchlist should be stored. It can first be used for manual analysis shortcuts, then later for daily watchlist summaries.

## High-Level System

```mermaid
flowchart TD
  user["Telegram user"]
  channel["Telegram channel"]
  onboarding["Onboarding bot"]
  usbot["US Stocks Bot"]
  ilbot["Israel Stocks Bot"]
  worker["Cloudflare Worker API"]
  d1["Cloudflare D1 database"]
  queue["Cloudflare Queues"]
  cron["Cloudflare Cron Trigger"]
  scanner["Stock Signal Scanner analysis module"]
  payments["Payment provider"]
  news["Country daily news source"]
  admin["Monitoring/Admin site"]

  channel -->|"link"| onboarding
  user --> onboarding
  onboarding -->|"preferences, user data"| worker
  worker --> d1
  worker -->|"eligible bot links"| onboarding

  user --> usbot
  user --> ilbot
  usbot -->|"webhook"| worker
  ilbot -->|"webhook"| worker

  payments -->|"payment webhooks"| worker
  cron -->|"daily schedule"| worker
  worker --> queue
  queue -->|"digest jobs"| worker
  news --> worker
  worker --> scanner
  scanner --> worker
  worker -->|"sendMessage/sendDocument"| usbot
  worker -->|"sendMessage/sendDocument"| ilbot
  admin --> worker
```

## Daily Digest Flow

```mermaid
sequenceDiagram
  participant Cron as Cloudflare Cron
  participant API as Worker API
  participant DB as D1
  participant News as Country News Source
  participant Scanner as Stock Signal Scanner
  participant Bot as Country Telegram Bot

  Cron->>API: Run daily digest
  API->>DB: Get active users and country preferences
  API->>News: Get country news and related tickers
  News-->>API: Ordered news + tickers
  loop Each news item
    API->>Scanner: Analyze tickers from this news
    Scanner-->>API: Analysis + signals
    API->>Bot: Send news first
    API->>Bot: Send ticker analysis and signals
    API->>DB: Save delivery status
  end
```

Message order must be strict:

1. News.
2. Tickers from that news.
3. Analysis.
4. Signals.

## Bot Roles

### Onboarding Bot

- Collect user profile.
- Show checklist of countries.
- Show checklist of news/economic interests.
- Store preferences in backend.
- Show country bot links if subscription is active.
- Handle subscription status messages.

### Country Bots

V1 bots:

- Israel Stocks Bot.
- US Stocks Bot.

Responsibilities:

- Send daily country-specific digest.
- Receive manual ticker requests.
- Return analysis if the user has active access to that country.

Access rule:

- `subscriptions.paid_until >= today`.
- User selected the country.
- Country bot is active.

## Subscription Logic

If the user subscribes on July 10:

- `current_period_start = 2026-07-10`
- `paid_until = 2026-08-10`
- access is active through August 10 inclusive.

If the user cancels on July 15:

- `cancel_at_period_end = true`
- `status = canceled`
- `paid_until = 2026-08-10`
- access remains active until August 10 inclusive.

Access check:

```text
is_active = paid_until >= current_date AND status IN ('active', 'canceled', 'trialing', 'past_due_grace')
```

## Payment Provider Options

Provider is not selected yet.

### Stripe Billing

Pros:

- Strong recurring subscription lifecycle.
- Customer portal for card changes and cancellation.
- Webhooks for renewal, failed payment, cancellation.
- Good reporting and business tooling.

Cons:

- Business/country availability must be checked.
- Fees.
- Checkout is usually outside Telegram.

### Telegram Payments / Stars

Pros:

- Native Telegram user experience.
- Lower friction inside Telegram.
- Useful for Telegram-first products.

Cons:

- Subscription lifecycle and payout rules must be verified carefully.
- Less flexible than Stripe for classic SaaS billing.
- Reporting/tax workflows may be weaker.

### Crypto / USDT

Pros:

- Global availability for some users.
- Useful where cards are hard.

Cons:

- More compliance and accounting complexity.
- Harder monthly renewal UX.
- Higher operational/security risk.

Initial recommendation:

- Prefer Stripe Billing if available for the business jurisdiction.
- Keep Telegram-native payments as a later option.
- Avoid custom crypto billing in v1 unless there is a clear business reason.

## Dev And Production

Preferred approach: one GitHub repository with two Cloudflare Worker environments.

Environments:

- `dev`: test bots, test D1, test secrets, test domain.
- `production`: real bots, real D1, real secrets, production domain.

Pros:

- Same codebase.
- Safer releases.
- Production data is protected from tests.
- Clear deployment path: dev first, production after validation.

Cons:

- Wrangler config is more complex.
- Every secret and binding must be configured twice.

Alternative: two separate Cloudflare projects.

Pros:

- Strong isolation.
- Easier mental model.

Cons:

- More duplication.
- Higher risk of config drift.

Recommendation:

- Use one repo with Wrangler environments.
- Use separate D1 databases and separate Telegram bots for dev/prod.
- Later add GitHub Actions with manual approval for production deploy.

## ERD

```mermaid
erDiagram
  users {
    text id PK
    integer telegram_user_id UK
    text username
    text first_name
    text last_name
    text language_code
    text created_at
    text updated_at
    text last_seen_at
  }

  telegram_bots {
    text id PK
    text bot_username UK
    text bot_type
    text country_id FK
    text display_name
    text token_secret_name
    text webhook_url
    integer is_active
    text created_at
    text updated_at
  }

  countries {
    text id PK
    text iso2 UK
    text name
    text market_code
    text timezone
    integer is_active
  }

  user_country_preferences {
    text user_id FK
    text country_id FK
    integer enabled
    text created_at
    text updated_at
  }

  interest_topics {
    text id PK
    text code UK
    text title
    text description
    integer is_active
  }

  user_topic_preferences {
    text user_id FK
    text topic_id FK
    integer enabled
    text created_at
    text updated_at
  }

  watchlist_items {
    text id PK
    text user_id FK
    text ticker
    text country_id FK
    integer enabled
    text created_at
    text updated_at
  }

  subscriptions {
    text id PK
    text user_id FK
    text provider
    text provider_customer_id
    text provider_subscription_id
    text status
    text current_period_start
    text paid_until
    integer cancel_at_period_end
    text canceled_at
    text created_at
    text updated_at
  }

  payments {
    text id PK
    text subscription_id FK
    text provider
    text provider_payment_id
    integer amount_minor
    text currency
    text status
    text paid_at
    text raw_event_id
    text created_at
  }

  news_items {
    text id PK
    text country_id FK
    text source
    text title
    text url
    text summary
    text published_at
    text created_at
  }

  news_tickers {
    text news_id FK
    text ticker
    text company_name
    text country_id FK
    real confidence
  }

  analysis_runs {
    text id PK
    text trigger_type
    text country_id FK
    text user_id FK
    text news_id FK
    text ticker
    text timeframe
    text status
    text created_at
    text completed_at
    text error
  }

  analysis_results {
    text id PK
    text analysis_run_id FK
    text ticker
    real price
    real ema200
    real avwap
    real rsi14
    real roc20
    text direction
    text payload_json
    text created_at
  }

  signals {
    text id PK
    text analysis_result_id FK
    text strategy
    text side
    real price
    text condition
    text idea
    real stop
    real target
    real risk
    text created_at
  }

  digest_jobs {
    text id PK
    text country_id FK
    text run_date
    text status
    text created_at
    text started_at
    text completed_at
    text error
  }

  message_deliveries {
    text id PK
    text digest_job_id FK
    text user_id FK
    text bot_id FK
    text country_id FK
    text news_id FK
    text status
    text telegram_message_id
    text sent_at
    text error
  }

  api_clients {
    text id PK
    text name
    text token_hash
    integer is_active
    text created_at
    text last_used_at
  }

  audit_logs {
    text id PK
    text actor_type
    text actor_id
    text action
    text ip
    text user_agent
    text detail_json
    text created_at
  }

  countries ||--o{ telegram_bots : has
  users ||--o{ user_country_preferences : selects
  countries ||--o{ user_country_preferences : selected_by
  users ||--o{ user_topic_preferences : selects
  interest_topics ||--o{ user_topic_preferences : selected_by
  users ||--o{ watchlist_items : owns
  countries ||--o{ watchlist_items : contains
  users ||--o{ subscriptions : has
  subscriptions ||--o{ payments : records
  countries ||--o{ news_items : has
  news_items ||--o{ news_tickers : mentions
  countries ||--o{ news_tickers : maps
  news_items ||--o{ analysis_runs : triggers
  users ||--o{ analysis_runs : requests
  countries ||--o{ analysis_runs : scopes
  analysis_runs ||--o{ analysis_results : produces
  analysis_results ||--o{ signals : produces
  countries ||--o{ digest_jobs : schedules
  digest_jobs ||--o{ message_deliveries : sends
  users ||--o{ message_deliveries : receives
  telegram_bots ||--o{ message_deliveries : delivers
  countries ||--o{ message_deliveries : scopes
  news_items ||--o{ message_deliveries : includes
```

## Core API Draft

Telegram webhooks:

```text
POST /telegram/:botId/webhook
```

Onboarding:

```text
GET /api/countries
GET /api/topics
POST /api/users/:telegramUserId/preferences
GET /api/users/:telegramUserId/access
```

Manual analysis:

```text
POST /api/analyze
```

Body:

```json
{
  "telegram_user_id": 123,
  "bot_id": "us-stocks-bot",
  "tickers": "AAPL, MSFT"
}
```

Daily digest:

```text
POST /api/internal/digest/run
```

Only callable by cron/internal token.

## Security Requirements

- Bot tokens stored only as Cloudflare secrets or encrypted backend values.
- Telegram webhook endpoints should use Telegram `secret_token` or secret path.
- External API clients use hashed tokens in DB.
- Rate-limit manual ticker requests per user.
- Validate ticker symbols and country access.
- Check subscription on every protected action.
- Separate dev/prod secrets and D1 databases.
- Never log raw payment tokens, bot tokens, or API secrets.
- Store payment webhook events idempotently by provider event id.
- Add audit logs for subscription and preference changes.
- Use least-privilege admin access.

## Open Questions

1. Payment provider: Stripe, Telegram Payments, crypto, or hybrid?
2. Exact names/usernames for onboarding bot, US bot, and Israel bot.
3. Final onboarding checklist topics.
4. Whether free users get delayed news or no country bot access.
5. Daily digest time per country.
6. Whether watchlist tickers appear in daily digest v1 or only manual analysis.

