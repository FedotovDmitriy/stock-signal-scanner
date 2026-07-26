import assert from "node:assert/strict";
import worker from "../cloudflare/worker.js";

const originalFetch = globalThis.fetch;
let currentCoreService = null;
const CORE_HMAC_KEY_ID = "scanner-test-v1";
const CORE_HMAC_SECRET = "scanner-test-hmac-secret-32-bytes-minimum";
const MOJIBAKE_RE = /(?:\u00c3|\u00d0|\u00e2\u20ac|\u00c2|\u00e2\u201a|\u00e2\u201e|\u00c5)/;

async function testSha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function testHmacHex(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

// Ответ MOEX ISS candles.json с пагинацией: total свечей, страницами по pagesize.
// Колонки в реальном ISS-порядке (open/close/high/low/value/volume/begin/end).
function moexCandlesPayload(secid = "SBER", { total = 220, start = 0, pagesize = 100 } = {}) {
  const columns = ["open", "close", "high", "low", "value", "volume", "begin", "end"];
  const data = [];
  const baseMs = Date.UTC(2025, 0, 1);
  for (let i = start; i < Math.min(start + pagesize, total); i += 1) {
    const close = 200 + i * 0.5;
    const day = new Date(baseMs + i * 86400 * 1000);
    const begin = `${day.toISOString().slice(0, 10)} 00:00:00`;
    const end = `${day.toISOString().slice(0, 10)} 23:59:59`;
    data.push([
      close - 0.3, // open
      close, // close
      close + 1.2, // high
      close - 1.2, // low
      close * 1500 * 1000, // value (рублёвый оборот)
      1500000 + i * 1000, // volume (штук)
      begin,
      end,
    ]);
  }
  return {
    candles: { columns, data },
    "candles.cursor": {
      columns: ["INDEX", "TOTAL", "PAGESIZE"],
      data: [[start, total, pagesize]],
    },
  };
}

function fundamentalPayload(symbol = "AAPL") {
  return {
    quoteSummary: {
      result: [{
        price: { shortName: `${symbol} Corp`, regularMarketPrice: { raw: 154.75 }, currency: "USD", marketCap: { raw: 25000000000 } },
        summaryDetail: { trailingPE: { raw: 24.5 }, forwardPE: { raw: 19.2 }, priceToSalesTrailing12Months: { raw: 4.1 }, beta: { raw: 1.1 } },
        defaultKeyStatistics: { trailingEps: { raw: 6.3 }, priceToBook: { raw: 3.2 }, enterpriseToEbitda: { raw: 12.4 } },
        financialData: {
          revenueGrowth: { raw: 0.12 }, earningsGrowth: { raw: 0.18 }, grossMargins: { raw: 0.46 },
          operatingMargins: { raw: 0.21 }, profitMargins: { raw: 0.16 }, returnOnEquity: { raw: 0.22 },
          returnOnAssets: { raw: 0.11 }, totalDebt: { raw: 4000000000 }, totalCash: { raw: 2500000000 },
          debtToEquity: { raw: 65 }, currentRatio: { raw: 1.6 }, targetMeanPrice: { raw: 180 },
        },
        assetProfile: { sector: "Technology", industry: "Software" },
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
    bot: { id: "private-premium-api" },
    ...overrides,
  };
}

const accessEnv = {
  ACCESS_CHECK_URL: "https://bot.test/api/internal/access/check",
  CORE_HMAC_KEY_ID,
  CORE_HMAC_SECRET,
};

function allowedAccessDecision(overrides = {}) {
  return {
    contractVersion: "1.1",
    allowed: true,
    chargeUnits: 3,
    quotaDecision: "new_fundrep",
    cacheStatus: "miss",
    reportSource: "new_analysis",
    remainingUnits: 10,
    reason: "Allowed",
    ...overrides,
  };
}

async function postAnalyze(payload, envOverrides = {}) {
  const env = {
    APP_ENV: "dev",
    ...accessEnv,
    WEBHOOK_TOKEN: "test-token",
    ADMIN_TOKEN: "admin-token",
    TELEGRAM_WEBHOOK_SECRET: "telegram-secret",
    DEFAULT_TIMEFRAME: "1d",
    CORE_SERVICE: currentCoreService,
    ...envOverrides,
  };
  if (envOverrides.CORE_SERVICE === undefined && currentCoreService === null) delete env.CORE_SERVICE;
  return worker.fetch(new Request("https://scanner.test/api/external/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Scanner-Token": "test-token",
    },
    body: JSON.stringify(payload),
  }), env, { waitUntil: () => {} });
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
    APP_ENV: "dev",
    ...accessEnv,
    WEBHOOK_TOKEN: "test-token",
    ADMIN_TOKEN: "admin-token",
    TELEGRAM_WEBHOOK_SECRET: "telegram-secret",
    DEFAULT_TIMEFRAME: "1d",
    CORE_SERVICE: currentCoreService,
  }, { waitUntil: () => {} });
}

async function withMockFetch(testFn, options = {}) {
  let yahooCalls = 0;
  let chartCalls = 0;
  let moexCalls = 0;
  let fundamentalCalls = 0;
  let telegramCalls = 0;
  let accessCalls = 0;
  let commitCalls = 0;
  let coreBindingCalls = 0;
  let hmacValid = true;
  const accessRequests = [];
  const commitRequests = [];
  const transportRequestIds = new Set();
  const authorizationHeaders = [];
  const callOrder = [];
  const telegramMessages = [];
  const businessDecisions = new Map();
  const committedReceipts = new Map();
  const receiptOwners = new Map();
  const ownedReports = new Map();
  const sharedReports = new Map();

  async function verifyCoreHmac(init, pathname) {
    const rawBody = String(init.body || "");
    const headers = new Headers(init.headers || {});
    const keyId = headers.get("X-Key-Id") || "";
    const transportRequestId = headers.get("X-Request-Id") || "";
    const timestamp = headers.get("X-Timestamp") || "";
    const signature = (headers.get("X-Signature") || "").replace(/^sha256=/, "");
    const bodyHash = await testSha256Hex(rawBody);
    const expected = await testHmacHex(options.coreExpectedSecret || CORE_HMAC_SECRET, `${timestamp}.${keyId}.${transportRequestId}.POST.${pathname}..${bodyHash}`);
    const valid = keyId === CORE_HMAC_KEY_ID && Boolean(transportRequestId) && signature === expected;
    hmacValid = hmacValid && valid;
    authorizationHeaders.push(headers.get("Authorization"));
    if (!valid || transportRequestIds.has(transportRequestId)) {
      return { error: Response.json({ error: "unauthorized" }, { status: transportRequestIds.has(transportRequestId) ? 409 : 401 }) };
    }
    transportRequestIds.add(transportRequestId);
    return { rawBody, transportRequestId };
  }

  async function handleCoreRequest(request) {
    coreBindingCalls += 1;
    const href = String(request.url);
    const init = {
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    };
    if (new URL(href).pathname === "/api/internal/access/check") {
      accessCalls += 1;
      callOrder.push("core");
      if (options.accessThrows) throw new Error("quota service unavailable");
      const verified = await verifyCoreHmac(init, "/api/internal/access/check");
      if (verified.error) return verified.error;
      if (options.accessStatus && options.accessStatus !== 200) {
        return Response.json(options.accessBody || { error: "quota service unavailable" }, { status: options.accessStatus });
      }
      const request = JSON.parse(verified.rawBody || "{}");
      accessRequests.push(request);
      const businessKey = `${request.requestId}:${request.ticker}`;
      const ownershipKey = `${request.userId || ""}:${request.ticker}:${request.reportType}:${request.generationVersion}:${request.language}`;
      const reportKey = `${request.ticker}:${request.reportType}:${request.generationVersion}:${request.language}`;
      const requestHash = JSON.stringify(request);
      const previous = businessDecisions.get(businessKey);
      if (previous) {
        if (previous.requestHash !== requestHash) {
          return Response.json({ contractVersion: "1.1", requestId: request.requestId, allowed: false, reason: "invalid_request" }, { status: 400 });
        }
        return Response.json(previous.decision);
      }
      const accessBody = typeof options.accessBody === "function" ? options.accessBody(request) : options.accessBody;
      const owned = ownedReports.get(ownershipKey);
      if (!accessBody && owned && request.cacheStatus === "hit") {
        const decision = {
          contractVersion: "1.1",
          requestId: request.requestId,
          allowed: true,
          chargeUnits: 0,
          quotaDecision: request.reportType === "fundrep" ? "own_repeat_fundrep" : "own_repeat",
          cacheStatus: "hit",
          reportSource: "own_repeat",
          remainingUnits: 10,
          reason: "Own repeat",
          cacheReceiptId: null,
        };
        businessDecisions.set(businessKey, { requestHash, decision });
        return Response.json(decision);
      }
      if (!accessBody && sharedReports.has(reportKey) && request.cacheStatus === "hit") {
        const decision = {
          contractVersion: "1.1",
          requestId: request.requestId,
          allowed: true,
          chargeUnits: 0,
          quotaDecision: request.reportType === "fundrep" ? "cached_fundrep" : "cached_regular",
          cacheStatus: "hit",
          reportSource: "cached_report",
          remainingUnits: 10,
          reason: "Shared cached report",
          cacheReceiptId: null,
        };
        businessDecisions.set(businessKey, { requestHash, decision });
        return Response.json(decision);
      }
      const decision = {
        contractVersion: "1.1",
        requestId: request.requestId,
        allowed: true,
        chargeUnits: 1,
        quotaDecision: "new_regular",
        cacheStatus: "miss",
        reportSource: "new_analysis",
        remainingUnits: 10,
        reason: "Allowed",
        cacheReceiptId: `receipt-${request.ticker}-${accessCalls}`,
        ...(accessBody || {}),
      };
      if (!/^(new|refresh)_(regular|fundrep)$/.test(decision.quotaDecision)) decision.cacheReceiptId = null;
      businessDecisions.set(businessKey, { requestHash, decision });
      if (decision.cacheReceiptId) receiptOwners.set(decision.cacheReceiptId, ownershipKey);
      return Response.json(decision);
    }
    if (new URL(href).pathname === "/api/internal/access/cache/commit") {
      commitCalls += 1;
      callOrder.push("commit");
      const verified = await verifyCoreHmac(init, "/api/internal/access/cache/commit");
      if (verified.error) return verified.error;
      const request = JSON.parse(verified.rawBody || "{}");
      commitRequests.push(request);
      const configuredStatus = Array.isArray(options.commitStatuses)
        ? options.commitStatuses[Math.min(commitCalls - 1, options.commitStatuses.length - 1)]
        : options.commitStatus;
      if (configuredStatus && configuredStatus !== 200) {
        return Response.json({ error: options.commitError || "cache_commit_failed" }, { status: configuredStatus });
      }
      const previous = committedReceipts.get(request.cacheReceiptId);
      if (previous && previous.resultDigest !== request.resultDigest) {
        return Response.json({ error: "cache_receipt_already_used" }, { status: 409 });
      }
      const committed = previous || {
        ...request,
        cacheEntryId: `entry-${request.cacheReceiptId}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
      committedReceipts.set(request.cacheReceiptId, committed);
      const ownerKey = receiptOwners.get(request.cacheReceiptId);
      if (ownerKey) ownedReports.set(ownerKey, committed);
      sharedReports.set(`${request.ticker}:${request.reportType}:${request.generationVersion}:${request.language}`, committed);
      if (options.dropFirstCommitResponse && commitCalls === 1) throw new Error("response lost after commit");
      return Response.json({ contractVersion: "1.1", cacheEntryId: committed.cacheEntryId, committed: true, expiresAt: committed.expiresAt });
    }
    throw new Error(`Unexpected CORE_SERVICE fetch: ${href}`);
  }

  currentCoreService = options.coreService === null ? null : { fetch: handleCoreRequest };

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href === "https://bot.test/api/internal/access/check" || href === "https://bot.test/api/internal/access/cache/commit") {
      throw new Error(`Core public fetch fallback is forbidden: ${href}`);
    }
    if (href.includes("/v10/finance/quoteSummary/")) {
      yahooCalls += 1;
      fundamentalCalls += 1;
      callOrder.push("provider");
      if (options.fundamentalStatus) return Response.json({ error: "fundamental provider unavailable" }, { status: options.fundamentalStatus });
      if (options.fundamentalEmpty) return Response.json({ quoteSummary: { result: [], error: null } });
      const symbol = decodeURIComponent(href.split("/quoteSummary/")[1].split("?")[0]);
      return Response.json(fundamentalPayload(symbol));
    }
    if (href.includes("/v7/finance/quote")) {
      yahooCalls += 1;
      fundamentalCalls += 1;
      callOrder.push("provider");
      if (options.fundamentalStatus) return Response.json({ error: "fundamental provider unavailable" }, { status: options.fundamentalStatus });
      return Response.json({ quoteResponse: { result: [] } });
    }
    if (href.includes("iss.moex.com")) {
      moexCalls += 1;
      callOrder.push("provider");
      if (options.moexStatus) {
        return Response.json({ error: "iss unavailable" }, { status: options.moexStatus });
      }
      if (options.moexEmpty) {
        return Response.json({ candles: { columns: ["open", "close", "high", "low", "value", "volume", "begin", "end"], data: [] } });
      }
      const parsed = new URL(href);
      const secid = parsed.pathname.split("/securities/")[1].split("/")[0];
      const start = Number(parsed.searchParams.get("start") || 0);
      return Response.json(moexCandlesPayload(secid, { start }));
    }
    if (href.includes("query1.finance.yahoo.com")) {
      yahooCalls += 1;
      chartCalls += 1;
      callOrder.push("provider");
      if (options.yahooStatus) {
        return Response.json({ error: "provider unavailable" }, { status: options.yahooStatus });
      }
      if (options.yahooJsonThrows) {
        return {
          ok: true,
          status: 200,
          json: async () => { throw new Error("invalid provider response"); },
        };
      }
      return Response.json(candlesPayload());
    }
    if (href.includes("api.telegram.org")) {
      telegramCalls += 1;
      callOrder.push("telegram");
      if (typeof FormData !== "undefined" && init.body instanceof FormData) {
        telegramMessages.push({ caption: String(init.body.get("caption") || ""), document: true });
      } else try {
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
      get chartCalls() { return chartCalls; },
      get moexCalls() { return moexCalls; },
      get fundamentalCalls() { return fundamentalCalls; },
      get telegramCalls() { return telegramCalls; },
      get accessCalls() { return accessCalls; },
      get commitCalls() { return commitCalls; },
      get coreBindingCalls() { return coreBindingCalls; },
      get hmacValid() { return hmacValid; },
      accessRequests,
      commitRequests,
      transportRequestIds,
      authorizationHeaders,
      callOrder,
      telegramMessages,
    });
  } finally {
    globalThis.fetch = originalFetch;
    currentCoreService = null;
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
    assert.equal(body.report.language, "ru");
    assert.deepEqual(body.report.strategies, ["trend", "breakout", "volume_avwap", "momentum"]);
    assert.equal(body.telegram.sendToTelegram, false);
    assert.equal(calls.yahooCalls, 1);
  });
}

async function testAccessCheckAllowsAnalysis() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["ACCS"], language: "ru", userId: "user-1", chatId: "chat-1" }), {
      ACCESS_CHECK_URL: "https://bot.test/api/internal/access/check",
      CORE_HMAC_SECRET,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "processed");
    assert.equal(body.report.language, "ru");
    assert.equal(body.access[0].quotaDecision, "new_regular");
    assert.equal(calls.accessCalls, 1);
    assert.equal(calls.yahooCalls, 1);
  });
}

async function testCoreHmacRequestContract() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["HMA1", "HMA2"], userId: "hmac-user" }));
    assert.equal(response.status, 200);
    assert.equal(calls.hmacValid, true);
    assert.equal(calls.authorizationHeaders.every((value) => value == null), true);
    assert.equal(calls.transportRequestIds.size, 4);
    assert.equal(calls.accessRequests.length, 2);
    assert.equal(calls.commitRequests.length, 2);
    assert.equal(calls.accessRequests.every((request) => request.contractVersion === "1.1"), true);
    assert.equal(calls.accessRequests.every((request) => Object.hasOwn(request, "chatId") && request.chatId === null), true);
    assert.equal(calls.accessRequests.every((request) => request.cacheStatus === "miss" && request.cacheCreatedAt === null && request.cacheGenerationVersion === null), true);
    assert.equal(calls.callOrder[0], "core");
    assert.ok(calls.callOrder.indexOf("provider") > calls.callOrder.lastIndexOf("core"));
  });
}

async function testAccessCheckUsesCoreServiceBinding() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["BIND"] }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "processed");
    assert.equal(calls.accessCalls, 1);
    assert.equal(calls.coreBindingCalls >= 2, true);
    assert.equal(calls.callOrder[0], "core");
    assert.equal(calls.hmacValid, true);
  });
}

async function testCacheCommitFlowAndDigest() {
  await withMockFetch(async (calls) => {
    const requestId = `commit-${crypto.randomUUID()}`;
    const response = await postAnalyze(validPayload({ requestId, tickers: ["CMIT"], generationVersion: "gv-commit", language: "en" }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "processed");
    assert.equal(body.access[0].cacheCommitStatus, "committed");
    assert.equal(calls.commitCalls, 1);
    assert.deepEqual(calls.commitRequests[0], {
      contractVersion: "1.1",
      cacheReceiptId: "receipt-CMIT-1",
      requestId,
      ticker: "CMIT",
      reportType: "regular",
      generationVersion: "gv-commit",
      language: "en",
      resultDigest: calls.commitRequests[0].resultDigest,
    });
    assert.match(calls.commitRequests[0].resultDigest, /^[a-f0-9]{64}$/);
    assert.ok(calls.callOrder.indexOf("commit") > calls.callOrder.indexOf("provider"));
    assert.equal(calls.authorizationHeaders.every((value) => value == null), true);
    assert.equal(calls.coreBindingCalls, 2);
  });
}

async function testCacheCommitUsesCoreServiceBinding() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["BCMT"] }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "processed");
    assert.equal(body.access[0].cacheCommitStatus, "committed");
    assert.equal(calls.accessCalls, 1);
    assert.equal(calls.commitCalls, 1);
    assert.equal(calls.coreBindingCalls, 2);
    assert.deepEqual(calls.callOrder, ["core", "provider", "commit"]);
  });
}

async function testMissingCoreServiceBindingFailsClosedBeforeAnalysis() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["NOBD"], telegramChatId: "12345" }), { CORE_SERVICE: null });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, "failed");
    assert.equal(body.errors[0].code, "failed_quota_service");
    assert.equal(calls.coreBindingCalls, 0);
    assert.equal(calls.accessCalls, 0);
    assert.equal(calls.yahooCalls, 0);
    assert.equal(calls.commitCalls, 0);
    assert.equal(calls.telegramCalls, 0);
  });
}

async function testCacheCommitRetryIsIdempotent() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["CRTY"] }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.access[0].cacheCommitStatus, "committed");
    assert.equal(calls.commitCalls, 2);
    assert.deepEqual(calls.commitRequests[0], calls.commitRequests[1]);
    assert.equal(calls.yahooCalls, 1);
    assert.equal(calls.transportRequestIds.size, 3);
  }, { dropFirstCommitResponse: true });
}

async function testCacheCommitReceiptFailuresDoNotHideReport() {
  for (const failure of [
    { status: 410, error: "cache_receipt_expired" },
    { status: 400, error: "cache_receipt_mismatch" },
    { status: 409, error: "cache_receipt_already_used" },
  ]) {
    await withMockFetch(async (calls) => {
      const response = await postAnalyze(validPayload({ tickers: [`CF${failure.status}`] }));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, "processed");
      assert.equal(body.access[0].cacheCommitStatus, "failed");
      assert.equal(calls.yahooCalls, 1);
      assert.equal(calls.commitCalls, 1);
      assert.equal(calls.telegramCalls, 0);
    }, { commitStatus: failure.status, commitError: failure.error });
  }
}

async function testInvalidCoreHmacFailsClosed() {
  const payload = validPayload({
    tickers: ["HBAD"],
    telegramChatId: "12345",
  });
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(payload, { CORE_HMAC_SECRET: "wrong-scanner-hmac-secret-32-bytes-minimum" });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, "failed");
    assert.equal(body.errors[0].code, "failed_quota_service");
    assert.equal(calls.hmacValid, false);
    assert.equal(calls.yahooCalls, 0);
    assert.equal(calls.telegramCalls, 0);
  });
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(payload, { TELEGRAM_BOT_TOKEN: "fake-token" });
    assert.equal(response.status, 200);
    assert.ok(calls.yahooCalls >= 1);
    assert.equal(calls.telegramCalls, 0);
  });
}

async function testReceiptRequiredForNewAndRefresh() {
  for (const quotaDecision of ["new_regular", "refresh_regular", "new_fundrep", "refresh_fundrep"]) {
    await withMockFetch(async (calls) => {
      const response = await postAnalyze(validPayload({
        tickers: [`RCPT${quotaDecision.length}`],
        reportType: quotaDecision.endsWith("fundrep") ? "fundrep" : "regular",
        forceRefresh: quotaDecision.startsWith("refresh"),
      }));
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.status, "failed");
      assert.equal(body.errors[0].code, "invalid_core_response");
      assert.equal(calls.yahooCalls, 0);
      assert.equal(calls.commitCalls, 0);
    }, { accessBody: allowedAccessDecision({ quotaDecision, cacheReceiptId: null }) });
  }
}

async function testDeniedCoreDecisionBlocksCacheProviderAndTelegram() {
  await withMockFetch(async () => {
    await postAnalyze(validPayload({ tickers: ["HDNY"], generationVersion: "hmac-v1" }));
  });
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({
      tickers: ["HDNY"],
      generationVersion: "hmac-v1",
      telegramChatId: "12345",
    }), { TELEGRAM_BOT_TOKEN: "fake-token" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "rejected");
    assert.deepEqual(calls.callOrder, ["core"]);
    assert.equal(calls.yahooCalls, 0);
    assert.equal(calls.telegramCalls, 0);
  }, {
    accessBody: {
      contractVersion: "1.1",
      allowed: false,
      chargeUnits: 0,
      quotaDecision: "rejected_no_access",
      cacheStatus: "hit",
      reportSource: "none",
      remainingUnits: 10,
      reason: "No access",
    },
  });
}

async function testAccessCheckRejectsBeforeAnalysis() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ userId: "user-2", chatId: "chat-2" }), {
      ACCESS_CHECK_URL: "https://bot.test/api/internal/access/check",
      CORE_HMAC_SECRET,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "rejected");
    assert.equal(body.report, null);
    assert.equal(body.errors[0].code, "rejected_no_quota");
    assert.equal(calls.accessCalls, 1);
    assert.equal(calls.yahooCalls, 0);
  }, {
    accessBody: {
      contractVersion: "1.1",
      allowed: false,
      chargeUnits: 0,
      quotaDecision: "rejected_no_quota",
      cacheStatus: "miss",
      reportSource: "new_analysis",
      remainingUnits: 0,
      reason: "No quota",
    },
  });
}

async function testProductionFailsClosedWhenAccessUnavailable() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ userId: "user-3", chatId: "chat-3" }), {
      APP_ENV: "production",
      ACCESS_CHECK_URL: "https://bot.test/api/internal/access/check",
      CORE_HMAC_SECRET,
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, "failed");
    assert.equal(body.errors[0].code, "failed_quota_service");
    assert.equal(calls.accessCalls, 1);
    assert.equal(calls.yahooCalls, 0);
  }, { accessThrows: true });
}

async function testProviderFailureReturnsFailedStatus() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["PROV"] }));
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.status, "failed");
    assert.equal(body.errors[0].code, "data_provider_error");
    assert.ok(calls.yahooCalls >= 1);
    assert.equal(calls.commitCalls, 0);
  }, { yahooStatus: 500 });
}

async function testInternalScannerFailureReturnsFailedStatus() {
  await withMockFetch(async () => {
    const response = await postAnalyze(validPayload({ tickers: ["INTR"] }));
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.status, "failed");
    assert.equal(body.errors[0].code, "scanner_error");
  }, { yahooJsonThrows: true });
}

async function testMoexTickerRoutesToIssProvider() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["SBER.ME"] }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "processed");
    assert.equal(body.report.analysisType, "technical");
    const item = body.report.items[0];
    assert.equal(item.ticker, "SBER.ME");
    // Свечи должны приехать из MOEX ISS, а не из Yahoo chart.
    assert.ok(item.dataSources.includes("MOEX ISS"));
    assert.equal(item.dataSources.includes("Yahoo Finance chart"), false);
    assert.ok(calls.moexCalls >= 1);
    assert.equal(calls.chartCalls, 0);
    // Маппинг ISS -> внутренние свечи корректен: индикаторы посчитаны, цена есть.
    assert.equal(typeof item.price.value, "number");
    assert.equal(typeof item.indicators.ema200, "number");
  });
}

function testMoexPaginationPagesUntilEnd() {
  // Проверяем чистую логику пагинации/маппинга без сети: моком fetch отдаём 3 страницы.
  return withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["GAZP.ME"] }));
    assert.equal(response.status, 200);
    // 220 свечей при pagesize=100 => 3 запроса к ISS (start=0,100,200).
    assert.equal(calls.moexCalls, 3);
    const body = await response.json();
    assert.equal(body.report.items[0].ticker, "GAZP.ME");
  });
}

async function testRegularTickerStaysOnYahoo() {
  await withMockFetch(async (calls) => {
    // Уникальный тикер, чтобы не попасть в модульный кэш свечей от других тестов.
    const response = await postAnalyze(validPayload({ tickers: ["USYA"] }));
    assert.equal(response.status, 200);
    const body = await response.json();
    const item = body.report.items[0];
    assert.ok(item.dataSources.includes("Yahoo Finance chart"));
    assert.equal(item.dataSources.includes("MOEX ISS"), false);
    assert.equal(calls.chartCalls, 1);
    assert.equal(calls.moexCalls, 0);
  });
}

async function testMoexProviderFailureIsGraceful() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["LKOH.ME"] }));
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.status, "failed");
    assert.equal(body.errors[0].code, "data_provider_error");
    assert.ok(calls.moexCalls >= 1);
    assert.equal(calls.chartCalls, 0);
  }, { moexStatus: 503 });
}

async function testRegularCachedReportReturnedWithoutProviderCall() {
  const env = {
    ACCESS_CHECK_URL: "https://bot.test/api/internal/access/check",
    CORE_HMAC_SECRET,
  };
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["CACH"], language: "ru", generationVersion: "v1" }), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "processed");
    assert.equal(calls.yahooCalls, 1);
  });

  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["CACH"], language: "ru", generationVersion: "v1" }), env);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "processed");
    assert.equal(body.report.orchestrator.status, "technical_report_cache_hit");
    assert.equal(body.report.generationVersion, "v1");
    assert.equal(calls.yahooCalls, 0);
    assert.equal(calls.commitCalls, 0);
    assert.equal(calls.accessRequests[0].cacheStatus, "hit");
    assert.equal(typeof calls.accessRequests[0].cacheCreatedAt, "string");
    assert.equal(calls.accessRequests[0].cacheGenerationVersion, "v1");
  }, {
    accessBody: {
      contractVersion: "1.1",
      allowed: true,
      chargeUnits: 0,
      quotaDecision: "cached_regular",
      cacheStatus: "hit",
      reportSource: "cached_report",
      remainingUnits: 10,
      reason: "Use cached report",
    },
  });
}

async function testMissingPromisedCachedReportFailsClosed() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["MISS"], language: "ru", generationVersion: "v1" }), {
      ACCESS_CHECK_URL: "https://bot.test/api/internal/access/check",
      CORE_HMAC_SECRET,
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, "failed");
    assert.equal(body.errors[0].code, "cached_report_not_found");
    assert.equal(calls.yahooCalls, 0);
  }, {
    accessBody: {
      contractVersion: "1.1",
      allowed: true,
      chargeUnits: 0,
      quotaDecision: "cached_regular",
      cacheStatus: "hit",
      reportSource: "cached_report",
      remainingUnits: 10,
      reason: "Use cached report",
    },
  });
}

async function testNewFundRepCreatesStructuredReportAndCache() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["FNEW"], reportType: "fundrep", language: "en", generationVersion: "fv1" }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "processed");
    assert.equal(body.report.analysisType, "fundamental");
    assert.equal(body.report.reportType, "fundrep");
    assert.equal(body.report.language, "en");
    assert.equal(body.report.generationVersion, "fv1");
    assert.equal(body.report.cacheStatus, "miss");
    assert.equal(body.report.fundamentalResults[0].ticker, "FNEW");
    assert.equal(typeof body.report.fundamentalResults[0].fundamentalSummary.valuation.trailingPE, "number");
    assert.equal(body.report.fundamentalResults[0].dataSources.includes("Yahoo Finance quoteSummary"), true);
    assert.equal(JSON.stringify(body.report).includes("<!doctype html>"), false);
    assert.equal(calls.fundamentalCalls, 1);
    assert.equal(calls.telegramCalls, 0);
  });
}

async function testFundRepCachedReportReturnedWithoutProviders() {
  await withMockFetch(async () => {
    const response = await postAnalyze(validPayload({ tickers: ["FCRP"], reportType: "fundrep", language: "ru", generationVersion: "fv1" }), accessEnv);
    assert.equal(response.status, 200);
  }, { accessBody: allowedAccessDecision() });

  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["FCRP"], reportType: "fundrep", language: "ru", generationVersion: "fv1" }), accessEnv);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "processed");
    assert.equal(body.report.analysisType, "fundamental");
    assert.equal(body.report.cacheStatus, "hit");
    assert.equal(calls.yahooCalls, 0);
  }, { accessBody: allowedAccessDecision({ chargeUnits: 0, quotaDecision: "cached_fundrep", cacheStatus: "hit", reportSource: "cached_report" }) });
}

async function testFundRepMissingCachedReportFailsClosed() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["FUND"], reportType: "fundrep" }), {
      ...accessEnv,
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, "failed");
    assert.equal(body.errors[0].code, "fundrep_cache_not_found");
    assert.equal(calls.yahooCalls, 0);
  }, {
    accessBody: allowedAccessDecision({ chargeUnits: 0, quotaDecision: "cached_fundrep", cacheStatus: "hit", reportSource: "cached_report" }),
  });
}

async function testFundRepExpiredCacheFailsClosed() {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await withMockFetch(async () => {
      const response = await postAnalyze(validPayload({ tickers: ["FEXP"], reportType: "fundrep", generationVersion: "fv1" }), accessEnv);
      assert.equal(response.status, 200);
    }, { accessBody: allowedAccessDecision() });
    now += 61 * 60 * 1000;
    await withMockFetch(async (calls) => {
      const response = await postAnalyze(validPayload({ tickers: ["FEXP"], reportType: "fundrep", generationVersion: "fv1" }), accessEnv);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.errors[0].code, "fundrep_cache_not_found");
      assert.equal(calls.yahooCalls, 0);
    }, { accessBody: allowedAccessDecision({ quotaDecision: "cached_fundrep", reportSource: "cached_report", cacheStatus: "hit" }) });
  } finally {
    Date.now = realNow;
  }
}

async function testFundRepForceRefreshRecalculatesAndUpdatesCache() {
  await withMockFetch(async () => {
    await postAnalyze(validPayload({ tickers: ["FREF"], reportType: "fundrep", generationVersion: "fv1" }), accessEnv);
  }, { accessBody: allowedAccessDecision() });

  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["FREF"], reportType: "fundrep", generationVersion: "fv1", forceRefresh: true }), accessEnv);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.report.cacheStatus, "refreshed");
    assert.ok(calls.chartCalls >= 1);
    assert.ok(calls.fundamentalCalls >= 1);
  }, { accessBody: allowedAccessDecision({ quotaDecision: "refresh_fundrep" }) });
}

async function testInvalidForceRefreshCachedDecisionFailsClosed() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["FINV"], reportType: "fundrep", forceRefresh: true }), accessEnv);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, "failed");
    assert.equal(body.errors[0].code, "invalid_access_decision");
    assert.equal(calls.yahooCalls, 0);
    assert.equal(calls.telegramCalls, 0);
  }, { accessBody: allowedAccessDecision({ quotaDecision: "cached_fundrep", reportSource: "cached_report", cacheStatus: "hit" }) });
}

async function testRegularAndFundRepCachesDoNotIntersect() {
  await withMockFetch(async () => {
    const response = await postAnalyze(validPayload({ tickers: ["RFND"], reportType: "regular", language: "ru", generationVersion: "v1" }));
    assert.equal(response.status, 200);
  });
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["RFND"], reportType: "fundrep", language: "ru", generationVersion: "v1" }), accessEnv);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).errors[0].code, "fundrep_cache_not_found");
    assert.equal(calls.yahooCalls, 0);
  }, { accessBody: allowedAccessDecision({ quotaDecision: "cached_fundrep", reportSource: "cached_report", cacheStatus: "hit" }) });
}

async function testFundRepCacheSeparatesLanguageAndGenerationVersion() {
  await withMockFetch(async () => {
    await postAnalyze(validPayload({ tickers: ["FKEY"], reportType: "fundrep", language: "ru", generationVersion: "v1" }), accessEnv);
  }, { accessBody: allowedAccessDecision() });
  for (const variant of [{ language: "en", generationVersion: "v1" }, { language: "ru", generationVersion: "v2" }]) {
    await withMockFetch(async (calls) => {
      const response = await postAnalyze(validPayload({ tickers: ["FKEY"], reportType: "fundrep", ...variant }), accessEnv);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).errors[0].code, "fundrep_cache_not_found");
      assert.equal(calls.yahooCalls, 0);
    }, { accessBody: allowedAccessDecision({ quotaDecision: "cached_fundrep", reportSource: "cached_report", cacheStatus: "hit" }) });
  }
}

async function testFundRepMultiTickerMixedCache() {
  await withMockFetch(async () => {
    await postAnalyze(validPayload({ tickers: ["FMIX"], reportType: "fundrep", generationVersion: "v1" }), accessEnv);
  }, { accessBody: allowedAccessDecision() });
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["FMIX", "FNEW2"], reportType: "fundrep", generationVersion: "v1" }), accessEnv);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.report.cacheStatus, "mixed");
    assert.deepEqual(body.report.fundamentalResults.map((item) => item.ticker), ["FMIX", "FNEW2"]);
    assert.equal(calls.fundamentalCalls, 1);
    assert.equal(calls.commitCalls, 1);
    assert.equal(calls.commitRequests[0].ticker, "FNEW2");
    assert.equal(calls.commitRequests[0].cacheReceiptId, "receipt-FNEW2-2");
  }, {
    accessBody: (request) => allowedAccessDecision(request.ticker === "FMIX"
      ? { chargeUnits: 0, quotaDecision: "cached_fundrep", reportSource: "cached_report", cacheStatus: "hit" }
      : {}),
  });
}

async function testFundRepProviderFailureIsNotCached() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["FFAIL"], reportType: "fundrep", generationVersion: "v1" }), accessEnv);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).status, "failed");
    assert.ok(calls.fundamentalCalls >= 2);
  }, { accessBody: allowedAccessDecision(), fundamentalStatus: 500 });
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["FFAIL"], reportType: "fundrep", generationVersion: "v1" }), accessEnv);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).errors[0].code, "fundrep_cache_not_found");
    assert.equal(calls.yahooCalls, 0);
  }, { accessBody: allowedAccessDecision({ quotaDecision: "cached_fundrep", reportSource: "cached_report", cacheStatus: "hit" }) });
}

async function testFundRepDuplicateRequestIdAndTelegramPrivacy() {
  const requestId = `fund-dup-${crypto.randomUUID()}`;
  await withMockFetch(async (calls) => {
    const payload = validPayload({
      requestId,
      tickers: ["FDUP"],
      reportType: "fundrep",
      telegramChatId: "12345",
    });
    const first = await postAnalyze(payload, { TELEGRAM_BOT_TOKEN: "fake-token" });
    assert.equal(first.status, 200);
    const firstTelegramCalls = calls.telegramCalls;
    const second = await postAnalyze(payload, { TELEGRAM_BOT_TOKEN: "fake-token" });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.deepEqual(secondBody.report.tickers, ["FDUP"]);
    assert.equal(calls.fundamentalCalls, 1);
    assert.equal(calls.accessCalls, 2);
    assert.equal(calls.commitCalls, 1);
    assert.equal(calls.coreBindingCalls, 3);
    assert.equal(firstTelegramCalls, 0);
    assert.equal(calls.telegramCalls, firstTelegramCalls);
    assert.equal(JSON.stringify(secondBody).includes("12345"), false);
  });
}

async function testQuotaBusinessFieldsRejected() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ remainingUnits: 100 }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.status, "rejected");
    assert.equal(body.errors.some((error) => error.field === "remainingUnits"), true);
    assert.equal(calls.accessCalls, 0);
    assert.equal(calls.yahooCalls, 0);
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
    const payload = validPayload({ requestId, tickers: ["DUPL"], userId: "dup-owner", generationVersion: "dup-v1" });
    const first = await postAnalyze(payload);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    const second = await postAnalyze(payload);
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.requestId, requestId);
    assert.deepEqual(secondBody.report.tickers, firstBody.report.tickers);
    assert.equal(calls.yahooCalls, 1);
    assert.equal(calls.accessCalls, 2);
    assert.equal(calls.commitCalls, 1);
    assert.equal(calls.commitRequests.length, 1);
    assert.equal(calls.accessRequests[1].requestId, requestId);
    assert.equal(calls.accessRequests[1].cacheStatus, "miss");
  });
}

async function testChangedDuplicatePayloadFailsClosed() {
  await withMockFetch(async (calls) => {
    const requestId = `changed-${crypto.randomUUID()}`;
    const first = await postAnalyze(validPayload({ requestId, tickers: ["CHNG"], language: "ru", userId: "changed-owner" }));
    assert.equal(first.status, 200);
    const second = await postAnalyze(validPayload({ requestId, tickers: ["CHNG"], language: "en", userId: "changed-owner" }));
    assert.equal(second.status, 503);
    const body = await second.json();
    assert.equal(body.status, "failed");
    assert.equal(body.report, null);
    assert.equal(body.errors[0].code, "failed_quota_service");
    assert.equal(calls.yahooCalls, 1);
    assert.equal(calls.commitCalls, 1);
    assert.equal(calls.accessCalls, 2);
  });
}

async function testOwnRepeatNewRequestIdUsesLocalCache() {
  await withMockFetch(async (calls) => {
    const base = {
      tickers: ["OWNR"],
      userId: "owner-repeat-user",
      generationVersion: "own-repeat-v1",
      language: "ru",
    };
    const first = await postAnalyze(validPayload({ ...base, requestId: `own-first-${crypto.randomUUID()}` }));
    assert.equal(first.status, 200);
    const repeat = await postAnalyze(validPayload({ ...base, requestId: `own-repeat-${crypto.randomUUID()}` }));
    assert.equal(repeat.status, 200);
    const body = await repeat.json();
    assert.equal(body.status, "processed");
    assert.equal(body.report.orchestrator.status, "technical_report_cache_hit");
    assert.equal(body.access[0].quotaDecision, "own_repeat");
    assert.equal(body.access[0].reportSource, "own_repeat");
    assert.equal(body.access[0].chargeUnits, 0);
    assert.equal(body.access[0].cacheReceiptId, null);
    assert.equal(calls.yahooCalls, 1);
    assert.equal(calls.accessCalls, 2);
    assert.equal(calls.commitCalls, 1);
  });
}

async function testOwnRepeatMissingLocalCacheFailsClosed() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({
      tickers: ["OWNM"],
      userId: "missing-own-cache-user",
      requestId: `own-missing-${crypto.randomUUID()}`,
      generationVersion: "own-missing-v1",
    }));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, "failed");
    assert.equal(body.report, null);
    assert.equal(body.errors[0].code, "cached_report_not_found");
    assert.equal(calls.yahooCalls, 0);
    assert.equal(calls.commitCalls, 0);
    assert.equal(calls.telegramCalls, 0);
  }, {
    accessBody: {
      contractVersion: "1.1",
      allowed: true,
      chargeUnits: 0,
      quotaDecision: "own_repeat",
      cacheStatus: "hit",
      reportSource: "own_repeat",
      remainingUnits: 10,
      reason: "Own repeat",
      cacheReceiptId: null,
    },
  });
}

async function testSharedCacheForAnotherUserUsesLocalCache() {
  await withMockFetch(async (calls) => {
    const shared = {
      tickers: ["SHRD"],
      generationVersion: "shared-v1",
      language: "ru",
    };
    const first = await postAnalyze(validPayload({ ...shared, requestId: `shared-first-${crypto.randomUUID()}`, userId: "shared-owner" }));
    assert.equal(first.status, 200);
    const second = await postAnalyze(validPayload({ ...shared, requestId: `shared-second-${crypto.randomUUID()}`, userId: "shared-other" }));
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.equal(body.status, "processed");
    assert.equal(body.report.orchestrator.status, "technical_report_cache_hit");
    assert.equal(body.access[0].quotaDecision, "cached_regular");
    assert.equal(body.access[0].reportSource, "cached_report");
    assert.equal(calls.yahooCalls, 1);
    assert.equal(calls.accessCalls, 2);
    assert.equal(calls.commitCalls, 1);
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
    assert.equal(body.telegram.chatId, null);
    assert.equal(JSON.stringify(body).includes("12345"), false);
    assert.equal(calls.accessRequests[0].chatId, null);
    assert.equal(calls.telegramCalls, 0);
  });
}

async function testDeliverySendToTelegramTrueRejected() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({
      telegramChatId: "12345",
      delivery: { sendToTelegram: true },
    }), { TELEGRAM_BOT_TOKEN: "fake-token" });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.status, "rejected");
    assert.equal(body.errors.some((error) => error.field === "delivery.sendToTelegram" && error.code === "telegram_delivery_not_allowed"), true);
    assert.equal(JSON.stringify(body).includes("12345"), false);
    assert.equal(calls.accessCalls, 0);
    assert.equal(calls.yahooCalls, 0);
    assert.equal(calls.telegramCalls, 0);
  });
}

async function testBotTokenSecretNameRejectedInPrivateApi() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({
      bot: { id: "private-premium-api", tokenSecretName: "TELEGRAM_BOT_TOKEN_PRIVATE" },
    }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.status, "rejected");
    assert.equal(body.errors.some((error) => error.field === "bot.tokenSecretName" && error.code === "telegram_bot_not_allowed"), true);
    assert.equal(calls.accessCalls, 0);
    assert.equal(calls.yahooCalls, 0);
    assert.equal(calls.telegramCalls, 0);
  });
}

async function testUpstreamLanguageControlsJsonReport() {
  const cases = [
    {
      language: "ru-RU",
      canonical: "ru",
      ticker: "LGRU",
      forbidden: /[\u0590-\u05ff]|Analysis report|Status:|Price:|Movement:|Signals:|Why:|Condition:|Idea:|Stop:|Target:|Risk:/,
    },
    {
      language: "en-US",
      canonical: "en",
      ticker: "LGEN",
      forbidden: /[А-Яа-яЁё\u0590-\u05ff]/,
    },
    {
      language: "he-IL",
      canonical: "he",
      ticker: "LGHE",
      forbidden: /Отчёт анализа|Статус|Цена|Движение|Сигналы|Почему|Условие|Идея|Стоп|Цель|Риск|Analysis report|Status:|Price:|Movement:|Signals:|Why:|Condition:|Idea:|Stop:|Target:|Risk:/,
    },
    {
      language: "iw",
      canonical: "he",
      ticker: "LGIW",
      forbidden: /Отчёт анализа|Статус|Цена|Движение|Сигналы|Почему|Условие|Идея|Стоп|Цель|Риск|Analysis report|Status:|Price:|Movement:|Signals:|Why:|Condition:|Idea:|Stop:|Target:|Risk:/,
    },
  ];

  for (const testCase of cases) {
    await withMockFetch(async (calls) => {
      const response = await postAnalyze(validPayload({
        tickers: [testCase.ticker],
        language: testCase.language,
        telegramChatId: "12345",
      }), { TELEGRAM_BOT_TOKEN: "fake-token" });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, "processed");
      assert.equal(body.report.language, testCase.canonical);
      const report = JSON.stringify(body.report.items);
      assert.equal(JSON.stringify(body).includes("12345"), false);
      assert.equal(MOJIBAKE_RE.test(report), false);
      assert.equal(testCase.forbidden.test(report), false);
      assert.equal(testCase.forbidden.test(body.report.items[0].signals[0]?.explanation || ""), false);
      assert.equal(calls.telegramCalls, 0);
    });
  }
}

async function testUserMessagesDoNotContainMojibake() {
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
    const waits = [];
    const response = await worker.fetch(new Request("https://scanner.test/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "telegram-secret" },
      body: JSON.stringify(update),
    }), env, { waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    assert.equal(response.status, 200);
    const text = calls.telegramMessages.map((message) => `${message.text || ""}\n${message.caption || ""}`).join("\n");
    assert.equal(MOJIBAKE_RE.test(text), false);
    assert.equal(text.includes("Почему:"), true);
  });
}
async function testUnsupportedLanguageRejectedBeforeExternalCalls() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({
      language: "pl",
      telegramChatId: "12345",
    }), {
      ACCESS_CHECK_URL: "https://bot.test/api/internal/access/check",
      CORE_HMAC_SECRET,
      TELEGRAM_BOT_TOKEN: "fake-token",
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.status, "rejected");
    assert.equal(body.errors.some((error) => error.field === "language" && error.code === "unsupported_language"), true);
    assert.equal(calls.accessCalls, 0);
    assert.equal(calls.yahooCalls, 0);
    assert.equal(calls.telegramCalls, 0);
  });
}

async function testServiceTokenRequiredInHeader() {
  await withMockFetch(async () => {
    const missing = await postAnalyzeWithHeaders(validPayload());
    assert.equal(missing.status, 403);
    const missingBody = await missing.json();
    assert.equal(missingBody.status, "rejected");
    assert.equal(missingBody.errors[0].code, "authentication_failed");
    const bodyOnly = await postAnalyzeWithHeaders({ ...validPayload(), token: "test-token", apiToken: "test-token" });
    assert.equal(bodyOnly.status, 403);
    const bodyOnlyBody = await bodyOnly.json();
    assert.equal(bodyOnlyBody.status, "rejected");
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
    assert.equal(/[×-×ª]/.test(reportText), false);
    assert.equal(reportText.includes("Почему:"), true);
  });
}

const tests = [
  testValidContractPayload,
  testAccessCheckAllowsAnalysis,
  testCoreHmacRequestContract,
  testAccessCheckUsesCoreServiceBinding,
  testCacheCommitFlowAndDigest,
  testCacheCommitUsesCoreServiceBinding,
  testMissingCoreServiceBindingFailsClosedBeforeAnalysis,
  testCacheCommitRetryIsIdempotent,
  testCacheCommitReceiptFailuresDoNotHideReport,
  testInvalidCoreHmacFailsClosed,
  testReceiptRequiredForNewAndRefresh,
  testDeniedCoreDecisionBlocksCacheProviderAndTelegram,
  testAccessCheckRejectsBeforeAnalysis,
  testProductionFailsClosedWhenAccessUnavailable,
  testProviderFailureReturnsFailedStatus,
  testInternalScannerFailureReturnsFailedStatus,
  testMoexTickerRoutesToIssProvider,
  testMoexPaginationPagesUntilEnd,
  testRegularTickerStaysOnYahoo,
  testMoexProviderFailureIsGraceful,
  testRegularCachedReportReturnedWithoutProviderCall,
  testMissingPromisedCachedReportFailsClosed,
  testNewFundRepCreatesStructuredReportAndCache,
  testFundRepCachedReportReturnedWithoutProviders,
  testFundRepMissingCachedReportFailsClosed,
  testFundRepExpiredCacheFailsClosed,
  testFundRepForceRefreshRecalculatesAndUpdatesCache,
  testInvalidForceRefreshCachedDecisionFailsClosed,
  testRegularAndFundRepCachesDoNotIntersect,
  testFundRepCacheSeparatesLanguageAndGenerationVersion,
  testFundRepMultiTickerMixedCache,
  testFundRepProviderFailureIsNotCached,
  testFundRepDuplicateRequestIdAndTelegramPrivacy,
  testQuotaBusinessFieldsRejected,
  testMissingContractVersion,
  testWrongTickerFormat,
  testDuplicateRequestId,
  testChangedDuplicatePayloadFailsClosed,
  testOwnRepeatNewRequestIdUsesLocalCache,
  testOwnRepeatMissingLocalCacheFailsClosed,
  testSharedCacheForAnotherUserUsesLocalCache,
  testScannerResponseFormat,
  testDeliverySendToTelegramFalse,
  testDeliverySendToTelegramTrueRejected,
  testBotTokenSecretNameRejectedInPrivateApi,
  testUpstreamLanguageControlsJsonReport,
  testUserMessagesDoNotContainMojibake,
  testUnsupportedLanguageRejectedBeforeExternalCalls,
  testServiceTokenRequiredInHeader,
  testClearLogsRequiresAdminToken,
  testTelegramWebhookSecretRequired,
];

for (const test of tests) {
  await test();
  console.log(`ok ${test.name}`);
}
