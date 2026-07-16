PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE users (
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
CREATE TABLE countries (
  id TEXT PRIMARY KEY,
  iso2 TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  market_code TEXT,
  timezone TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE telegram_bots (
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
CREATE TABLE user_country_preferences (
  user_id TEXT NOT NULL,
  country_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, country_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (country_id) REFERENCES countries(id)
);
CREATE TABLE interest_topics (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE user_topic_preferences (
  user_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, topic_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (topic_id) REFERENCES interest_topics(id)
);
CREATE TABLE watchlist_items (
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
CREATE TABLE subscriptions (
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
CREATE TABLE payments (
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
CREATE TABLE news_items (
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
CREATE TABLE news_tickers (
  news_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  company_name TEXT,
  country_id TEXT,
  confidence REAL,
  PRIMARY KEY (news_id, ticker),
  FOREIGN KEY (news_id) REFERENCES news_items(id),
  FOREIGN KEY (country_id) REFERENCES countries(id)
);
CREATE TABLE analysis_runs (
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
CREATE TABLE analysis_results (
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
CREATE TABLE signals (
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
CREATE TABLE digest_jobs (
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
CREATE TABLE message_deliveries (
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
CREATE TABLE api_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  origin TEXT NOT NULL,
  action TEXT NOT NULL,
  tickers TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
INSERT INTO "request_logs" ("id","time","origin","action","tickers","status","detail") VALUES(1,'2026-06-08T08:27:43.530Z','telegram chat_id=993841366; type=private; user_id=993841366; username=@feddmi; name=Dmitriy Fedotov; lang=en; ip=91.108.5.7','Telegram analysis','AMD','started','');
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('request_logs',1);
CREATE INDEX idx_request_logs_time ON request_logs(time);
CREATE INDEX idx_users_telegram_user_id ON users(telegram_user_id);
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_paid_until ON subscriptions(paid_until);
CREATE INDEX idx_watchlist_user_id ON watchlist_items(user_id);
CREATE INDEX idx_news_items_country_published ON news_items(country_id, published_at);
CREATE INDEX idx_analysis_runs_ticker ON analysis_runs(ticker);
CREATE INDEX idx_message_deliveries_user_id ON message_deliveries(user_id);
