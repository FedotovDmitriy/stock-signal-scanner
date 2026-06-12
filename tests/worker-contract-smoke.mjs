import worker from "../cloudflare/worker.js";

const DEFAULT_ENV = {
  WEBHOOK_TOKEN: "test-token",
  TELEGRAM_BOT_TOKEN: "fake-telegram-token",
  DEFAULT_TIMEFRAME: "1d",
  DEFAULT_RISK: "1",
  DEFAULT_ANCHOR_BARS: "120",
  DEFAULT_STRATEGIES: "trend,breakout,volume_avwap,momentum",
};

let mode = "ok";
let telegramMessages = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith("https://api.telegram.org/")) {
    if (href.includes("/sendMessage")) telegramMessages.push(JSON.parse(String(init.body || "{}")));
    return jsonResponse({ ok: true, result: { message_id: telegramMessages.length + 1 } });
  }
  if (href.includes("/v8/finance/chart/")) {
    if (mode === "provider-error") return jsonResponse({ error: "temporary" }, 500);
    if (mode === "no-data") return jsonResponse({ chart: { result: [], error: { description: "no data" } } });
    return jsonResponse(chartPayload(href.includes("MSFT") ? 180 : 100));
  }
  if (href.includes("/v10/finance/quoteSummary/")) {
    return jsonResponse({ quoteSummary: { result: null, error: { description: "partial" } } }, 502);
  }
  if (href.includes("/v7/finance/quote")) {
    return jsonResponse({
      quoteResponse: {
        result: [{
          shortName: "Apple Inc.",
          regularMarketPrice: 210,
          currency: "USD",
          marketCap: 3000000000000,
          trailingPE: 32,
          forwardPE: 26,
          priceToBook: 45,
          epsTrailingTwelveMonths: 6.5,
        }],
      },
    });
  }
  return originalFetch(url, init);
};

try {
  await testValidTicker();
  await testInvalidTicker();
  await testNoDataTicker();
  await testProviderError();
  await testMultipleTickers();
  await testTelegramTickerRouting();
  await testPartialFundamentalResult();
  console.log("worker contract smoke tests ok");
} finally {
  globalThis.fetch = originalFetch;
}

async function testValidTicker() {
  mode = "ok";
  const result = await postScan({ ticker: "AAPL" });
  assert(result.requestId, "valid ticker returns requestId");
  assert(result.items?.[0]?.ticker === "AAPL", "valid ticker returns item ticker");
  assert(["signal_found", "no_signal"].includes(result.items[0].status), "valid ticker has result status");
  assert(result.items[0].analysisType === "technical", "valid ticker analysis type");
}

async function testInvalidTicker() {
  mode = "ok";
  const result = await postScan({ ticker: "THISISVERYLONGTICKER" });
  assert(result.items?.[0]?.status === "invalid_ticker", "invalid ticker status");
}

async function testNoDataTicker() {
  mode = "no-data";
  const result = await postScan({ ticker: "NODATA" });
  assert(result.items?.[0]?.status === "not_enough_data", "no data status");
}

async function testProviderError() {
  mode = "provider-error";
  const result = await postScan({ ticker: "AAPL" });
  assert(result.items?.[0]?.status === "data_provider_error", "provider error status");
}

async function testMultipleTickers() {
  mode = "ok";
  const result = await postScan({ tickers: "AAPL, MSFT" });
  assert(result.items?.length === 2, "multiple tickers return two items");
  assert(result.items.map((item) => item.ticker).join(",") === "AAPL,MSFT", "multiple ticker order");
}

async function testTelegramTickerRouting() {
  mode = "ok";
  telegramMessages = [];
  const update = {
    message: {
      text: "AAPL",
      chat: { id: 123, type: "private" },
      from: { id: 456, username: "tester" },
    },
  };
  const waits = [];
  const response = await worker.fetch(new Request("https://local.test/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  }), DEFAULT_ENV, { waitUntil: (promise) => waits.push(promise) });
  await Promise.all(waits);
  assert((await response.json()).ok === true, "telegram ticker webhook accepted");
  const text = telegramMessages[0]?.text || "";
  assert(text.includes("AAPL"), "telegram ticker report includes ticker");
  assert(text.includes("requestId:"), "telegram ticker report includes requestId");
}

async function testPartialFundamentalResult() {
  mode = "ok";
  telegramMessages = [];
  const update = {
    message: {
      text: "FundRep AAPL",
      chat: { id: 123, type: "private" },
      from: { id: 456, username: "tester" },
    },
  };
  const waits = [];
  const response = await worker.fetch(new Request("https://local.test/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  }), DEFAULT_ENV, { waitUntil: (promise) => waits.push(promise) });
  await Promise.all(waits);
  const accepted = await response.json();
  assert(accepted.ok === true, "fundrep webhook accepted");
  assert(telegramMessages.some((message) => String(message.text || "").includes("FundRep KPI summary")), "fundrep sends KPI summary");
}

async function postScan(payload) {
  const response = await worker.fetch(new Request("https://local.test/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Scanner-Token": DEFAULT_ENV.WEBHOOK_TOKEN },
    body: JSON.stringify({ ...payload, delivery: { sendToTelegram: false } }),
  }), DEFAULT_ENV, { waitUntil: () => {} });
  const data = await response.json();
  assert(response.status === 200, `POST /scan returned ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

function chartPayload(basePrice) {
  const now = Math.floor(Date.now() / 1000);
  const timestamp = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  const volume = [];
  for (let i = 0; i < 220; i += 1) {
    const price = basePrice + i * 0.35;
    timestamp.push(now - (220 - i) * 86400);
    open.push(price - 0.2);
    high.push(price + 1);
    low.push(price - 1);
    close.push(price);
    volume.push(1000000 + i * 1000);
  }
  return {
    chart: {
      result: [{
        timestamp,
        indicators: { quote: [{ open, high, low, close, volume }] },
      }],
    },
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
