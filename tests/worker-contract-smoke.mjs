import assert from "node:assert/strict";
import worker from "../cloudflare/worker.js";

const originalFetch = globalThis.fetch;

function candlesPayload(symbol = "AAPL") {
  const now = Math.floor(Date.now() / 1000);
  const timestamp = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  const volume = [];
  for (let i = 0; i < 220; i += 1) {
    const price = 100 + i * 0.25;
    timestamp.push(now - (220 - i) * 86400);
    open.push(price - 0.2);
    high.push(price + 0.8);
    low.push(price - 0.8);
    close.push(price);
    volume.push(1000000 + i * 1000);
  }
  return {
    chart: {
      result: [{
        meta: { symbol },
        timestamp,
        indicators: { quote: [{ open, high, low, close, volume }] },
      }],
      error: null,
    },
  };
}

function validPayload(overrides = {}) {
  return {
    contractVersion: "1.0",
    requestId: `req-${crypto.randomUUID()}`,
    source: "contract-test",
    country: { iso2: "US", name: "United States", timezone: "America/New_York" },
    news: { id: "news-1", title: "Market update", source: "test" },
    tickers: ["AAPL"],
    analysis: {
      timeframe: "1d",
      risk: 1,
      anchorBars: 120,
      strategies: ["trend", "breakout", "volume_avwap", "momentum"],
    },
    delivery: { sendToTelegram: false },
    bot: { id: "us-stocks-bot", tokenSecretName: "TELEGRAM_BOT_TOKEN_US_STOCKS_BOT" },
    ...overrides,
  };
}

async function postAnalyze(payload) {
  return worker.fetch(new Request("https://scanner.test/api/external/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Scanner-Token": "test-token",
    },
    body: JSON.stringify(payload),
  }), {
    WEBHOOK_TOKEN: "test-token",
    ADMIN_TOKEN: "admin-token",
    TELEGRAM_WEBHOOK_SECRET: "telegram-secret",
    DEFAULT_TIMEFRAME: "1d",
  }, { waitUntil: () => {} });
}

async function postAnalyzeWithHeaders(payload, headers = {}) {
  return worker.fetch(new Request("https://scanner.test/api/external/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  }), {
    WEBHOOK_TOKEN: "test-token",
    ADMIN_TOKEN: "admin-token",
    TELEGRAM_WEBHOOK_SECRET: "telegram-secret",
    DEFAULT_TIMEFRAME: "1d",
  }, { waitUntil: () => {} });
}

async function withMockFetch(testFn) {
  let yahooCalls = 0;
  let telegramCalls = 0;
  const telegramMessages = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("query1.finance.yahoo.com")) {
      yahooCalls += 1;
      return Response.json(candlesPayload());
    }
    if (href.includes("api.telegram.org")) {
      telegramCalls += 1;
      try {
        telegramMessages.push(JSON.parse(String(init.body || "{}")));
      } catch {
        telegramMessages.push({});
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
  try {
    await testFn({
      get yahooCalls() { return yahooCalls; },
      get telegramCalls() { return telegramCalls; },
      telegramMessages,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testValidContractPayload() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.contractVersion, "1.0");
    assert.equal(body.status, "processed");
    assert.equal(body.report.analysisType, "technical");
    assert.deepEqual(body.report.strategies, ["trend", "breakout", "volume_avwap", "momentum"]);
    assert.equal(body.telegram.sendToTelegram, false);
    assert.equal(calls.yahooCalls, 1);
  });
}

async function testMissingContractVersion() {
  await withMockFetch(async () => {
    const payload = validPayload();
    delete payload.contractVersion;
    const response = await postAnalyze(payload);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.contractVersion, "1.0");
    assert.equal(body.status, "rejected");
    assert.equal(body.errors.some((error) => error.field === "contractVersion"), true);
  });
}

async function testWrongTickerFormat() {
  await withMockFetch(async () => {
    const response = await postAnalyze(validPayload({ tickers: ["BAD!"] }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.status, "rejected");
    assert.equal(body.errors.some((error) => error.code === "invalid_ticker"), true);
  });
}

async function testDuplicateRequestId() {
  await withMockFetch(async (calls) => {
    const requestId = `dup-${crypto.randomUUID()}`;
    const first = await postAnalyze(validPayload({ requestId, tickers: ["AAPL"] }));
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    const second = await postAnalyze(validPayload({ requestId, tickers: ["MSFT"] }));
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.requestId, requestId);
    assert.deepEqual(secondBody.report.tickers, firstBody.report.tickers);
    assert.equal(calls.yahooCalls, 1);
  });
}

async function testScannerResponseFormat() {
  await withMockFetch(async () => {
    const response = await postAnalyze(validPayload());
    const body = await response.json();
    assert.equal(typeof body.requestId, "string");
    assert.ok(["processed", "rejected", "failed"].includes(body.status));
    assert.equal(Array.isArray(body.errors), true);
    assert.equal(Array.isArray(body.report.rows), true);
    assert.equal(Array.isArray(body.report.items), true);
    assert.equal(typeof body.report.risk, "number");
    assert.equal(Number.isInteger(body.report.anchorBars), true);
  });
}

async function testDeliverySendToTelegramFalse() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ delivery: { sendToTelegram: false }, telegramChatId: "12345" }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.telegram.sendToTelegram, false);
    assert.equal(body.telegram.delivered, false);
    assert.equal(calls.telegramCalls, 0);
  });
}

async function testServiceTokenRequiredInHeader() {
  await withMockFetch(async () => {
    const missing = await postAnalyzeWithHeaders(validPayload());
    assert.equal(missing.status, 403);
    const bodyOnly = await postAnalyzeWithHeaders({ ...validPayload(), token: "test-token", apiToken: "test-token" });
    assert.equal(bodyOnly.status, 403);
    const bearer = await postAnalyzeWithHeaders(validPayload(), { Authorization: "Bearer test-token" });
    assert.equal(bearer.status, 200);
  });
}

async function testClearLogsRequiresAdminToken() {
  const base = {
    WEBHOOK_TOKEN: "test-token",
    ADMIN_TOKEN: "admin-token",
    TELEGRAM_WEBHOOK_SECRET: "telegram-secret",
  };
  const webhookToken = await worker.fetch(new Request("https://scanner.test/api/clear-logs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Scanner-Token": "test-token" },
    body: JSON.stringify({}),
  }), base, { waitUntil: () => {} });
  assert.equal(webhookToken.status, 403);

  const bodyAdminToken = await worker.fetch(new Request("https://scanner.test/api/clear-logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adminToken: "admin-token" }),
  }), base, { waitUntil: () => {} });
  assert.equal(bodyAdminToken.status, 403);

  const adminToken = await worker.fetch(new Request("https://scanner.test/api/clear-logs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": "admin-token" },
    body: JSON.stringify({}),
  }), base, { waitUntil: () => {} });
  assert.equal(adminToken.status, 200);
  assert.deepEqual(await adminToken.json(), { ok: true, logs: [] });
}

async function testTelegramWebhookSecretRequired() {
  await withMockFetch(async (calls) => {
    const update = {
      message: {
        text: "AAPL",
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "tester" },
      },
    };
    const env = {
      TELEGRAM_BOT_TOKEN: "fake-token",
      TELEGRAM_WEBHOOK_SECRET: "telegram-secret",
      DEFAULT_TIMEFRAME: "1d",
    };
    const missing = await worker.fetch(new Request("https://scanner.test/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }), env, { waitUntil: () => {} });
    assert.equal(missing.status, 403);

    const wrong = await worker.fetch(new Request("https://scanner.test/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wrong" },
      body: JSON.stringify(update),
    }), env, { waitUntil: () => {} });
    assert.equal(wrong.status, 403);

    const waits = [];
    const valid = await worker.fetch(new Request("https://scanner.test/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "telegram-secret" },
      body: JSON.stringify(update),
    }), env, { waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { ok: true });
    const reportText = String(calls.telegramMessages.at(-1)?.text || "");
    assert.equal(reportText.includes("requestId:"), false);
    assert.equal(/[א-ת]/.test(reportText), false);
    assert.equal(reportText.includes("Почему:"), true);
  });
}

const tests = [
  testValidContractPayload,
  testMissingContractVersion,
  testWrongTickerFormat,
  testDuplicateRequestId,
  testScannerResponseFormat,
  testDeliverySendToTelegramFalse,
  testServiceTokenRequiredInHeader,
  testClearLogsRequiresAdminToken,
  testTelegramWebhookSecretRequired,
];

for (const test of tests) {
  await test();
  console.log(`ok ${test.name}`);
}
