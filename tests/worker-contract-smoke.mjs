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
    bot: { id: "us-stocks-bot", tokenSecretName: "TELEGRAM_BOT_TOKEN_US_STOCKS_BOT" },
    ...overrides,
  };
}

const accessEnv = {
  BYPASS_QUOTA_CHECK: "false",
  ACCESS_CHECK_URL: "https://bot.test/api/internal/access/check",
  INTERNAL_API_SECRET: "internal-secret",
};

function allowedAccessDecision(overrides = {}) {
  return {
    contractVersion: "1.0",
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
  return worker.fetch(new Request("https://scanner.test/api/external/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Scanner-Token": "test-token",
    },
    body: JSON.stringify(payload),
  }), {
    APP_ENV: "dev",
    BYPASS_QUOTA_CHECK: "true",
    WEBHOOK_TOKEN: "test-token",
    ADMIN_TOKEN: "admin-token",
    TELEGRAM_WEBHOOK_SECRET: "telegram-secret",
    DEFAULT_TIMEFRAME: "1d",
    ...envOverrides,
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
    APP_ENV: "dev",
    BYPASS_QUOTA_CHECK: "true",
    WEBHOOK_TOKEN: "test-token",
    ADMIN_TOKEN: "admin-token",
    TELEGRAM_WEBHOOK_SECRET: "telegram-secret",
    DEFAULT_TIMEFRAME: "1d",
  }, { waitUntil: () => {} });
}

async function withMockFetch(testFn, options = {}) {
  let yahooCalls = 0;
  let chartCalls = 0;
  let fundamentalCalls = 0;
  let telegramCalls = 0;
  let accessCalls = 0;
  const telegramMessages = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href === "https://bot.test/api/internal/access/check") {
      accessCalls += 1;
      if (options.accessThrows) throw new Error("quota service unavailable");
      if (options.accessStatus && options.accessStatus !== 200) {
        return Response.json(options.accessBody || { error: "quota service unavailable" }, { status: options.accessStatus });
      }
      const request = JSON.parse(String(init.body || "{}"));
      const accessBody = typeof options.accessBody === "function" ? options.accessBody(request) : options.accessBody;
      return Response.json(accessBody || {
        contractVersion: "1.0",
        requestId: request.requestId,
        allowed: true,
        chargeUnits: 1,
        quotaDecision: "new_regular",
        cacheStatus: "miss",
        reportSource: "new_analysis",
        remainingUnits: 10,
        reason: "Allowed",
      });
    }
    if (href.includes("/v10/finance/quoteSummary/")) {
      yahooCalls += 1;
      fundamentalCalls += 1;
      if (options.fundamentalStatus) return Response.json({ error: "fundamental provider unavailable" }, { status: options.fundamentalStatus });
      if (options.fundamentalEmpty) return Response.json({ quoteSummary: { result: [], error: null } });
      const symbol = decodeURIComponent(href.split("/quoteSummary/")[1].split("?")[0]);
      return Response.json(fundamentalPayload(symbol));
    }
    if (href.includes("/v7/finance/quote")) {
      yahooCalls += 1;
      fundamentalCalls += 1;
      if (options.fundamentalStatus) return Response.json({ error: "fundamental provider unavailable" }, { status: options.fundamentalStatus });
      return Response.json({ quoteResponse: { result: [] } });
    }
    if (href.includes("query1.finance.yahoo.com")) {
      yahooCalls += 1;
      chartCalls += 1;
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
      get fundamentalCalls() { return fundamentalCalls; },
      get telegramCalls() { return telegramCalls; },
      get accessCalls() { return accessCalls; },
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
    assert.equal(body.report.language, "ru");
    assert.deepEqual(body.report.strategies, ["trend", "breakout", "volume_avwap", "momentum"]);
    assert.equal(body.telegram.sendToTelegram, false);
    assert.equal(calls.yahooCalls, 1);
  });
}

async function testAccessCheckAllowsAnalysis() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ tickers: ["ACCS"], language: "ru", userId: "user-1", chatId: "chat-1" }), {
      BYPASS_QUOTA_CHECK: "false",
      ACCESS_CHECK_URL: "https://bot.test/api/internal/access/check",
      INTERNAL_API_SECRET: "internal-secret",
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

async function testAccessCheckRejectsBeforeAnalysis() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({ userId: "user-2", chatId: "chat-2" }), {
      BYPASS_QUOTA_CHECK: "false",
      ACCESS_CHECK_URL: "https://bot.test/api/internal/access/check",
      INTERNAL_API_SECRET: "internal-secret",
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
      contractVersion: "1.0",
      requestId: "access-denied",
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
      BYPASS_QUOTA_CHECK: "true",
      ACCESS_CHECK_URL: "https://bot.test/api/internal/access/check",
      INTERNAL_API_SECRET: "internal-secret",
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

async function testRegularCachedReportReturnedWithoutProviderCall() {
  const env = {
    BYPASS_QUOTA_CHECK: "false",
    ACCESS_CHECK_URL: "https://bot.test/api/internal/access/check",
    INTERNAL_API_SECRET: "internal-secret",
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
  }, {
    accessBody: {
      contractVersion: "1.0",
      allowed: true,
      chargeUnits: 0,
      quotaDecision: "own_repeat",
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
      BYPASS_QUOTA_CHECK: "false",
      ACCESS_CHECK_URL: "https://bot.test/api/internal/access/check",
      INTERNAL_API_SECRET: "internal-secret",
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, "failed");
    assert.equal(body.errors[0].code, "cached_report_not_found");
    assert.equal(calls.yahooCalls, 0);
  }, {
    accessBody: {
      contractVersion: "1.0",
      allowed: true,
      chargeUnits: 0,
      quotaDecision: "own_repeat",
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
  }, { accessBody: allowedAccessDecision({ chargeUnits: 0, quotaDecision: "own_repeat_fundrep", cacheStatus: "hit", reportSource: "cached_report" }) });
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
    accessBody: allowedAccessDecision({ chargeUnits: 0, quotaDecision: "own_repeat_fundrep", cacheStatus: "hit", reportSource: "cached_report" }),
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
    }, { accessBody: allowedAccessDecision({ reportSource: "cached_report", cacheStatus: "hit" }) });
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
  }, { accessBody: allowedAccessDecision({ reportSource: "cached_report", cacheStatus: "hit" }) });
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
  }, { accessBody: allowedAccessDecision({ reportSource: "cached_report", cacheStatus: "hit" }) });
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
    }, { accessBody: allowedAccessDecision({ reportSource: "cached_report", cacheStatus: "hit" }) });
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
  }, {
    accessBody: (request) => allowedAccessDecision(request.ticker === "FMIX"
      ? { chargeUnits: 0, quotaDecision: "own_repeat_fundrep", reportSource: "cached_report", cacheStatus: "hit" }
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
  }, { accessBody: allowedAccessDecision({ reportSource: "cached_report", cacheStatus: "hit" }) });
}

async function testFundRepDuplicateRequestIdAndTelegramPrivacy() {
  const requestId = `fund-dup-${crypto.randomUUID()}`;
  await withMockFetch(async (calls) => {
    const first = await postAnalyze(validPayload({
      requestId,
      tickers: ["FDUP"],
      reportType: "fundrep",
      telegramChatId: "12345",
      delivery: { sendToTelegram: true },
    }), { TELEGRAM_BOT_TOKEN_US_STOCKS_BOT: "fake-token" });
    assert.equal(first.status, 200);
    const second = await postAnalyze(validPayload({ requestId, tickers: ["OTHER"], reportType: "fundrep" }));
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.deepEqual(secondBody.report.tickers, ["FDUP"]);
    assert.equal(calls.fundamentalCalls, 1);
    const userText = calls.telegramMessages.map((message) => `${message.text || ""}\n${message.caption || ""}`).join("\n");
    assert.equal(/requestId|quotaDecision|chargeUnits|remainingUnits|reportSource/.test(userText), false);
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
    const first = await postAnalyze(validPayload({ requestId, tickers: ["DUPL"] }));
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

async function testUpstreamLanguageControlsTelegramReport() {
  const cases = [
    {
      language: "ru-RU",
      canonical: "ru",
      ticker: "LGRU",
      expected: "Отчёт анализа",
      forbidden: /[א-ת]|Analysis report|Status:|Price:|Movement:|Signals:|Why:|Condition:|Idea:|Stop:|Target:|Risk:/,
    },
    {
      language: "en-US",
      canonical: "en",
      ticker: "LGEN",
      expected: "Analysis report",
      forbidden: /[А-Яа-яЁёא-ת]/,
    },
    {
      language: "he-IL",
      canonical: "he",
      ticker: "LGHE",
      expected: "דוח ניתוח",
      forbidden: /Отчёт анализа|Статус|Цена|Движение|Сигналы|Почему|Условие|Идея|Стоп|Цель|Риск|Analysis report|Status:|Price:|Movement:|Signals:|Why:|Condition:|Idea:|Stop:|Target:|Risk:/,
    },
    {
      language: "iw",
      canonical: "he",
      ticker: "LGIW",
      expected: "דוח ניתוח",
      forbidden: /Отчёт анализа|Статус|Цена|Движение|Сигналы|Почему|Условие|Идея|Стоп|Цель|Риск|Analysis report|Status:|Price:|Movement:|Signals:|Why:|Condition:|Idea:|Stop:|Target:|Risk:/,
    },
  ];

  for (const testCase of cases) {
    await withMockFetch(async (calls) => {
      const response = await postAnalyze(validPayload({
        tickers: [testCase.ticker],
        language: testCase.language,
        telegramChatId: "12345",
        delivery: { sendToTelegram: true },
      }), { TELEGRAM_BOT_TOKEN_US_STOCKS_BOT: "fake-token" });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, "processed");
      assert.equal(body.report.language, testCase.canonical);
      const report = String(calls.telegramMessages.at(-1)?.text || "");
      assert.equal(report.includes(testCase.expected), true);
      assert.equal(report.includes("requestId"), false);
      assert.equal(testCase.forbidden.test(report), false);
      assert.equal(testCase.forbidden.test(body.report.items[0].signals[0]?.explanation || ""), false);
    });
  }
}

async function testUnsupportedLanguageRejectedBeforeExternalCalls() {
  await withMockFetch(async (calls) => {
    const response = await postAnalyze(validPayload({
      language: "pl",
      telegramChatId: "12345",
      delivery: { sendToTelegram: true },
    }), {
      BYPASS_QUOTA_CHECK: "false",
      ACCESS_CHECK_URL: "https://bot.test/api/internal/access/check",
      INTERNAL_API_SECRET: "internal-secret",
      TELEGRAM_BOT_TOKEN_US_STOCKS_BOT: "fake-token",
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
    assert.equal(/[א-ת]/.test(reportText), false);
    assert.equal(reportText.includes("Почему:"), true);
  });
}

const tests = [
  testValidContractPayload,
  testAccessCheckAllowsAnalysis,
  testAccessCheckRejectsBeforeAnalysis,
  testProductionFailsClosedWhenAccessUnavailable,
  testProviderFailureReturnsFailedStatus,
  testInternalScannerFailureReturnsFailedStatus,
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
  testScannerResponseFormat,
  testDeliverySendToTelegramFalse,
  testUpstreamLanguageControlsTelegramReport,
  testUnsupportedLanguageRejectedBeforeExternalCalls,
  testServiceTokenRequiredInHeader,
  testClearLogsRequiresAdminToken,
  testTelegramWebhookSecretRequired,
];

for (const test of tests) {
  await test();
  console.log(`ok ${test.name}`);
}
