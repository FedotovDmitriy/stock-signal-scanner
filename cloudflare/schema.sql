CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  telegram_user_id INTEGER UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS countries (
  id TEXT PRIMARY KEY,
  iso2 TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  market_code TEXT,
  timezone TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS telegram_bots (
  id TEXT PRIMARY KEY,
  bot_username TEXT UNIQUE NOT NULL,
  bot_type TEXT NOT NULL,
  country_id TEXT,
  display_name TEXT NOT NULL,
  token_secret_name TEXT NOT NULL,
  webhook_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (country_id) REFERENCES countries(id)
);

CREATE TABLE IF NOT EXISTS user_country_preferences (
  user_id TEXT NOT NULL,
  country_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, country_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (country_id) REFERENCES countries(id)
);

CREATE TABLE IF NOT EXISTS interest_topics (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS user_topic_preferences (
  user_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, topic_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (topic_id) REFERENCES interest_topics(id)
);

CREATE TABLE IF NOT EXISTS watchlist_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  country_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (country_id) REFERENCES countries(id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  status TEXT NOT NULL,
  current_period_start TEXT,
  paid_until TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  canceled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  subscription_id TEXT,
  provider TEXT NOT NULL,
  provider_payment_id TEXT,
  amount_minor INTEGER,
  currency TEXT,
  status TEXT NOT NULL,
  paid_at TEXT,
  raw_event_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
);

CREATE TABLE IF NOT EXISTS news_items (
  id TEXT PRIMARY KEY,
  country_id TEXT NOT NULL,
  source TEXT,
  title TEXT NOT NULL,
  url TEXT,
  summary TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (country_id) REFERENCES countries(id)
);

CREATE TABLE IF NOT EXISTS news_tickers (
  news_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  company_name TEXT,
  country_id TEXT,
  confidence REAL,
  PRIMARY KEY (news_id, ticker),
  FOREIGN KEY (news_id) REFERENCES news_items(id),
  FOREIGN KEY (country_id) REFERENCES countries(id)
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  country_id TEXT,
  user_id TEXT,
  news_id TEXT,
  ticker TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  FOREIGN KEY (country_id) REFERENCES countries(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (news_id) REFERENCES news_items(id)
);

CREATE TABLE IF NOT EXISTS analysis_results (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  price REAL,
  ema200 REAL,
  avwap REAL,
  rsi14 REAL,
  roc20 REAL,
  direction TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id)
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  analysis_result_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  side TEXT NOT NULL,
  price REAL,
  condition TEXT,
  idea TEXT,
  stop REAL,
  target REAL,
  risk REAL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (analysis_result_id) REFERENCES analysis_results(id)
);

CREATE TABLE IF NOT EXISTS digest_jobs (
  id TEXT PRIMARY KEY,
  country_id TEXT NOT NULL,
  run_date TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  FOREIGN KEY (country_id) REFERENCES countries(id)
);

CREATE TABLE IF NOT EXISTS message_deliveries (
  id TEXT PRIMARY KEY,
  digest_job_id TEXT,
  user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  country_id TEXT,
  news_id TEXT,
  status TEXT NOT NULL,
  telegram_message_id TEXT,
  sent_at TEXT,
  error TEXT,
  FOREIGN KEY (digest_job_id) REFERENCES digest_jobs(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (bot_id) REFERENCES telegram_bots(id),
  FOREIGN KEY (country_id) REFERENCES countries(id),
  FOREIGN KEY (news_id) REFERENCES news_items(id)
);

CREATE TABLE IF NOT EXISTS api_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS allowed_users (
  telegram_user_id TEXT PRIMARY KEY,
  username TEXT,
  note TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS allowed_chats (
  telegram_chat_id TEXT PRIMARY KEY,
  title TEXT,
  chat_type TEXT,
  note TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  origin TEXT NOT NULL,
  action TEXT NOT NULL,
  tickers TEXT NOT NULL,
  status TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '-',
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ticker_request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  origin TEXT NOT NULL,
  source TEXT NOT NULL,
  tickers TEXT NOT NULL,
  status TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '-',
  chat_id TEXT,
  user_id TEXT,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS analysis_tasks (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  tickers TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  strategies TEXT NOT NULL,
  risk REAL NOT NULL,
  anchor_bars INTEGER NOT NULL,
  request_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  response_ms INTEGER,
  signal_count INTEGER NOT NULL DEFAULT 0,
  quality_score REAL NOT NULL DEFAULT 0,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS analysis_cache (
  cache_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contract_results (
  request_id TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL,
  status TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_request_logs_time ON request_logs(time);
CREATE INDEX IF NOT EXISTS idx_ticker_request_logs_time ON ticker_request_logs(time);
CREATE INDEX IF NOT EXISTS idx_analysis_tasks_created ON analysis_tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_analysis_tasks_status ON analysis_tasks(status);
CREATE INDEX IF NOT EXISTS idx_analysis_cache_expires ON analysis_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_contract_results_status ON contract_results(status);
CREATE INDEX IF NOT EXISTS idx_allowed_users_enabled ON allowed_users(enabled);
CREATE INDEX IF NOT EXISTS idx_allowed_chats_enabled ON allowed_chats(enabled);
CREATE INDEX IF NOT EXISTS idx_users_telegram_user_id ON users(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_paid_until ON subscriptions(paid_until);
CREATE INDEX IF NOT EXISTS idx_watchlist_user_id ON watchlist_items(user_id);
CREATE INDEX IF NOT EXISTS idx_news_items_country_published ON news_items(country_id, published_at);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_ticker ON analysis_runs(ticker);
CREATE INDEX IF NOT EXISTS idx_message_deliveries_user_id ON message_deliveries(user_id);
