const DEFAULT_TIMEFRAME = "1d";
import { fundMetricLabel, isSupportedReportLanguage, normalizeReportLanguage, reportText } from "./report-i18n.js";

const DEFAULT_STRATEGIES = ["trend", "breakout", "volume_avwap", "momentum"];
const MAX_TICKER_LENGTH = 12;
const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-=]{0,11}$/;
const MARKET_CACHE_TTL_SECONDS = 15 * 60;
const RESULT_CACHE_TTL_SECONDS = 15 * 60;
const TECHNICAL_REPORT_CACHE_TTL_SECONDS = 60 * 60;
const FUNDREP_REPORT_CACHE_TTL_SECONDS = 60 * 60;
const ORCHESTRATOR_RETRY_LIMIT = 2;
const CONTRACT_VERSION = "1.0";
const CORE_ACCESS_CONTRACT_VERSION = "1.1";
const DEFAULT_GENERATION_VERSION = "1";
const CONTRACT_STRATEGIES = ["trend", "breakout", "volume_avwap", "momentum"];
const ACCESS_CHECK_PATH = "/api/internal/access/check";
const fallbackContractResults = new Map();
const fallbackAnalysisCache = new Map();

const TIMEFRAMES = {
  "1m": { interval: "1m", range: "7d" },
  "2m": { interval: "2m", range: "60d" },
  "5m": { interval: "5m", range: "60d" },
  "15m": { interval: "15m", range: "60d" },
  "30m": { interval: "30m", range: "60d" },
  "1h": { interval: "60m", range: "730d" },
  "1d": { interval: "1d", range: "3y" },
  "1wk": { interval: "1wk", range: "10y" },
};

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return corsResponse(null, 204);
      }
      if (request.method === "GET" && url.pathname === "/") {
        return json({
          ok: true,
          service: "stock-signal-scanner-cloudflare",
          endpoints: ["/api/status", "/api/admin/access-list", "/scan", "/api/external/analyze", "/api/webhook/analyze", "/api/test-telegram", "/api/clear-logs", "/telegram/webhook"],
        });
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        const logs = await latestLogs(env);
        const tickerLogs = await latestTickerLogs(env);
        const stats = await latestStats(env);
        const orchestrator = await latestOrchestratorSnapshot(env);
        const technicalMonitoring = await latestTechnicalMonitoring(env);
        return json({
          ok: true,
          environment: env.APP_ENV || "dev",
          time: new Date().toISOString(),
          defaultTimeframe: env.DEFAULT_TIMEFRAME || DEFAULT_TIMEFRAME,
          worker: "online",
          logs,
          tickerLogs,
          stats,
          orchestrator,
          technicalMonitoring,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/admin/access-list") {
        assertAdminToken(request, env);
        return json(await adminAccessList(env));
      }
      if (request.method === "POST" && url.pathname === "/api/admin/allowed-users") {
        const payload = await readJson(request);
        assertAdminToken(request, env, payload);
        await saveAllowedUser(env, payload);
        return json(await adminAccessList(env));
      }
      if (request.method === "POST" && url.pathname === "/api/admin/allowed-chats") {
        const payload = await readJson(request);
        assertAdminToken(request, env, payload);
        await saveAllowedChat(env, payload);
        return json(await adminAccessList(env));
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/api/admin/allowed-users/")) {
        assertAdminToken(request, env);
        await setAllowedUserEnabled(env, decodeURIComponent(url.pathname.split("/").pop() || ""), 0);
        return json(await adminAccessList(env));
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/api/admin/allowed-chats/")) {
        assertAdminToken(request, env);
        await setAllowedChatEnabled(env, decodeURIComponent(url.pathname.split("/").pop() || ""), 0);
        return json(await adminAccessList(env));
      }
      if (request.method === "POST" && url.pathname === "/api/external/analyze") {
        const payload = await readJson(request);
        try {
          assertServiceToken(request, env);
        } catch (error) {
          const requestId = stringOrNull(payload?.requestId);
          return json(contractRejectedResponse(requestId, [contractError("auth", error.message || String(error), "authentication_failed")]), 403);
        }
        const result = await runContractAnalysisFromPayload(payload, env, `external ip=${clientIp(request)}`, requestCountry(request), ctx);
        return json(result, contractHttpStatus(result));
      }
      if (request.method === "POST" && ["/scan", "/api/webhook/analyze"].includes(url.pathname)) {
        const payload = await readJson(request);
        assertWebhookToken(request, env, payload);
        const result = await runAnalysisFromPayload(payload, env, `external ip=${clientIp(request)}`, requestCountry(request), ctx);
        return json(result);
      }
      if (request.method === "POST" && url.pathname === "/api/test-telegram") {
        const payload = await readJson(request);
        assertWebhookToken(request, env, payload);
        const normalized = normalizeExternalPayload(payload, env);
        const chatId = String(payload.telegramChatId || payload.chatId || env.TELEGRAM_CHAT_ID || "").trim();
        if (!chatId) throw httpError("telegramChatId is required for test message", 400);
        await sendTelegram(env, chatId, `Stock Signal Scanner test\nEnvironment: ${env.APP_ENV || "dev"}\nTime: ${new Date().toISOString()}`, normalized.bot);
        await addLog(env, `ui ip=${clientIp(request)}`, "Telegram test", "-", "ok", `bot=${normalized.bot.id || "-"}`, requestCountry(request));
        return json({ ok: true, message: "Test Telegram message sent" });
      }
      if (request.method === "POST" && url.pathname === "/api/clear-logs") {
        assertAdminToken(request, env);
        await clearLogs(env);
        return json({ ok: true, logs: [] });
      }
      if (request.method === "POST" && url.pathname === "/telegram/webhook") {
        assertTelegramWebhookSecret(request, env);
        const update = await readJson(request);
        ctx.waitUntil(handleTelegramUpdate(update, env, request));
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      const status = error.status || 400;
      return json({ ok: false, error: error.message || String(error) }, status);
    }
  },
};

async function runAnalysisFromPayload(payload, env, origin, requestCountryLabel = "-", ctx = null) {
  const normalized = normalizeExternalPayload(payload, env);
  const tickers = normalized.tickers.map((ticker) => ticker.symbol);
  if (!tickers.length) throw httpError("ÐŸÐµÑ€ÐµÐ´Ð°Ð¹Ñ‚Ðµ ticker Ð¸Ð»Ð¸ tickers", 400);

  const { timeframe, strategies, risk, anchorBars, chatId, country, bot, news, delivery } = normalized;
  const requestKey = normalized.requestId || news?.id || crypto.randomUUID();
  const newsId = news?.id || (news ? requestKey : null);

  const logCountry = requestCountryLabel && requestCountryLabel !== "-" ? requestCountryLabel : payloadCountryLabel(country);
  await addTickerRequestLog(env, {
    origin,
    source: normalized.source || "external",
    tickers,
    status: "received",
    country: logCountry,
    chatId,
    detail: `timeframe=${timeframe}; request=${requestKey}`,
  });

  const execute = async () => {
    await addLog(env, origin, "External analysis", tickers.join(", "), "started", `timeframe=${timeframe}; request=${requestKey}`, logCountry);
    if (env.DB) await storeMatcherPayload(env, normalized, newsId);
    const result = await runAnalysisOrchestrator(env, {
      source: normalized.source || "external",
      origin,
      requestKey,
      tickers,
      config: { timeframe, strategies, risk, anchorBars },
      request: normalized,
    });
    result.origin = origin;
    result.requestId = requestKey;
    result.country = country;
    result.bot = bot;
    result.news = news;

    if (chatId && delivery.sendToTelegram) {
      if (news) await sendTelegram(env, chatId, newsMessage(normalized), bot);
      await sendTelegram(env, chatId, analysisReportMessage(result), bot);
      result.sent = [{ ticker: "ALL", strategy: "Analysis report", side: "report", destination: "telegram", chatId }];
      result.reply = { type: "telegram", chatId, delivered: true };
    } else {
      result.sent = [];
      result.reply = { type: "http", delivered: true };
    }

    await addLog(
      env,
      origin,
      "External analysis",
      tickers.join(", "),
      result.errors.length ? "partial" : "ok",
      `errors=${result.errors.length}; signals=${countSignals(result.rows)}; task=${result.orchestrator?.taskId || "-"}`,
      logCountry
    );
    return result;
  };

  if (delivery.async && ctx) {
    ctx.waitUntil(execute().catch((error) => addLog(env, origin, "External analysis", tickers.join(", "), "error", error.message || String(error), logCountry)));
    return {
      ok: true,
      requestId: requestKey,
      status: "queued",
      items: tickers.map((ticker) => unifiedQueuedItem(ticker, "technical", requestKey)),
      tickers,
      timeframe,
    };
  }
  return execute();
}

async function runContractAnalysisFromPayload(payload, env, origin, requestCountryLabel = "-", ctx = null) {
  const validation = validateContractPayload(payload);
  const requestId = stringOrNull(payload?.requestId);
  if (validation.errors.length) {
    return contractRejectedResponse(requestId, validation.errors);
  }

  const normalized = normalizeExternalPayload(payload, env);
  const tickers = normalized.tickers.map((ticker) => ticker.symbol);
  const { timeframe, strategies, risk, anchorBars, chatId, country, bot, news, delivery, language } = normalized;
  const logCountry = requestCountryLabel && requestCountryLabel !== "-" ? requestCountryLabel : payloadCountryLabel(country);
  let result;

  try {
    await addTickerRequestLog(env, {
      origin,
      source: normalized.source || "external_contract",
      tickers,
      status: "received",
      country: logCountry,
      chatId,
      detail: `contractVersion=${CONTRACT_VERSION}; timeframe=${timeframe}; request=${requestId}`,
    });
    await addLog(env, origin, "External contract analysis", tickers.join(", "), "started", `request=${requestId}; timeframe=${timeframe}`, logCountry);

    const existing = await getContractResult(env, requestId);
    const accessChecks = await checkContractAccessForTickers(env, normalized, origin, logCountry, existing);
    const rejectedAccess = accessChecks.find((access) => access.allowed === false);
    if (rejectedAccess) {
      result = contractAccessRejectedResponse(normalized, accessChecks);
      await addLog(
        env,
        origin,
        "External contract analysis",
        tickers.join(", "),
        "rejected",
        `request=${requestId}; quotaDecision=${rejectedAccess.quotaDecision || "-"}; reason=${rejectedAccess.reason || "-"}`,
        logCountry
      );
      if (result.status === "rejected") await setContractResult(env, requestId, result);
      return result;
    }

    if (existing) {
      const ownRepeat = accessChecks.every((access) => access.allowed && isOwnRepeatDecision(access));
      if (!ownRepeat) {
        result = contractAccessFailureResponse(normalized, accessChecks, "Core did not confirm an idempotent repeat", "invalid_core_response");
        return result;
      }
      return existing;
    }

    if (accessChecks.some((access) => isOwnRepeatDecision(access))) {
      result = contractAccessFailureResponse(normalized, accessChecks, "Stored Scanner result is missing for Core own_repeat", "stored_result_not_found");
      return result;
    }

    normalized.forceRefresh = normalized.forceRefresh || accessChecks.some((access) => access.forceRefresh === true);
    if (normalized.forceRefresh && accessChecks.some((access) => isCachedReportSource(access.reportSource))) {
      result = contractInvalidAccessDecisionResponse(normalized, accessChecks);
      await setContractResult(env, requestId, result);
      return result;
    }

    const cachedReports = normalized.reportType === "fundrep"
      ? await loadContractCachedFundRepReports(env, normalized, accessChecks)
      : await loadContractCachedTechnicalReports(env, normalized, accessChecks);
    if (cachedReports.missing.length) {
      result = contractCachedReportFailureResponse(normalized, accessChecks, cachedReports.missing);
      await addLog(
        env,
        origin,
        "External contract analysis",
        tickers.join(", "),
        "error",
        `request=${requestId}; cached report missing=${cachedReports.missing.join(",")}`,
        logCountry
      );
      await setContractResult(env, requestId, result);
      return result;
    }

    if (env.DB) await storeMatcherPayload(env, normalized, news?.id || requestId);

    const freshTickers = tickers.filter((ticker) => !cachedReports.results.has(ticker));
    const freshResult = freshTickers.length
      ? normalized.reportType === "fundrep"
        ? await runFundRepAnalysis(env, normalized, freshTickers, origin)
        : await runAnalysisOrchestrator(env, {
        source: normalized.source || "external_contract",
        origin,
        requestKey: requestId,
        tickers: freshTickers,
        config: { timeframe, strategies, risk, anchorBars, language, generationVersion: normalized.generationVersion },
        request: normalized,
        forceRefresh: normalized.forceRefresh,
      })
      : null;
    let savedReports = new Map();
    if (freshResult) {
      savedReports = normalized.reportType === "fundrep"
        ? await cacheContractFundRepReports(env, normalized, freshResult, freshTickers)
        : await cacheContractTechnicalReports(env, normalized, freshResult, freshTickers);
      await commitContractCacheReceipts(env, normalized, accessChecks, savedReports, origin, logCountry);
    }
    const scannerResult = mergeContractScannerResults(normalized, freshResult, cachedReports.results);
    scannerResult.cacheStatus = contractCacheStatus(normalized, freshTickers.length, cachedReports.results.size);
    scannerResult.origin = origin;
    scannerResult.requestId = requestId;
    scannerResult.country = country;
    scannerResult.bot = bot;
    scannerResult.news = news;
    scannerResult.language = language;
    scannerResult.access = accessChecks;

    const telegram = { sendToTelegram: Boolean(chatId && delivery.sendToTelegram), delivered: false, chatId: chatId || null };
    if (telegram.sendToTelegram) {
      if (news) await sendTelegram(env, chatId, newsMessage(normalized), bot);
      if (normalized.reportType === "fundrep") telegram.delivered = (await sendFundRepContractTelegram(env, chatId, scannerResult, bot)) > 0;
      else {
        await sendTelegram(env, chatId, analysisReportMessage(scannerResult), bot);
        telegram.delivered = true;
      }
    }

    result = contractProcessedResponse(normalized, scannerResult, telegram, accessChecks);
    await addLog(
      env,
      origin,
      "External contract analysis",
      tickers.join(", "),
      scannerResult.errors.length ? "partial" : "ok",
      `request=${requestId}; errors=${scannerResult.errors.length}; signals=${countSignals(scannerResult.rows)}`,
      logCountry
    );
  } catch (error) {
    result = contractFailedResponse(requestId, error);
    await addLog(env, origin, "External contract analysis", tickers.join(", "), "error", `request=${requestId}; ${error.message || error}`, logCountry);
  }

  await setContractResult(env, requestId, result);
  return result;
}

async function handleTelegramUpdate(update, env, request) {
  const message = update.message || update.edited_message || {};
  const chat = message.chat || {};
  const chatId = String(chat.id || "");
  const text = String(message.text || "").trim();
  const origin = telegramOrigin(message, request);
  const country = telegramCountry(message, request);
  if (!chatId || !text) return;

  if (!(await isTelegramAllowed(env, message))) {
    await addLog(env, origin, "Telegram access", "-", "denied", "not in allowed_users or allowed_chats", country);
    await sendTelegram(env, chatId, "Доступ закрыт. Напишите администратору, чтобы добавить ваш user id или chat id в allowed list.");
    return;
  }

  const reportCommand = parseTelegramReportCommand(text);
  if (reportCommand) {
    await handleTelegramReportCommand(reportCommand, env, chatId, origin, country, telegramUserId(message));
    return;
  }

  const tickers = parseTelegramText(text);
  if (!tickers.length) {
    await sendTelegram(env, chatId, "Напишите тикер или список тикеров: AAPL или AAPL, MSFT");
    return;
  }

  const requestId = crypto.randomUUID();
  await addTickerRequestLog(env, {
    origin,
    source: "telegram",
    tickers,
    status: "received",
    country,
    chatId,
    userId: telegramUserId(message),
    detail: `requestId=${requestId}; ${chat.title || chat.username || ""}`.trim(),
  });
  await addLog(env, origin, "Telegram analysis", tickers.join(", "), "started", `requestId=${requestId}`, country);
  const result = await runAnalysisOrchestrator(env, {
    source: "telegram",
    origin,
    requestKey: requestId,
    tickers,
    config: {
      timeframe: env.DEFAULT_TIMEFRAME || DEFAULT_TIMEFRAME,
      strategies: normalizeStrategies(env.DEFAULT_STRATEGIES || DEFAULT_STRATEGIES),
      risk: Number(env.DEFAULT_RISK || 1),
      anchorBars: Number(env.DEFAULT_ANCHOR_BARS || 120),
      language: env.DEFAULT_LANGUAGE || "ru",
    },
    request: { chatId, userId: telegramUserId(message), text },
  });
  await sendTelegram(env, chatId, analysisReportMessage(result));
  await addLog(env, origin, "Telegram analysis", tickers.join(", "), result.errors.length ? "partial" : "ok", `requestId=${requestId}; errors=${result.errors.length}`, country);
}

async function handleTelegramReportCommand(command, env, chatId, origin, country = "-", userId = "") {
  if (!command.tickers.length) {
    await sendTelegram(env, chatId, `Напишите команду с тикером, например: ${command.label} AAPL`);
    return;
  }

  const requestId = crypto.randomUUID();
  await addLog(env, origin, command.label, command.tickers.join(", "), "started", `requestId=${requestId}`, country);
  await addTickerRequestLog(env, {
    origin,
    source: `telegram/${command.label}`,
    tickers: command.tickers,
    status: "received",
    country,
    chatId,
    userId,
    detail: `requestId=${requestId}; ${command.label}`,
  });
  for (const ticker of command.tickers) {
    if (!isValidTicker(ticker)) {
      await sendTelegram(env, chatId, `${ticker}: ${tickerValidationError(ticker)}`);
      await addLog(env, origin, command.label, ticker, "error", `requestId=${requestId}; ${tickerValidationError(ticker)}`, country);
      continue;
    }

    const result = await runAnalysisOrchestrator(env, {
      source: `telegram/${command.label}`,
      origin,
      requestKey: `${requestId}-${ticker}`,
      tickers: [ticker],
      config: {
        timeframe: env.DEFAULT_TIMEFRAME || DEFAULT_TIMEFRAME,
        strategies: normalizeStrategies(env.DEFAULT_STRATEGIES || DEFAULT_STRATEGIES),
        risk: Number(env.DEFAULT_RISK || 1),
        anchorBars: Number(env.DEFAULT_ANCHOR_BARS || 120),
        language: env.DEFAULT_LANGUAGE || "ru",
      },
      request: { chatId, userId, command: command.label },
    });
    if (command.type === "fundrep") {
      const fundamentals = await fetchFundamentalData(ticker);
      const fundItem = unifiedResultItem({
        ticker,
        row: result.rows[0] || null,
        errors: result.errors || [],
        analysisType: "fundamental",
        requestId: result.requestId,
        fundamentals,
        language: result.config?.language,
      });
      await sendTelegram(env, chatId, fundamentalSummaryMessage(fundItem, result.config?.language));
      const html = fundRepHtml(ticker, result, fundamentals, result.config?.language);
      await sendTelegramDocument(env, chatId, `fundrep_${ticker}_${compactTimestamp(result.timestamp)}.html`, html, reportText(result.config?.language, "fundTitle", { ticker }));
    } else {
      await sendTelegram(env, chatId, promtRepMessage(ticker, result, result.config?.language));
    }
    await addLog(env, origin, command.label, ticker, result.errors.length ? "partial" : "ok", `requestId=${requestId}; taskRequestId=${result.requestId}; errors=${result.errors.length}`, country);
  }
}

async function runAnalysisOrchestrator(env, job) {
  const startedAt = Date.now();
  const config = normalizeAnalysisConfig(job.config || {});
  const tickers = [...new Set((job.tickers || []).map((ticker) => String(ticker).trim().toUpperCase()).filter(Boolean))];
  const fingerprint = await analysisFingerprint({ tickers: [...tickers].sort(), config });
  const requestKey = job.requestKey || crypto.randomUUID();
  const taskId = `task_${requestKey}`;
  const source = job.source || "unknown";
  const origin = job.origin || "-";
  const forceRefresh = job.forceRefresh === true;

  await ensureOrchestratorTables(env);
  const cached = forceRefresh ? null : await getAnalysisCache(env, `result:${fingerprint}`);
  if (cached) {
    const result = {
      ...cached,
      orchestrator: {
        taskId,
        fingerprint,
        status: "cache_hit",
        cacheHit: true,
        responseMs: Date.now() - startedAt,
      },
    };
    await recordAnalysisTask(env, {
      id: taskId,
      fingerprint,
      source,
      origin,
      status: "cache_hit",
      tickers,
      config,
      request: job.request || {},
      result,
      responseMs: result.orchestrator.responseMs,
      cacheHit: 1,
    });
    return result;
  }

  await recordAnalysisTask(env, {
    id: taskId,
    fingerprint,
    source,
    origin,
    status: "queued",
    tickers,
    config,
    request: job.request || {},
  });

  try {
    await markAnalysisTask(env, taskId, "running", { attempts: 1, startedAt: new Date().toISOString() });
    const result = await runWithRetries(async () => analyzeTickers(tickers, config, env, { forceRefresh }), ORCHESTRATOR_RETRY_LIMIT);
    result.requestId = requestKey;
    result.analysisType = "technical";
    result.config = config;
    result.items = buildUnifiedItems({ tickers, result, analysisType: "technical", requestId: requestKey });
    result.orchestrator = {
      taskId,
      fingerprint,
      status: "completed",
      cacheHit: false,
      responseMs: Date.now() - startedAt,
      signalCount: countSignals(result.rows),
      qualityScore: signalQualityScore(result),
    };
    await setAnalysisCache(env, `result:${fingerprint}`, "analysis_result", result, RESULT_CACHE_TTL_SECONDS);
    await recordAnalysisTask(env, {
      id: taskId,
      fingerprint,
      source,
      origin,
      status: "completed",
      tickers,
      config,
      request: job.request || {},
      result,
      responseMs: result.orchestrator.responseMs,
      cacheHit: 0,
    });
    return result;
  } catch (error) {
    const responseMs = Date.now() - startedAt;
    await markAnalysisTask(env, taskId, "failed", {
      error: error.message || String(error),
      responseMs,
      completedAt: new Date().toISOString(),
    });
    throw error;
  }
}

async function analyzeTickers(tickers, config, env = {}, options = {}) {
  const rows = [];
  const errors = [];
  for (const ticker of tickers) {
    if (!isValidTicker(ticker)) {
      errors.push({ ticker, error: tickerValidationError(ticker), code: "INVALID_TICKER" });
      continue;
    }
    try {
      const candles = await runWithRetries(() => fetchCandles(ticker, config.timeframe, env, options), ORCHESTRATOR_RETRY_LIMIT);
      const row = analyzeTicker(ticker, candles, config);
      row.signals = row.signals.map((signal) => ({ ...signal, message: telegramSignalMessage(signal, config.language) }));
      rows.push(row);
    } catch (error) {
      errors.push({ ticker, error: error.message || String(error), code: error.code || "ANALYSIS_ERROR" });
    }
  }
  return {
    timestamp: new Date().toISOString(),
    timeframe: config.timeframe,
    analysisType: "technical",
    rows,
    errors,
  };
}

async function runFundRepAnalysis(env, normalized, tickers, origin) {
  const technical = await runAnalysisOrchestrator(env, {
    source: `${normalized.source || "external_contract"}/fundrep`,
    origin,
    requestKey: `${normalized.requestId}:fundrep`,
    tickers,
    config: {
      timeframe: normalized.timeframe,
      strategies: normalized.strategies,
      risk: normalized.risk,
      anchorBars: normalized.anchorBars,
      language: normalized.language,
      generationVersion: normalized.generationVersion,
    },
    request: normalized,
    forceRefresh: normalized.forceRefresh,
  });
  const fundamentalsByTicker = {};
  const errors = [];

  await Promise.all(tickers.map(async (ticker) => {
    try {
      const fundamentals = await fetchFundamentalData(ticker);
      const row = (technical.rows || []).find((item) => item.ticker === ticker) || null;
      const summary = buildFundamentalSummary(ticker, row, fundamentals, normalized.language);
      if (!hasFundamentalSummary(summary)) {
        throw analysisError(`${ticker}: empty fundamental report`, "DATA_PROVIDER_ERROR");
      }
      fundamentalsByTicker[ticker] = fundamentals;
    } catch (error) {
      errors.push({
        ticker,
        error: error.message || String(error),
        code: error.code || "DATA_PROVIDER_ERROR",
      });
    }
  }));

  const result = {
    timestamp: new Date().toISOString(),
    timeframe: normalized.timeframe,
    analysisType: "fundamental",
    rows: technical.rows || [],
    errors,
    config: technical.config || normalizeAnalysisConfig(normalized),
    fundamentalsByTicker,
    orchestrator: {
      ...(technical.orchestrator || {}),
      status: "fundrep_completed",
      reportType: "fundrep",
    },
  };
  result.items = buildUnifiedItems({
    tickers,
    result,
    analysisType: "fundamental",
    requestId: normalized.requestId,
    fundamentalsByTicker,
  });
  return result;
}

function hasFundamentalSummary(summary) {
  const sections = [summary?.valuation, summary?.growth, summary?.profitability, summary?.debt];
  return sections.some((section) => Object.values(section || {}).some((value) => value != null));
}

async function fetchCandles(ticker, timeframe, env = {}, options = {}) {
  const tf = TIMEFRAMES[timeframe] || TIMEFRAMES["1d"];
  const cacheKey = `market:${ticker}:${tf.interval}:${tf.range}`;
  const cachedCandles = options.forceRefresh ? null : await getAnalysisCache(env, cacheKey);
  if (cachedCandles) return cachedCandles;
  let data = null;
  let lastError = "";
  let providerError = "";
  for (const symbol of yahooTickerCandidates(ticker)) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${tf.interval}&range=${tf.range}`;
    let response;
    try {
      response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    } catch (error) {
      providerError = `${symbol}: Yahoo chart network error ${error.message || error}`;
      continue;
    }
    if (!response.ok) {
      lastError = `${symbol}: Yahoo chart HTTP ${response.status}`;
      if (response.status === 429 || response.status >= 500) providerError = lastError;
      continue;
    }
    data = await response.json();
    if (data?.chart?.result?.[0]) break;
    lastError = `${symbol}: ${data?.chart?.error?.description || "нет рыночных данных"}`;
    data = null;
  }
  const result = data?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result || !quote || !Array.isArray(result.timestamp)) {
    if (providerError) throw analysisError(providerError, "DATA_PROVIDER_ERROR");
    throw analysisError(lastError || "Нет рыночных данных", "NO_MARKET_DATA");
  }

  const candles = [];
  for (let i = 0; i < result.timestamp.length; i += 1) {
    const close = quote.close?.[i];
    if (close == null) continue;
    candles.push({
      timestamp: result.timestamp[i],
      open: Number(quote.open?.[i] ?? close),
      high: Number(quote.high?.[i] ?? close),
      low: Number(quote.low?.[i] ?? close),
      close: Number(close),
      volume: Number(quote.volume?.[i] ?? 0),
    });
  }
  if (candles.length < 60) throw analysisError("Недостаточно свечей для анализа", "INSUFFICIENT_DATA");
  await setAnalysisCache(env, cacheKey, "market_candles", candles, MARKET_CACHE_TTL_SECONDS);
  return candles;
}

function yahooTickerCandidates(ticker) {
  const normalized = String(ticker || "").trim().toUpperCase();
  if (!normalized || normalized.includes(".")) return [normalized];
  return [normalized, `${normalized}.TA`];
}

function analyzeTicker(ticker, candles, config) {
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2] || latest;
  const closes = candles.map((candle) => candle.close);
  const price = latest.close;
  const ema200 = ema(closes, 200);
  const mma150 = movingAverage(closes, 150);
  const avwap = anchoredVwap(candles, config.anchorBars);
  const poc = volumePoc(candles.slice(-Math.min(candles.length, 120)));
  const rsi = rsi14(closes);
  const roc20 = closes.length > 20 ? ((price / closes[closes.length - 21]) - 1) * 100 : 0;
  const high20 = Math.max(...candles.slice(-21, -1).map((candle) => candle.high));
  const low20 = Math.min(...candles.slice(-21, -1).map((candle) => candle.low));
  const atr = averageTrueRange(candles, 14);
  const signals = [];
  const language = config.language;

  if (config.strategies.includes("trend") && ema200 && price > ema200 && price > avwap) {
    signals.push(makeSignal(ticker, "Trend Following", "long", price, reportText(language, "trendLongCondition"), reportText(language, "trendLongIdea"), price - atr * 2, price + atr * 3, config.risk));
  }
  if (config.strategies.includes("trend") && ema200 && price < ema200 && price < avwap) {
    signals.push(makeSignal(ticker, "Trend Following", "short", price, reportText(language, "trendShortCondition"), reportText(language, "trendShortIdea"), price + atr * 2, price - atr * 3, config.risk));
  }
  if (config.strategies.includes("breakout") && price > high20) {
    signals.push(makeSignal(ticker, "Breakout Trading", "long", price, reportText(language, "breakoutLongCondition"), reportText(language, "breakoutLongIdea"), price - atr * 1.8, price + atr * 3.2, config.risk));
  }
  if (config.strategies.includes("breakout") && price < low20) {
    signals.push(makeSignal(ticker, "Breakout Trading", "short", price, reportText(language, "breakoutShortCondition"), reportText(language, "breakoutShortIdea"), price + atr * 1.8, price - atr * 3.2, config.risk));
  }
  if (config.strategies.includes("volume_avwap") && price > avwap && price > poc) {
    signals.push(makeSignal(ticker, "Volume Profile + AVWAP", "long", price, reportText(language, "volumeLongCondition"), reportText(language, "volumeLongIdea"), Math.min(avwap, poc), price + atr * 2.5, config.risk));
  }
  if (config.strategies.includes("volume_avwap") && price < avwap && price < poc) {
    signals.push(makeSignal(ticker, "Volume Profile + AVWAP", "short", price, reportText(language, "volumeShortCondition"), reportText(language, "volumeShortIdea"), Math.max(avwap, poc), price - atr * 2.5, config.risk));
  }
  if (config.strategies.includes("momentum") && roc20 > 5 && rsi > 55) {
    signals.push(makeSignal(ticker, "Momentum Trading", "long", price, reportText(language, "momentumCondition", { roc: roc20.toFixed(1), rsi: rsi.toFixed(0) }), reportText(language, "momentumLongIdea"), price - atr * 2, price + atr * 3, config.risk));
  }
  if (config.strategies.includes("momentum") && roc20 < -5 && rsi < 45) {
    signals.push(makeSignal(ticker, "Momentum Trading", "short", price, reportText(language, "momentumCondition", { roc: roc20.toFixed(1), rsi: rsi.toFixed(0) }), reportText(language, "momentumShortIdea"), price + atr * 2, price - atr * 3, config.risk));
  }

  return {
    ticker,
    price: round(price, 2),
    previous_close: round(previous.close, 2),
    change: round(price - previous.close, 2),
    change_percent: previous.close ? round(((price / previous.close) - 1) * 100, 2) : 0,
    direction: price > previous.close ? "up" : price < previous.close ? "down" : "flat",
    ema200: ema200 ? round(ema200, 2) : null,
    mma150: mma150 ? round(mma150, 2) : null,
    mma150_distance_percent: mma150 ? round(((price / mma150) - 1) * 100, 2) : null,
    avwap: round(avwap, 2),
    atr14: round(atr, 2),
    poc: round(poc, 2),
    rsi14: round(rsi, 1),
    roc20: round(roc20, 2),
    volume: latest.volume,
    signals,
  };
}

function makeSignal(ticker, strategy, side, price, condition, idea, stop, target, risk) {
  return {
    ticker,
    strategy,
    side,
    price,
    condition,
    idea,
    stop,
    target,
    risk,
  };
}

function buildUnifiedItems({ tickers, result, analysisType, requestId, fundamentalsByTicker = {} }) {
  const language = normalizeReportLanguage(result.language || result.config?.language);
  const rowsByTicker = new Map((result.rows || []).map((row) => [row.ticker, row]));
  const errorsByTicker = new Map();
  for (const error of result.errors || []) {
    if (!errorsByTicker.has(error.ticker)) errorsByTicker.set(error.ticker, []);
    errorsByTicker.get(error.ticker).push(error);
  }
  return tickers.map((ticker) => {
    const row = rowsByTicker.get(ticker);
    const errors = errorsByTicker.get(ticker) || [];
    const fundamentals = fundamentalsByTicker[ticker] || null;
    return unifiedResultItem({ ticker, row, errors, analysisType, requestId, fundamentals, language });
  });
}

function unifiedResultItem({ ticker, row = null, errors = [], analysisType = "technical", requestId, fundamentals = null, language = "ru" }) {
  return {
    ticker,
    status: resultStatus(row, errors, analysisType, fundamentals),
    analysisType,
    price: row ? {
      value: row.price,
      previousClose: row.previous_close,
      change: row.change,
      changePercent: row.change_percent,
      direction: row.direction,
    } : null,
    indicators: row ? {
      ema200: row.ema200,
      mma150: row.mma150,
      mma150DistancePercent: row.mma150_distance_percent,
      avwap: row.avwap,
      atr14: row.atr14,
      poc: row.poc,
      rsi14: row.rsi14,
      roc20: row.roc20,
      volume: row.volume,
    } : {},
    signals: row ? row.signals.map((signal) => ({
      strategy: signal.strategy,
      side: signal.side,
      condition: signal.condition,
      idea: signal.idea,
      risk: signal.risk,
      stop: round(signal.stop, 2),
      target: round(signal.target, 2),
      explanation: `${signal.condition}. ${marketContext(row, language)}`,
    })) : [],
    fundamentalSummary: fundamentals ? buildFundamentalSummary(ticker, row, fundamentals, language) : null,
    dataSources: dataSourcesForItem(analysisType, fundamentals, row),
    errors: errors.map((error) => ({
      code: statusFromErrorCode(error.code),
      message: localizedStatus(statusFromErrorCode(error.code), language),
    })),
    requestId,
  };
}

function unifiedQueuedItem(ticker, analysisType, requestId) {
  return {
    ticker,
    status: "queued",
    analysisType,
    price: null,
    indicators: {},
    signals: [],
    fundamentalSummary: null,
    dataSources: [],
    errors: [],
    requestId,
  };
}

function resultStatus(row, errors = [], analysisType = "technical", fundamentals = null) {
  if (analysisType === "fundamental" && fundamentals && errors.length) return "partial_result";
  if (analysisType === "fundamental" && fundamentals) return fundamentals.fundrepDataStatus === "partial" ? "partial_result" : "no_signal";
  if (row && errors.length) return "partial_result";
  if (errors.some((error) => error.code === "INVALID_TICKER")) return "invalid_ticker";
  if (errors.some((error) => error.code === "INSUFFICIENT_DATA" || error.code === "NO_MARKET_DATA")) return "not_enough_data";
  if (errors.length) return "data_provider_error";
  if (row?.signals?.length) return "signal_found";
  if (row) return "no_signal";
  return "data_provider_error";
}

function statusFromErrorCode(code) {
  if (code === "INVALID_TICKER") return "invalid_ticker";
  if (code === "INSUFFICIENT_DATA" || code === "NO_MARKET_DATA") return "not_enough_data";
  if (code === "DATA_PROVIDER_ERROR") return "data_provider_error";
  return "data_provider_error";
}

function dataSourcesForItem(analysisType, fundamentals = null, row = null) {
  if (analysisType !== "fundamental") return ["Yahoo Finance chart"];
  const technicalSource = row ? ["Yahoo Finance chart"] : [];
  if (fundamentals?.fundrepDataStatus === "full") return ["Yahoo Finance quoteSummary", ...technicalSource];
  if (fundamentals?.fundrepDataStatus === "partial") return ["Yahoo Finance quote", ...technicalSource];
  return [];
}

function buildFundamentalSummary(ticker, row, data = {}, language = "ru") {
  return {
    valuation: {
      trailingPE: numberOrNull(metricValue(data, "summaryDetail", "trailingPE")),
      forwardPE: numberOrNull(metricValue(data, "summaryDetail", "forwardPE")),
      priceToSales: numberOrNull(metricValue(data, "summaryDetail", "priceToSalesTrailing12Months")),
      priceToBook: numberOrNull(metricValue(data, "defaultKeyStatistics", "priceToBook")),
      marketCap: numberOrNull(metricValue(data, "price", "marketCap")),
    },
    growth: {
      revenueGrowth: numberOrNull(metricValue(data, "financialData", "revenueGrowth")),
      earningsGrowth: numberOrNull(metricValue(data, "financialData", "earningsGrowth")),
    },
    profitability: {
      grossMargins: numberOrNull(metricValue(data, "financialData", "grossMargins")),
      operatingMargins: numberOrNull(metricValue(data, "financialData", "operatingMargins")),
      profitMargins: numberOrNull(metricValue(data, "financialData", "profitMargins")),
      returnOnEquity: numberOrNull(metricValue(data, "financialData", "returnOnEquity")),
      returnOnAssets: numberOrNull(metricValue(data, "financialData", "returnOnAssets")),
    },
    debt: {
      totalDebt: numberOrNull(metricValue(data, "financialData", "totalDebt")),
      totalCash: numberOrNull(metricValue(data, "financialData", "totalCash")),
      debtToEquity: numberOrNull(metricValue(data, "financialData", "debtToEquity")),
      currentRatio: numberOrNull(metricValue(data, "financialData", "currentRatio")),
    },
    momentum: row ? {
      price: row.price,
      changePercent: row.change_percent,
      rsi14: row.rsi14,
      roc20: row.roc20,
      aboveEma200: row.ema200 == null ? null : row.price > row.ema200,
    } : null,
    keyRisks: fundamentalKeyRisks(row, data, language),
    status: fundamentalDataStatus(data.fundrepDataStatus, language),
  };
}

function fundamentalKeyRisks(row, data = {}, language = "ru") {
  const risks = [];
  const debtToEquity = numberOrNull(metricValue(data, "financialData", "debtToEquity"));
  const currentRatio = numberOrNull(metricValue(data, "financialData", "currentRatio"));
  const trailingPE = numberOrNull(metricValue(data, "summaryDetail", "trailingPE"));
  const revenueGrowth = numberOrNull(metricValue(data, "financialData", "revenueGrowth"));
  if (debtToEquity != null && debtToEquity > 150) risks.push(reportText(language, "riskDebt"));
  if (currentRatio != null && currentRatio < 1) risks.push(reportText(language, "riskLiquidity"));
  if (trailingPE != null && trailingPE > 40) risks.push(reportText(language, "riskValuation"));
  if (revenueGrowth != null && revenueGrowth < 0) risks.push(reportText(language, "riskRevenue"));
  if (row && row.rsi14 > 70) risks.push(reportText(language, "riskOverbought"));
  if (row && row.rsi14 < 30) risks.push(reportText(language, "riskWeak"));
  return risks.length ? risks : [reportText(language, "riskDefault")];
}

function fundamentalDataStatus(status, language = "ru") {
  if (status === "full") return reportText(language, "dataFull");
  if (status === "partial") return reportText(language, "dataPartial");
  return reportText(language, "dataUnavailable");
}

function fundamentalSummaryMessage(item, language = "ru") {
  const summary = item.fundamentalSummary || {};
  const v = summary.valuation || {};
  const g = summary.growth || {};
  const p = summary.profitability || {};
  const d = summary.debt || {};
  const m = summary.momentum || {};
  return [
    `${reportText(language, "fundSummary")}: ${item.ticker}`,
    "━━━━━━━━━━━━━━",
    `${reportText(language, "valuation")}: P/E ${fmtMetric(v.trailingPE)}, Forward P/E ${fmtMetric(v.forwardPE)}, P/S ${fmtMetric(v.priceToSales)}, P/B ${fmtMetric(v.priceToBook)}, ${reportText(language, "marketCap")} ${fmtMoney(v.marketCap)}`,
    `${reportText(language, "growth")}: ${reportText(language, "revenue")} ${fmtPercent(g.revenueGrowth)}, ${reportText(language, "earnings")} ${fmtPercent(g.earningsGrowth)}`,
    `${reportText(language, "profitability")}: ${reportText(language, "gross")} ${fmtPercent(p.grossMargins)}, ${reportText(language, "operating")} ${fmtPercent(p.operatingMargins)}, ${reportText(language, "net")} ${fmtPercent(p.profitMargins)}, ROE ${fmtPercent(p.returnOnEquity)}`,
    `${reportText(language, "debt")}: ${reportText(language, "debt")} ${fmtMoney(d.totalDebt)}, ${reportText(language, "cash")} ${fmtMoney(d.totalCash)}, D/E ${fmtMetric(d.debtToEquity)}, ${reportText(language, "currentRatio")} ${fmtMetric(d.currentRatio)}`,
    `${reportText(language, "momentum")}: ${reportText(language, "price")} ${fmtMetric(m.price)}, ${reportText(language, "change")} ${fmtPercent(m.changePercent)}, RSI ${fmtMetric(m.rsi14)}, ROC20 ${fmtPercent(m.roc20)}`,
    `${reportText(language, "keyRisks")}: ${(summary.keyRisks || []).join(" ")}`,
  ].join("\n");
}

async function sendFundRepContractTelegram(env, chatId, result, bot = {}) {
  const language = result.language || result.config?.language || "ru";
  for (const item of result.items || []) {
    if (!item.fundamentalSummary || item.errors?.length) continue;
    await sendTelegram(env, chatId, fundamentalSummaryMessage(item, language), bot);
    const row = (result.rows || []).find((candidate) => candidate.ticker === item.ticker);
    const fundamentals = result.fundamentalsByTicker?.[item.ticker];
    if (!row || !fundamentals) continue;
    const tickerResult = { ...result, rows: [row], errors: [] };
    const html = fundRepHtml(item.ticker, tickerResult, fundamentals, language);
    await sendTelegramDocument(
      env,
      chatId,
      `fundrep_${item.ticker}_${compactTimestamp(result.timestamp)}.html`,
      html,
      reportText(language, "fundTitle", { ticker: item.ticker }),
      bot
    );
  }
}

function analysisReportMessage(result) {
  const language = normalizeReportLanguage(result.language || result.config?.language);
  const lines = [
    `📊 ${reportText(language, "analysisTitle")}`,
    "━━━━━━━━━━━━━━",
    "",
  ];

  for (const item of result.items || buildUnifiedItems({ tickers: [...(result.rows || []).map((row) => row.ticker), ...(result.errors || []).map((error) => error.ticker)], result, analysisType: result.analysisType || "technical", requestId: result.requestId })) {
    const price = item.price || {};
    const indicators = item.indicators || {};
    const arrow = price.direction === "up" ? "🟢⬆️" : price.direction === "down" ? "🔴⬇️" : "⚪➡️";
    const movement = price.value == null ? "-" : `${price.change > 0 ? "+" : ""}${Number(price.change || 0).toFixed(2)} (${price.changePercent > 0 ? "+" : ""}${Number(price.changePercent || 0).toFixed(2)}%)`;
    lines.push(`${arrow} ${item.ticker}`);
    lines.push(`${reportText(language, "status")}: ${localizedStatus(item.status, language)}`);
    if (price.value != null) lines.push(`${reportText(language, "price")}: ${Number(price.value).toFixed(2)}`);
    lines.push(`${reportText(language, "movement")}: ${movement}`);
    lines.push(`EMA200: ${valueOrDash(indicators.ema200)}, AVWAP: ${valueOrDash(indicators.avwap)}, RSI: ${valueOrDash(indicators.rsi14)}`);
    lines.push(`ATR14: ${valueOrDash(indicators.atr14)}, MMA150: ${valueOrDash(indicators.mma150)}, ${reportText(language, "distanceFromMma")}: ${distanceText(indicators.mma150DistancePercent)}`);
    if (item.signals.length) {
      lines.push("");
      lines.push(`✅ ${reportText(language, "signals")}:`);
      item.signals.forEach((signal, index) => {
        if (index > 0) lines.push("━━━━━━━━━━━━━━");
        const icon = signal.side === "long" ? "📈" : "📉";
        lines.push(`${icon} ${localizedSide(signal.side, language)} / ${localizedStrategy(signal.strategy, language)}`);
        lines.push(`${reportText(language, "why")}: ${signal.explanation}`);
        lines.push(`${reportText(language, "condition")}: ${signal.condition}`);
        lines.push(`${reportText(language, "idea")}: ${signal.idea}`);
        lines.push(`${reportText(language, "stop")}: ${Number(signal.stop).toFixed(2)}`);
        lines.push(`${reportText(language, "target")}: ${Number(signal.target).toFixed(2)}`);
        lines.push(`${reportText(language, "risk")}: ${signal.risk}%`);
      });
    } else if (item.status === "no_signal") {
      lines.push("");
      lines.push(`ℹ️ ${reportText(language, "noSignal")}:`);
      lines.push(reportText(language, "noSignalDetails"));
    } else if (item.errors.length) {
      lines.push("");
      lines.push(item.status === "not_enough_data" ? `ℹ️ ${reportText(language, "noData")}:` : `⚠️ ${reportText(language, "error")}:`);
      for (const error of item.errors) lines.push(error.code);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function fetchFundamentalData(ticker) {
  const safeTicker = encodeURIComponent(ticker);
  const modules = "price,summaryDetail,defaultKeyStatistics,financialData,assetProfile";
  try {
    const data = await fetchJsonProviderWithRetry(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${safeTicker}?modules=${modules}`,
      "quoteSummary"
    );
    const result = data?.quoteSummary?.result?.[0];
    if (result) {
      return {
        ...result,
        fundrepDataStatus: "full",
      };
    }
    throw new Error("quoteSummary empty");
  } catch (error) {
    try {
      const data = await fetchJsonProviderWithRetry(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${safeTicker}`,
        "quote"
      );
      const quote = data?.quoteResponse?.result?.[0];
      if (!quote || typeof quote !== "object") {
        throw analysisError(`${ticker}: quote data is empty`, "NO_MARKET_DATA");
      }
      return {
        fundrepDataStatus: "partial",
        price: {
          shortName: quote.shortName || quote.longName || ticker,
          regularMarketPrice: quote.regularMarketPrice,
          currency: quote.currency,
          marketCap: quote.marketCap,
        },
        assetProfile: {
          sector: quote.sector,
          industry: quote.industry,
        },
        financialData: {
          revenueGrowth: quote.revenueGrowth,
          earningsGrowth: quote.earningsGrowth,
          targetMeanPrice: quote.targetMeanPrice,
        },
        summaryDetail: {
          trailingPE: quote.trailingPE,
          forwardPE: quote.forwardPE,
          priceToSalesTrailing12Months: quote.priceToSalesTrailing12Months,
          beta: quote.beta,
          dividendYield: quote.dividendYield,
        },
        defaultKeyStatistics: {
          trailingEps: quote.epsTrailingTwelveMonths,
          priceToBook: quote.priceToBook,
        },
      };
    } catch (fallbackError) {
      const providerFailure = error.code === "DATA_PROVIDER_ERROR" || fallbackError.code === "DATA_PROVIDER_ERROR";
      throw analysisError(
        `${ticker}: fundamental providers failed (${error.message || error}; ${fallbackError.message || fallbackError})`,
        providerFailure ? "DATA_PROVIDER_ERROR" : "NO_MARKET_DATA"
      );
    }
  }
}

function fundRepHtml(ticker, result, fundamentals = {}, language = "ru") {
  const locale = normalizeReportLanguage(language);
  const row = result.rows[0];
  if (!row) {
    return `<!doctype html><meta charset="utf-8"><title>FundRep ${escapeHtml(ticker)}</title><body><pre>${escapeHtml(reportErrorMessage("FundRep", ticker, result, locale))}</pre></body>`;
  }

  const sections = localizeFundRepSections(fundRepSections(ticker, row, fundamentals), locale);
  const sectionHtml = sections.map((section) => `
    <section>
      <h2>${escapeHtml(section.title)}</h2>
      <p class="question">${escapeHtml(section.question)}</p>
      <table>
        <thead><tr><th>${escapeHtml(reportText(locale, "metric"))}</th><th>${escapeHtml(reportText(locale, "value"))}</th><th>${escapeHtml(reportText(locale, "explanation"))}</th></tr></thead>
        <tbody>
          ${section.metrics.map((metric) => `<tr><td>${escapeHtml(metric[0])}</td><td>${escapeHtml(metric[1])}</td><td>${escapeHtml(metric[2])}</td></tr>`).join("")}
        </tbody>
      </table>
    </section>
  `).join("");

  return `<!doctype html>
<html lang="${locale}" dir="${locale === "he" ? "rtl" : "ltr"}">
<head>
  <meta charset="utf-8">
  <title>FundRep ${escapeHtml(ticker)}</title>
  <style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #111827;
      font-family: Arial, "Segoe UI", sans-serif;
      font-size: 11.5px;
      line-height: 1.45;
      background: #fff;
    }
    h1 {
      margin: 0 0 8px;
      padding-bottom: 10px;
      border-bottom: 3px solid #2563eb;
      font-size: 25px;
      line-height: 1.15;
    }
    .meta {
      margin: 0 0 16px;
      color: #4b5563;
      font-size: 10.5px;
    }
    h2 {
      margin: 18px 0 5px;
      color: #1d4ed8;
      font-size: 16px;
      break-after: avoid;
    }
    .question {
      margin: 0 0 8px;
      color: #374151;
      font-weight: 700;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 0 0 10px;
      break-inside: avoid;
    }
    th, td {
      border: 1px solid #d1d5db;
      padding: 6px 7px;
      vertical-align: top;
    }
    th {
      background: #eff6ff;
      color: #1d4ed8;
      text-align: left;
      font-size: 10.5px;
    }
    td:first-child { width: 30%; font-weight: 700; }
    td:nth-child(2) { width: 18%; white-space: nowrap; }
    .note {
      margin-top: 14px;
      padding: 10px 12px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #f9fafb;
      color: #374151;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <h1>FundRep: ${escapeHtml(reportText(locale, "fundTitle", { ticker }))}</h1>
  <p class="meta">${escapeHtml(reportText(locale, "reportDate"))}: ${escapeHtml(result.timestamp)} · ${escapeHtml(fundamentalDataStatus(fundamentals.fundrepDataStatus, locale))} · ${escapeHtml(reportText(locale, "disclaimer"))}</p>
  ${sectionHtml}
  <div class="note">${escapeHtml(reportText(locale, "quickGuide"))}</div>
</body>
</html>`;
}

function fundRepSections(ticker, row, data = {}) {
  const na = "-";
  const priceValue = metricValue(data, "price", "regularMarketPrice") ?? row.price;
  const currency = fmtMetric(metricValue(data, "price", "currency") || "USD");
  const price = `${fmtMetric(priceValue)} ${currency}`;
  const movement = `${row.change > 0 ? "+" : ""}${row.change.toFixed(2)} (${row.change_percent > 0 ? "+" : ""}${row.change_percent.toFixed(2)}%)`;
  const marketCap = metricValue(data, "price", "marketCap");
  const totalRevenue = metricValue(data, "financialData", "totalRevenue");
  const freeCashflow = metricValue(data, "financialData", "freeCashflow");
  const fcfMargin = numberOrNull(freeCashflow) != null && numberOrNull(totalRevenue) ? numberOrNull(freeCashflow) / numberOrNull(totalRevenue) : null;
  const fcfYield = numberOrNull(freeCashflow) != null && numberOrNull(marketCap) ? numberOrNull(freeCashflow) / numberOrNull(marketCap) : null;
  return [
    {
      title: "profitability",
      question: "profitability",
      metrics: [
        ["Company", fmtMetric(metricValue(data, "price", "shortName") || ticker)],
        ["Current price", price],
        ["Revenue Growth", fmtPercent(metricValue(data, "financialData", "revenueGrowth"))],
        ["Gross Margin", fmtPercent(metricValue(data, "financialData", "grossMargins"))],
        ["Operating Margin", fmtPercent(metricValue(data, "financialData", "operatingMargins"))],
        ["Net Margin", fmtPercent(metricValue(data, "financialData", "profitMargins"))],
        ["EPS", fmtMetric(metricValue(data, "defaultKeyStatistics", "trailingEps"))],
        ["EBITDA", fmtMoney(metricValue(data, "financialData", "ebitda"))],
      ],
    },
    {
      title: "valuation",
      question: "valuation",
      metrics: [
        ["Market Cap", fmtMoney(marketCap)],
        ["P/E", fmtMetric(metricValue(data, "summaryDetail", "trailingPE"))],
        ["Forward P/E", fmtMetric(metricValue(data, "summaryDetail", "forwardPE"))],
        ["CAPE", na],
        ["P/S", fmtMetric(metricValue(data, "summaryDetail", "priceToSalesTrailing12Months"))],
        ["EV / EBITDA", fmtMetric(metricValue(data, "defaultKeyStatistics", "enterpriseToEbitda"))],
        ["PEG Ratio", fmtMetric(metricValue(data, "defaultKeyStatistics", "pegRatio"))],
        ["P/B", fmtMetric(metricValue(data, "defaultKeyStatistics", "priceToBook"))],
      ],
    },
    {
      title: "cash_flow",
      question: "cash_flow",
      metrics: [
        ["Operating Cash Flow", fmtMoney(metricValue(data, "financialData", "operatingCashflow"))],
        ["Free Cash Flow", fmtMoney(freeCashflow)],
        ["FCF Margin", fmtPercent(fcfMargin)],
        ["FCF Yield", fmtPercent(fcfYield)],
      ],
    },
    {
      title: "financial_health",
      question: "financial_health",
      metrics: [
        ["Debt-to-Equity", fmtMetric(metricValue(data, "financialData", "debtToEquity"))],
        ["Total Cash", fmtMoney(metricValue(data, "financialData", "totalCash"))],
        ["Total Debt", fmtMoney(metricValue(data, "financialData", "totalDebt"))],
        ["Current Ratio", fmtMetric(metricValue(data, "financialData", "currentRatio"))],
        ["ROE", fmtPercent(metricValue(data, "financialData", "returnOnEquity"))],
        ["ROA", fmtPercent(metricValue(data, "financialData", "returnOnAssets"))],
      ],
    },
    {
      title: "forward_signals",
      question: "forward_signals",
      metrics: [
        ["Recommendation", fmtMetric(metricValue(data, "financialData", "recommendationKey"))],
        ["Target Mean Price", fmtMetric(metricValue(data, "financialData", "targetMeanPrice"))],
        ["Earnings Growth", fmtPercent(metricValue(data, "financialData", "earningsGrowth"))],
        ["Revenue Growth", fmtPercent(metricValue(data, "financialData", "revenueGrowth"))],
        ["Beta", fmtMetric(metricValue(data, "summaryDetail", "beta"))],
        ["Dividend Yield", fmtPercent(metricValue(data, "summaryDetail", "dividendYield"))],
        ["Technical context", movement],
      ],
    },
  ];
}

function localizeFundRepSections(sections, language) {
  return sections.map((section, index) => ({
    title: reportText(language, `fundSection${index + 1}`),
    question: reportText(language, `fundQuestion${index + 1}`),
    metrics: section.metrics.map(([label, value]) => [
      fundMetricLabel(language, label),
      value,
      reportText(language, "metricExplanationGeneric"),
    ]),
  }));
}

function promtRepMessage(ticker, result, language = "ru") {
  const row = result.rows[0];
  if (!row) return reportErrorMessage("PromtRep", ticker, result, language);
  return [
    `🧠 PromtRep ${ticker}`,
    "━━━━━━━━━━━━━━",
    "",
    reportText(language, "promptIntro"),
    "",
    reportText(language, "promptRequest", { ticker }),
    `${reportText(language, "promptStructure")}:`,
    `1. ${reportText(language, "prompt1")}`,
    `2. ${reportText(language, "prompt2")}`,
    `3. ${reportText(language, "prompt3")}`,
    `4. ${reportText(language, "prompt4")}`,
    "",
    `${reportText(language, "promptInputs")}:`,
    `${reportText(language, "price")}: ${row.price.toFixed(2)}`,
    `${reportText(language, "movement")}: ${row.change > 0 ? "+" : ""}${row.change.toFixed(2)} (${row.change_percent > 0 ? "+" : ""}${row.change_percent.toFixed(2)}%)`,
    `EMA200: ${valueOrDash(row.ema200)}, AVWAP: ${valueOrDash(row.avwap)}, RSI: ${valueOrDash(row.rsi14)}, ROC20: ${valueOrDash(row.roc20)}%`,
    "",
    reportText(language, "promptFinal"),
  ].join("\n").trim();
}

function reportErrorMessage(label, ticker, result, language = "ru") {
  return `⚠️ ${label} ${ticker}\n━━━━━━━━━━━━━━\n${reportText(language, "reportFailed")}`;
}

function telegramSignalMessage(signal, language = "ru") {
  const icon = signal.side === "long" ? "📈" : "📉";
  return [
    `${icon} ${reportText(language, "signalFor", { ticker: signal.ticker })}`,
    "",
    `${reportText(language, "strategy")}: ${localizedStrategy(signal.strategy, language)}`,
    `${reportText(language, "price")}: ${signal.price.toFixed(2)}`,
    `${reportText(language, "condition")}: ${signal.condition}`,
    `${reportText(language, "idea")}: ${signal.idea}`,
    `${reportText(language, "stop")}: ${signal.stop.toFixed(2)}`,
    `${reportText(language, "target")}: ${signal.target.toFixed(2)}`,
    `${reportText(language, "risk")}: ${signal.risk}%`,
  ].join("\n");
}

async function sendTelegram(env, chatId, text, bot = {}) {
  const token = telegramTokenForBot(env, bot);
  if (!token) throw httpError("TELEGRAM_BOT_TOKEN is not set", 500);
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || "Telegram Ð½Ðµ Ð¿Ñ€Ð¸Ð½ÑÐ» ÑÐ¾Ð¾Ð±Ñ‰ÐµÐ½Ð¸Ðµ");
}

async function sendTelegramDocument(env, chatId, filename, content, caption = "", bot = {}) {
  const token = telegramTokenForBot(env, bot);
  if (!token) throw httpError("TELEGRAM_BOT_TOKEN is not set", 500);
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) form.append("caption", caption);
  form.append("document", new File([content], filename, { type: "text/html; charset=utf-8" }));
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || "Telegram не принял файл");
}

function telegramTokenForBot(env, bot = {}) {
  const botId = String(bot.id || "").trim();
  const explicitSecret = String(bot.tokenSecretName || "").trim();
  const candidates = [
    explicitSecret,
    botId ? `TELEGRAM_BOT_TOKEN_${secretSuffix(botId)}` : "",
    "TELEGRAM_BOT_TOKEN",
  ].filter(Boolean);
  for (const name of candidates) {
    if (env[name]) return env[name];
  }
  return "";
}

function compactTimestamp(value) {
  return String(value || new Date().toISOString()).replace(/[^0-9]/g, "").slice(0, 14);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function secretSuffix(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function validateContractPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { errors: [contractError("payload", "Payload must be a JSON object")] };
  }
  if (payload.contractVersion !== CONTRACT_VERSION) {
    errors.push(contractError("contractVersion", `contractVersion is required and must be "${CONTRACT_VERSION}"`));
  }
  if (!stringOrNull(payload.requestId)) {
    errors.push(contractError("requestId", "requestId is required"));
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "tickers")) {
    errors.push(contractError("tickers", "tickers is required"));
  } else {
    const rawTickers = rawContractTickers(payload.tickers);
    if (!rawTickers.length) {
      errors.push(contractError("tickers", "tickers must be a non-empty ticker list"));
    }
    for (const rawTicker of rawTickers) {
      const ticker = rawTicker.trim().toUpperCase();
      if (!isValidTicker(ticker)) {
        errors.push(contractError("tickers", `${rawTicker || "(empty)"}: ${tickerValidationError(rawTicker || "")}`, "invalid_ticker"));
      }
    }
  }
  for (const field of ["country", "news", "analysis", "delivery"]) {
    if (!payload[field] || typeof payload[field] !== "object" || Array.isArray(payload[field])) {
      errors.push(contractError(field, `${field} is required and must be an object`));
    }
  }
  if (payload.bot && typeof payload.bot === "object") {
    if (payload.bot.token || payload.bot.telegramToken || payload.bot.botToken) {
      errors.push(contractError("bot", "Do not send Telegram tokens in payload; use bot.tokenSecretName and Cloudflare secrets"));
    }
  }
  if (payload.telegramToken || payload.botToken || payload.tokenSecret) {
    errors.push(contractError("telegram", "Do not send Telegram tokens in payload"));
  }
  const forbiddenBusinessFields = [
    "quota",
    "quotaBalance",
    "quotaDecision",
    "chargeUnits",
    "remainingUnits",
    "tariff",
    "tariffPlan",
    "subscription",
    "subscriptionState",
    "userBalance",
    "balance",
    "billingLedger",
  ];
  for (const field of forbiddenBusinessFields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      errors.push(contractError(field, "Do not send quota, balance, tariff, subscription, or billing data to scanner"));
    }
  }
  if (payload.analysis && typeof payload.analysis === "object") {
    const rawStrategies = payload.analysis.strategies;
    const strategies = normalizeStrategies(rawStrategies || DEFAULT_STRATEGIES);
    const invalidStrategies = strategies.filter((strategy) => !CONTRACT_STRATEGIES.includes(strategy));
    if (invalidStrategies.length) {
      errors.push(contractError("analysis.strategies", `Unsupported strategies: ${invalidStrategies.join(", ")}. Use: ${CONTRACT_STRATEGIES.join(", ")}`));
    }
    const hasRisk = Object.prototype.hasOwnProperty.call(payload.analysis, "risk");
    const risk = Number(payload.analysis.risk);
    if (hasRisk && (!Number.isFinite(risk) || risk <= 0)) {
      errors.push(contractError("analysis.risk", "risk must be a positive number representing percent risk per trade"));
    }
    const hasAnchorBars = Object.prototype.hasOwnProperty.call(payload.analysis, "anchorBars") || Object.prototype.hasOwnProperty.call(payload.analysis, "anchor_bars");
    const anchorBars = Number(payload.analysis.anchorBars ?? payload.analysis.anchor_bars);
    if (hasAnchorBars && (!Number.isInteger(anchorBars) || anchorBars <= 0)) {
      errors.push(contractError("analysis.anchorBars", "anchorBars must be a positive integer candle count"));
    }
  }
  const reportType = String(payload.reportType || payload.analysis?.reportType || "regular").trim().toLowerCase();
  if (!["regular", "fundrep"].includes(reportType)) {
    errors.push(contractError("reportType", "reportType must be regular or fundrep"));
  }
  const language = contractLanguageValue(payload);
  if (!isSupportedReportLanguage(language)) {
    errors.push(contractError("language", "Supported languages: ru, en, he", "unsupported_language"));
  }
  return { errors };
}

function contractLanguageValue(payload) {
  return payload.language ?? payload.analysis?.language ?? payload.locale ?? payload.news?.language ?? null;
}

function contractError(field, message, code = "invalid_contract") {
  return { field, code, message };
}

function rawContractTickers(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") return String(item.symbol ?? item.ticker ?? "").trim();
      return "";
    }).filter(Boolean);
  }
  return String(value || "")
    .replace(/[\s;]+/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function contractRejectedResponse(requestId, errors) {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: requestId || null,
    status: "rejected",
    errors,
  };
}

function contractFailedResponse(requestId, error) {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: requestId || null,
    status: "failed",
    report: null,
    telegram: { sendToTelegram: false, delivered: false, chatId: null },
    errors: [contractError("scanner", error.message || String(error), error.code || "scanner_failed")],
  };
}

function contractAccessRejectedResponse(normalized, accessChecks) {
  const primary = accessChecks.find((access) => access.allowed === false) || accessChecks[0] || {};
  const failureCode = primary.failureCode || null;
  const failed = Boolean(failureCode);
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: normalized.requestId,
    status: failed ? "failed" : "rejected",
    report: null,
    access: normalizeAccessChecks(accessChecks),
    telegram: { sendToTelegram: false, delivered: false, chatId: null },
    errors: [
      contractError(
        "access",
        primary.reason || "Access or quota check rejected the request",
        failureCode || primary.quotaDecision || "rejected_no_access"
      ),
    ],
  };
}

function contractInvalidAccessDecisionResponse(normalized, accessChecks) {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: normalized.requestId,
    status: "failed",
    report: null,
    access: normalizeAccessChecks(accessChecks),
    telegram: { sendToTelegram: false, delivered: false, chatId: null },
    errors: [contractError(
      "access",
      "forceRefresh cannot be combined with reportSource=cached_report",
      "invalid_access_decision"
    )],
  };
}

function contractAccessFailureResponse(normalized, accessChecks, message, code) {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: normalized.requestId,
    status: "failed",
    report: null,
    access: normalizeAccessChecks(accessChecks),
    telegram: { sendToTelegram: false, delivered: false, chatId: null },
    errors: [contractError("access", message, code)],
  };
}

function contractCachedReportFailureResponse(normalized, accessChecks, missingTickers) {
  const fundRep = normalized.reportType === "fundrep";
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: normalized.requestId,
    status: "failed",
    report: null,
    access: normalizeAccessChecks(accessChecks),
    telegram: { sendToTelegram: false, delivered: false, chatId: null },
    errors: [contractError(
      "cache",
      fundRep
        ? `Fresh FundRep cache was promised but not found for: ${missingTickers.join(", ")}`
        : `Fresh cached report was promised but not found for: ${missingTickers.join(", ")}`,
      fundRep ? "fundrep_cache_not_found" : "cached_report_not_found"
    )],
  };
}

function contractHttpStatus(result = {}) {
  if (result.status === "processed") return 200;
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (result.status === "rejected") {
    if (errors.length && errors.every((error) => error.field === "access")) return 200;
    if (errors.some((error) => error.field === "auth" || error.code === "authentication_failed")) return 403;
    return 400;
  }
  if (result.status === "failed") {
    if (errors.some((error) => ["failed_quota_service", "invalid_core_response", "stored_result_not_found"].includes(error.code))) return 503;
    if (errors.some((error) => ["cached_report_not_found", "fundrep_cache_not_found", "invalid_access_decision"].includes(error.code))) return 503;
    if (errors.some((error) => error.code === "data_provider_error")) return 502;
    return 500;
  }
  return 500;
}

function contractProcessedResponse(normalized, scannerResult, telegram, accessChecks = []) {
  const errors = normalizeContractScannerErrors(scannerResult.errors || []);
  const hasScannerFailure = errors.some((error) => ["data_provider_error", "scanner_error"].includes(error.code));
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: normalized.requestId,
    status: hasScannerFailure ? "failed" : "processed",
    report: {
      analysisType: scannerResult.analysisType || "technical",
      reportType: normalized.reportType,
      generationVersion: normalized.generationVersion,
      cacheStatus: scannerResult.cacheStatus || "miss",
      timeframe: scannerResult.timeframe,
      language: normalized.language,
      risk: scannerResult.config?.risk ?? normalized.risk,
      anchorBars: scannerResult.config?.anchorBars ?? normalized.anchorBars,
      strategies: scannerResult.config?.strategies ?? normalized.strategies,
      tickers: normalized.tickers.map((ticker) => ticker.symbol),
      rows: scannerResult.rows || [],
      items: scannerResult.items || [],
      signalCount: countSignals(scannerResult.rows || []),
      orchestrator: scannerResult.orchestrator || null,
      generatedAt: scannerResult.timestamp || new Date().toISOString(),
      ...(scannerResult.analysisType === "fundamental" ? {
        fundamentalResults: (scannerResult.items || []).map((item) => ({
          ticker: item.ticker,
          status: item.status,
          price: item.price,
          indicators: item.indicators,
          fundamentalSummary: item.fundamentalSummary,
          dataSources: item.dataSources,
          errors: item.errors,
        })),
      } : {}),
    },
    access: normalizeAccessChecks(accessChecks),
    telegram,
    errors,
  };
}

function normalizeAccessChecks(accessChecks = []) {
  return accessChecks.map((access) => ({
    contractVersion: access.contractVersion || CORE_ACCESS_CONTRACT_VERSION,
    requestId: access.requestId || null,
    ticker: access.ticker || null,
    allowed: access.allowed === true,
    chargeUnits: numberOrNull(access.chargeUnits),
    quotaDecision: stringOrNull(access.quotaDecision),
    cacheStatus: stringOrNull(access.cacheStatus),
    reportSource: stringOrNull(access.reportSource),
    remainingUnits: numberOrNull(access.remainingUnits),
    reason: stringOrNull(access.reason),
    cacheReceiptId: stringOrNull(access.cacheReceiptId),
    cacheCommitStatus: stringOrNull(access.cacheCommitStatus),
    requestCacheStatus: stringOrNull(access.requestCacheStatus),
    requestCacheCreatedAt: stringOrNull(access.requestCacheCreatedAt),
    requestCacheGenerationVersion: stringOrNull(access.requestCacheGenerationVersion),
  }));
}

function normalizeContractScannerErrors(errors) {
  return errors.map((error) => ({
    field: error.ticker ? `tickers.${error.ticker}` : "scanner",
    code: scannerErrorStatus(error.code),
    message: error.error || error.message || String(error),
  }));
}

function scannerErrorStatus(code) {
  const normalized = String(code || "").toUpperCase();
  if (normalized === "INVALID_TICKER") return "invalid_ticker";
  if (normalized === "INSUFFICIENT_DATA" || normalized === "NO_MARKET_DATA") return "not_enough_data";
  if (normalized === "DATA_PROVIDER_ERROR") return "data_provider_error";
  return "scanner_error";
}

async function loadContractCachedTechnicalReports(env, normalized, accessChecks) {
  const results = new Map();
  const cachedTickers = accessChecks
    .filter((access) => isCachedReportSource(access.reportSource))
    .map((access) => access.ticker)
    .filter(Boolean);
  if (!cachedTickers.length) return { results, missing: [] };
  if (normalized.reportType !== "regular") return { results, missing: cachedTickers };

  const missing = [];
  for (const ticker of cachedTickers) {
    const cached = await getAnalysisCache(env, technicalReportCacheKey(normalized, ticker));
    if (cached) results.set(ticker, cached);
    else missing.push(ticker);
  }
  return { results, missing };
}

async function loadContractCachedFundRepReports(env, normalized, accessChecks) {
  const results = new Map();
  const cachedTickers = accessChecks
    .filter((access) => isCachedReportSource(access.reportSource))
    .map((access) => access.ticker)
    .filter(Boolean);
  const missing = [];
  for (const ticker of cachedTickers) {
    const cached = await getAnalysisCache(env, fundRepReportCacheKey(normalized, ticker));
    if (isValidCachedFundRep(cached, ticker)) results.set(ticker, cached);
    else missing.push(ticker);
  }
  return { results, missing };
}

async function cacheContractTechnicalReports(env, normalized, scannerResult, tickers) {
  const saved = new Map();
  for (const ticker of tickers) {
    const row = (scannerResult.rows || []).find((item) => item.ticker === ticker);
    if (!row) continue;
    const errors = (scannerResult.errors || []).filter((error) => error.ticker === ticker);
    const items = (scannerResult.items || []).filter((item) => item.ticker === ticker);
    const payload = {
      ...scannerResult,
      rows: [row],
      errors,
      items,
      orchestrator: {
        ...(scannerResult.orchestrator || {}),
        status: "technical_report_cache",
        cacheHit: false,
      },
    };
    const cacheWrite = await setAnalysisCache(
      env,
      technicalReportCacheKey(normalized, ticker),
      "technical_report",
      payload,
      TECHNICAL_REPORT_CACHE_TTL_SECONDS
    );
    saved.set(ticker, cacheWrite);
  }
  return saved;
}

async function cacheContractFundRepReports(env, normalized, scannerResult, tickers) {
  const saved = new Map();
  for (const ticker of tickers) {
    const item = (scannerResult.items || []).find((candidate) => candidate.ticker === ticker);
    const fundamentals = scannerResult.fundamentalsByTicker?.[ticker];
    if (!item?.fundamentalSummary || item.errors?.length || !fundamentals || !hasFundamentalSummary(item.fundamentalSummary)) continue;
    const row = (scannerResult.rows || []).find((candidate) => candidate.ticker === ticker);
    const payload = {
      timestamp: scannerResult.timestamp,
      timeframe: scannerResult.timeframe,
      analysisType: "fundamental",
      rows: row ? [row] : [],
      errors: [],
      items: [item],
      config: scannerResult.config,
      fundamentalsByTicker: { [ticker]: fundamentals },
      orchestrator: { status: "fundrep_report_cache", cacheHit: false },
    };
    const cacheWrite = await setAnalysisCache(
      env,
      fundRepReportCacheKey(normalized, ticker),
      "fundrep_report",
      payload,
      FUNDREP_REPORT_CACHE_TTL_SECONDS
    );
    saved.set(ticker, cacheWrite);
  }
  return saved;
}

function technicalReportCacheKey(normalized, ticker) {
  const language = normalized.language || "default";
  const generationVersion = normalized.generationVersion || DEFAULT_GENERATION_VERSION;
  return `technical-report:${ticker}:${normalized.reportType}:${language}:${generationVersion}`;
}

function fundRepReportCacheKey(normalized, ticker) {
  const language = normalized.language || "ru";
  const generationVersion = normalized.generationVersion || DEFAULT_GENERATION_VERSION;
  return `fundrep-report:${ticker}:fundrep:${language}:${generationVersion}`;
}

function isValidCachedFundRep(cached, ticker) {
  if (!cached || cached.analysisType !== "fundamental" || cached.errors?.length) return false;
  const item = (cached.items || []).find((candidate) => candidate.ticker === ticker);
  return Boolean(item?.fundamentalSummary && hasFundamentalSummary(item.fundamentalSummary));
}

function mergeContractScannerResults(normalized, freshResult, cachedResults) {
  const cached = [...cachedResults.values()];
  if (!cached.length) return freshResult;
  const parts = freshResult ? [freshResult, ...cached] : cached;
  const tickerOrder = new Map(normalized.tickers.map((ticker, index) => [ticker.symbol, index]));
  const byTicker = (left, right) => (tickerOrder.get(left.ticker) ?? 999) - (tickerOrder.get(right.ticker) ?? 999);
  const rows = parts.flatMap((part) => part.rows || []).sort(byTicker);
  const errors = parts.flatMap((part) => part.errors || []).sort(byTicker);
  const items = parts.flatMap((part) => part.items || [])
    .map((item) => ({ ...item, requestId: normalized.requestId }))
    .sort(byTicker);
  const fundamentalsByTicker = Object.assign({}, ...parts.map((part) => part.fundamentalsByTicker || {}));
  const analysisType = normalized.reportType === "fundrep" ? "fundamental" : "technical";
  return {
    ...(freshResult || cached[0]),
    requestId: normalized.requestId,
    timestamp: freshResult?.timestamp || cached[0]?.timestamp || new Date().toISOString(),
    analysisType,
    config: freshResult?.config || cached[0]?.config || normalizeAnalysisConfig(normalized),
    rows,
    errors,
    items,
    fundamentalsByTicker,
    orchestrator: {
      status: freshResult ? "mixed_cache" : "technical_report_cache_hit",
      cacheHit: !freshResult,
      cachedTickers: [...cachedResults.keys()],
    },
  };
}

function contractCacheStatus(normalized, freshCount, cachedCount) {
  if (freshCount > 0 && cachedCount > 0) return "mixed";
  if (cachedCount > 0) return "hit";
  if (normalized.forceRefresh) return "refreshed";
  return "miss";
}

function isCachedReportSource(value) {
  return ["cache", "cached_report", "own_repeat"].includes(String(value || "").trim().toLowerCase());
}

function isOwnRepeatDecision(access) {
  return String(access?.reportSource || "").toLowerCase() === "own_repeat" ||
    ["own_repeat", "own_repeat_fundrep"].includes(String(access?.quotaDecision || "").toLowerCase());
}

async function checkContractAccessForTickers(env, normalized, origin = "-", country = "-", existingResult = null) {
  const endpoint = accessCheckUrl(env);
  const keyId = String(env.CORE_HMAC_KEY_ID || "").trim();
  const secret = String(env.CORE_HMAC_SECRET || "").trim();
  if (!endpoint || !keyId || secret.length < 32) {
    return normalized.tickers.map((ticker) => accessFailedDecision(normalized, ticker.symbol, "Access check is not configured"));
  }

  const checks = [];
  for (const ticker of normalized.tickers) {
    try {
      const cacheHint = existingAccessCacheHint(existingResult, ticker.symbol) || await contractCacheHint(env, normalized, ticker.symbol);
      const body = JSON.stringify(accessCheckRequest(normalized, ticker.symbol, cacheHint));
      const headers = await coreHmacHeaders("POST", endpoint, body, keyId, secret);
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok || !data || typeof data !== "object") {
        checks.push(accessFailedDecision(normalized, ticker.symbol, `Access check HTTP ${response.status}`));
        continue;
      }
      checks.push(normalizeAccessCheckResponse(data, normalized, ticker.symbol, cacheHint));
    } catch (error) {
      checks.push(accessFailedDecision(normalized, ticker.symbol, "Core access check unavailable"));
    }
  }

  const failed = checks.find((check) => check.failureCode);
  if (failed) {
    await addLog(env, origin, "Access check", normalized.tickers.map((ticker) => ticker.symbol).join(", "), "error", failed.failureCode, country);
  }
  return checks;
}

function isProduction(env) {
  return ["production", "prod"].includes(String(env.APP_ENV || "").trim().toLowerCase());
}

function accessCheckUrl(env) {
  const explicit = String(env.ACCESS_CHECK_URL || "").trim();
  if (explicit) return explicit;
  const base = String(env.MARKET_SIGNAL_AI_BOT_URL || "").trim().replace(/\/+$/, "");
  return base ? `${base}${ACCESS_CHECK_PATH}` : "";
}

function accessCheckRequest(normalized, ticker, cacheHint) {
  return {
    contractVersion: CORE_ACCESS_CONTRACT_VERSION,
    requestId: normalized.requestId,
    userId: normalized.userId,
    chatId: normalized.chatId,
    ticker,
    reportType: normalized.reportType,
    generationVersion: normalized.generationVersion,
    cacheStatus: cacheHint.cacheStatus,
    cacheCreatedAt: cacheHint.cacheCreatedAt,
    cacheGenerationVersion: cacheHint.cacheGenerationVersion,
    forceRefresh: normalized.forceRefresh,
    language: normalized.language,
  };
}

function normalizeAccessCheckResponse(data, normalized, ticker, cacheHint) {
  if (data.contractVersion !== CORE_ACCESS_CONTRACT_VERSION || data.requestId !== normalized.requestId || typeof data.allowed !== "boolean") {
    return accessFailedDecision(normalized, ticker, "Invalid Core response", "invalid_core_response");
  }
  const reportSource = stringOrNull(data.reportSource);
  const quotaDecision = stringOrNull(data.quotaDecision) || (data.allowed === true ? "allowed" : "rejected_no_access");
  const cacheReceiptId = stringOrNull(data.cacheReceiptId);
  if (data.allowed && requiresCacheReceipt(quotaDecision) && !cacheReceiptId) {
    return accessFailedDecision(normalized, ticker, "Core did not return cacheReceiptId for new/refresh decision", "invalid_core_response");
  }
  return {
    contractVersion: CORE_ACCESS_CONTRACT_VERSION,
    requestId: data.requestId || normalized.requestId,
    ticker,
    allowed: data.allowed === true,
    chargeUnits: numberOrNull(data.chargeUnits),
    quotaDecision,
    cacheStatus: stringOrNull(data.cacheStatus),
    reportSource,
    remainingUnits: numberOrNull(data.remainingUnits),
    reason: stringOrNull(data.reason) || (data.allowed === true ? "Allowed" : "Rejected"),
    cacheReceiptId,
    requestCacheStatus: cacheHint.cacheStatus,
    requestCacheCreatedAt: cacheHint.cacheCreatedAt,
    requestCacheGenerationVersion: cacheHint.cacheGenerationVersion,
    cacheCommitStatus: null,
    failureCode: null,
  };
}

function requiresCacheReceipt(quotaDecision) {
  return /^(new|refresh)_(regular|fundrep)$/.test(String(quotaDecision || "").toLowerCase());
}

function existingAccessCacheHint(existingResult, ticker) {
  const access = (existingResult?.access || []).find((item) => item.ticker === ticker);
  if (!access || !["hit", "miss"].includes(access.requestCacheStatus)) return null;
  return {
    cacheStatus: access.requestCacheStatus,
    cacheCreatedAt: stringOrNull(access.requestCacheCreatedAt),
    cacheGenerationVersion: stringOrNull(access.requestCacheGenerationVersion),
  };
}

async function contractCacheHint(env, normalized, ticker) {
  const cacheKey = normalized.reportType === "fundrep"
    ? fundRepReportCacheKey(normalized, ticker)
    : technicalReportCacheKey(normalized, ticker);
  const entry = await getAnalysisCacheEntry(env, cacheKey);
  const valid = normalized.reportType === "fundrep"
    ? isValidCachedFundRep(entry?.payload, ticker)
    : Boolean(entry?.payload?.rows?.some((row) => row.ticker === ticker));
  if (!entry || !valid) return { cacheStatus: "miss", cacheCreatedAt: null, cacheGenerationVersion: null };
  return {
    cacheStatus: "hit",
    cacheCreatedAt: entry.createdAt,
    cacheGenerationVersion: normalized.generationVersion,
  };
}

function accessFailedDecision(normalized, ticker, reason, failureCode = "failed_quota_service") {
  return {
    contractVersion: CORE_ACCESS_CONTRACT_VERSION,
    requestId: normalized.requestId,
    ticker,
    allowed: false,
    chargeUnits: null,
    quotaDecision: failureCode,
    cacheStatus: null,
    reportSource: null,
    remainingUnits: null,
    reason,
    cacheReceiptId: null,
    failureCode,
  };
}

async function coreHmacHeaders(method, endpoint, body, keyId, secret) {
  const url = new URL(endpoint);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestId = `scanner_${crypto.randomUUID()}`;
  const bodyHash = await sha256Hex(body);
  const canonical = `${timestamp}.${keyId}.${requestId}.${method.toUpperCase()}.${url.pathname}.${canonicalQuery(url.searchParams)}.${bodyHash}`;
  const signature = await hmacHex(secret, canonical);
  return {
    "Content-Type": "application/json",
    "X-Key-Id": keyId,
    "X-Request-Id": requestId,
    "X-Timestamp": timestamp,
    "X-Signature": `sha256=${signature}`,
  };
}

async function commitContractCacheReceipts(env, normalized, accessChecks, savedReports, origin, country) {
  for (const access of accessChecks) {
    if (!requiresCacheReceipt(access.quotaDecision)) continue;
    const saved = savedReports.get(access.ticker);
    if (!saved || !access.cacheReceiptId) continue;
    const commit = await commitCoreCacheReceipt(env, normalized, access, saved.resultDigest);
    access.cacheCommitStatus = commit.ok ? "committed" : "failed";
    if (!commit.ok) {
      await addLog(
        env,
        origin,
        "Core cache commit",
        access.ticker,
        "error",
        `request=${normalized.requestId}; code=${commit.code}`,
        country
      );
    }
  }
}

async function commitCoreCacheReceipt(env, normalized, access, resultDigest) {
  const accessEndpoint = accessCheckUrl(env);
  const endpoint = accessEndpoint ? new URL("/api/internal/access/cache/commit", accessEndpoint).toString() : "";
  const keyId = String(env.CORE_HMAC_KEY_ID || "").trim();
  const secret = String(env.CORE_HMAC_SECRET || "").trim();
  if (!endpoint || !keyId || secret.length < 32) return { ok: false, code: "cache_commit_not_configured" };
  const body = JSON.stringify({
    contractVersion: CORE_ACCESS_CONTRACT_VERSION,
    cacheReceiptId: access.cacheReceiptId,
    requestId: normalized.requestId,
    ticker: access.ticker,
    reportType: normalized.reportType,
    generationVersion: normalized.generationVersion,
    language: normalized.language,
    resultDigest,
  });
  let lastCode = "cache_commit_unavailable";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const headers = await coreHmacHeaders("POST", endpoint, body, keyId, secret);
      const response = await fetch(endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (response.ok && data?.contractVersion === CORE_ACCESS_CONTRACT_VERSION && data.committed === true) {
        return { ok: true, cacheEntryId: stringOrNull(data.cacheEntryId), expiresAt: stringOrNull(data.expiresAt) };
      }
      lastCode = stringOrNull(data?.error) || `cache_commit_http_${response.status}`;
      if (response.status < 500) break;
    } catch {
      lastCode = "cache_commit_unavailable";
    }
  }
  return { ok: false, code: lastCode };
}

function canonicalQuery(searchParams) {
  return [...searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(signature));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeExternalPayload(payload, env) {
  const analysis = payload.analysis || {};
  const country = payload.country || {};
  const bot = payload.bot || {};
  const delivery = payload.delivery || {};
  const tickers = parseTickerDetails(payload.tickers ?? payload.ticker ?? payload.symbol ?? []);
  return {
    requestId: stringOrNull(payload.requestId),
    source: String(payload.source || "external").trim(),
    country: {
      id: stringOrNull(country.id),
      iso2: stringOrNull(country.iso2),
      name: stringOrNull(country.name),
      marketCode: stringOrNull(country.marketCode || country.market_code),
      timezone: stringOrNull(country.timezone),
    },
    bot: {
      id: stringOrNull(bot.id),
      username: stringOrNull(bot.username || bot.bot_username),
      displayName: stringOrNull(bot.displayName || bot.display_name),
      tokenSecretName: stringOrNull(bot.tokenSecretName || bot.token_secret_name),
    },
    chatId: extractReplyChatId(payload, env),
    userId: stringOrNull(payload.userId || payload.user_id || payload.telegramUserId || payload.user?.id),
    news: normalizeNews(payload.news),
    tickers,
    reportType: String(payload.reportType || analysis.reportType || "regular").trim().toLowerCase(),
    generationVersion: stringOrNull(payload.generationVersion || analysis.generationVersion || env.REPORT_GENERATION_VERSION) || DEFAULT_GENERATION_VERSION,
    forceRefresh: payload.forceRefresh === true || analysis.forceRefresh === true,
    language: normalizeLanguage(contractLanguageValue(payload)),
    timeframe: normalizeAnalysisConfig({ timeframe: analysis.timeframe || payload.timeframe || env.DEFAULT_TIMEFRAME || DEFAULT_TIMEFRAME }).timeframe,
    strategies: normalizeAnalysisConfig({ strategies: analysis.strategies || payload.strategies || env.DEFAULT_STRATEGIES || DEFAULT_STRATEGIES }).strategies,
    risk: normalizeAnalysisConfig({ risk: analysis.risk || payload.risk || env.DEFAULT_RISK || 1 }).risk,
    anchorBars: normalizeAnalysisConfig({ anchorBars: analysis.anchorBars || payload.anchorBars || env.DEFAULT_ANCHOR_BARS || 120 }).anchorBars,
    delivery: {
      sendToTelegram: delivery.sendToTelegram !== false,
      messageOrder: delivery.messageOrder || "news_then_analysis",
      async: delivery.async === true || payload.async === true,
    },
  };
}

function normalizeLanguage(value) {
  return normalizeReportLanguage(value);
}

function normalizeNews(news) {
  if (!news || typeof news !== "object") return null;
  const title = String(news.title || "").trim();
  const summary = String(news.summary || "").trim();
  const url = String(news.url || "").trim();
  if (!title && !summary && !url) return null;
  return {
    id: stringOrNull(news.id),
    title,
    summary,
    url,
    source: stringOrNull(news.source),
    publishedAt: stringOrNull(news.publishedAt || news.published_at),
    language: stringOrNull(news.language),
  };
}

function parseTickerDetails(value) {
  const items = Array.isArray(value) ? value : parseTickers(value).map((symbol) => ({ symbol }));
  const seen = new Set();
  const details = [];
  for (const item of items) {
    const rawSymbol = typeof item === "string" ? item : item?.symbol || item?.ticker;
    const symbol = parseTickers(rawSymbol)[0];
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    details.push({
      symbol,
      companyName: typeof item === "object" ? stringOrNull(item.companyName || item.company_name) : null,
      exchange: typeof item === "object" ? stringOrNull(item.exchange) : null,
      countryIso2: typeof item === "object" ? stringOrNull(item.countryIso2 || item.country_iso2) : null,
      confidence: typeof item === "object" && item.confidence != null ? Number(item.confidence) : null,
      reason: typeof item === "object" ? stringOrNull(item.reason) : null,
    });
  }
  return details;
}

function newsMessage(normalized) {
  const language = normalized.language;
  const news = normalized.news;
  const country = normalized.country?.name || normalized.country?.iso2 || "-";
  const tickers = normalized.tickers.map((ticker) => {
    const suffix = ticker.companyName ? ` (${ticker.companyName})` : "";
    return `${ticker.symbol}${suffix}`;
  }).join(", ");
  return [
    reportText(language, "marketNews"),
    "--------------",
    `${reportText(language, "country")}: ${country}`,
    news.source ? `${reportText(language, "source")}: ${news.source}` : "",
    news.publishedAt ? `${reportText(language, "published")}: ${news.publishedAt}` : "",
    "",
    news.title,
    news.summary ? `\n${news.summary}` : "",
    news.url ? `\n${news.url}` : "",
    "",
    `${reportText(language, "tickers")}: ${tickers || "-"}`,
  ].filter((line) => line !== "").join("\n").trim();
}

async function storeMatcherPayload(env, normalized, newsId) {
  const now = new Date().toISOString();
  const countryId = normalized.country.id || normalized.country.iso2?.toLowerCase() || "unknown";
  if (normalized.country.iso2 || normalized.country.name) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO countries (id, iso2, name, market_code, timezone, is_active) VALUES (?, ?, ?, ?, ?, 1)"
    ).bind(
      countryId,
      normalized.country.iso2 || countryId.toUpperCase(),
      normalized.country.name || normalized.country.iso2 || countryId,
      normalized.country.marketCode || normalized.country.iso2 || null,
      normalized.country.timezone || "UTC"
    ).run();
  }
  if (normalized.bot.id) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO telegram_bots (id, bot_username, bot_type, country_id, display_name, token_secret_name, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)"
    ).bind(
      normalized.bot.id,
      normalized.bot.username || normalized.bot.id,
      "country",
      countryId,
      normalized.bot.displayName || normalized.bot.id,
      normalized.bot.tokenSecretName || `TELEGRAM_BOT_TOKEN_${secretSuffix(normalized.bot.id)}`,
      now,
      now
    ).run();
  }
  if (!normalized.news) return;
  const finalNewsId = newsId || normalized.requestId || crypto.randomUUID();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO news_items (id, country_id, source, title, url, summary, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    finalNewsId,
    countryId,
    normalized.news.source || normalized.source || null,
    normalized.news.title || "(untitled)",
    normalized.news.url || null,
    normalized.news.summary || null,
    normalized.news.publishedAt || null,
    now
  ).run();
  for (const ticker of normalized.tickers) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO news_tickers (news_id, ticker, company_name, country_id, confidence) VALUES (?, ?, ?, ?, ?)"
    ).bind(finalNewsId, ticker.symbol, ticker.companyName, countryId, ticker.confidence).run();
  }
}

async function addLog(env, origin, action, tickers, status, detail = "", country = "-") {
  if (!env.DB) return;
  await ensureRequestLogCountryColumn(env);
  await env.DB.prepare(
    "INSERT INTO request_logs (time, origin, action, tickers, status, country, detail) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(new Date().toISOString(), origin, action, tickers, status, country || "-", detail).run();
}

async function addTickerRequestLog(env, entry) {
  if (!env.DB) return;
  await ensureTickerRequestLogTable(env);
  const tickers = Array.isArray(entry.tickers) ? entry.tickers.join(", ") : String(entry.tickers || "");
  await env.DB.prepare(
    "INSERT INTO ticker_request_logs (time, origin, source, tickers, status, country, chat_id, user_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    new Date().toISOString(),
    entry.origin || "-",
    entry.source || "-",
    tickers || "-",
    entry.status || "received",
    entry.country || "-",
    entry.chatId || null,
    entry.userId || null,
    entry.detail || ""
  ).run();
}

async function latestLogs(env) {
  if (!env.DB) return [];
  await ensureRequestLogCountryColumn(env);
  const result = await env.DB.prepare(
    "SELECT time, origin, action, tickers, status, country, detail FROM request_logs ORDER BY id DESC LIMIT 80"
  ).all();
  return result.results || [];
}

async function latestTickerLogs(env) {
  if (!env.DB) return [];
  await ensureTickerRequestLogTable(env);
  const result = await env.DB.prepare(
    "SELECT time, origin, source, tickers, status, country, chat_id, user_id, detail FROM ticker_request_logs ORDER BY id DESC LIMIT 80"
  ).all();
  return result.results || [];
}

async function ensureRequestLogCountryColumn(env) {
  if (!env.DB) return;
  try {
    await env.DB.prepare("ALTER TABLE request_logs ADD COLUMN country TEXT NOT NULL DEFAULT '-'").run();
  } catch (error) {
    if (!String(error?.message || error).toLowerCase().includes("duplicate column")) throw error;
  }
}

async function ensureTickerRequestLogTable(env) {
  if (!env.DB) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ticker_request_logs (
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
    )`
  ).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_ticker_request_logs_time ON ticker_request_logs(time)").run();
}

async function latestStats(env) {
  if (!env.DB) return { logs: 0, tickerRequests: 0, analysisTasks: 0, cacheEntries: 0, news: 0, tickers: 0 };
  await ensureTickerRequestLogTable(env);
  await ensureOrchestratorTables(env);
  const [logs, tickerRequests, analysisTasks, cacheEntries, news, tickers] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM request_logs").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM ticker_request_logs").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM analysis_tasks").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM analysis_cache").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM news_items").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM news_tickers").first(),
  ]);
  return {
    logs: Number(logs?.count || 0),
    tickerRequests: Number(tickerRequests?.count || 0),
    analysisTasks: Number(analysisTasks?.count || 0),
    cacheEntries: Number(cacheEntries?.count || 0),
    news: Number(news?.count || 0),
    tickers: Number(tickers?.count || 0),
  };
}

async function clearLogs(env) {
  if (!env.DB) return;
  await env.DB.prepare("DELETE FROM request_logs").run();
  await ensureTickerRequestLogTable(env);
  await env.DB.prepare("DELETE FROM ticker_request_logs").run();
  await ensureOrchestratorTables(env);
  await env.DB.prepare("DELETE FROM analysis_tasks").run();
  await env.DB.prepare("DELETE FROM analysis_cache").run();
}

async function ensureOrchestratorTables(env) {
  if (!env.DB) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS analysis_tasks (
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
    )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS analysis_cache (
      cache_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS contract_results (
      request_id TEXT PRIMARY KEY,
      contract_version TEXT NOT NULL,
      status TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_analysis_tasks_created ON analysis_tasks(created_at)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_analysis_tasks_status ON analysis_tasks(status)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_analysis_cache_expires ON analysis_cache(expires_at)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_contract_results_status ON contract_results(status)").run();
}

async function getContractResult(env, requestId) {
  if (!requestId) return null;
  if (!env.DB) return fallbackContractResults.get(requestId) || null;
  await ensureOrchestratorTables(env);
  const row = await env.DB.prepare("SELECT response_json FROM contract_results WHERE request_id = ?").bind(requestId).first();
  if (!row) return null;
  try {
    return JSON.parse(row.response_json);
  } catch {
    return null;
  }
}

async function setContractResult(env, requestId, response) {
  if (!requestId || !response) return;
  if (!env.DB) {
    fallbackContractResults.set(requestId, response);
    return;
  }
  await ensureOrchestratorTables(env);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO contract_results (request_id, contract_version, status, response_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(request_id) DO UPDATE SET
       status=excluded.status,
       response_json=excluded.response_json,
       updated_at=excluded.updated_at`
  ).bind(requestId, response.contractVersion || CONTRACT_VERSION, response.status || "processed", JSON.stringify(response), now, now).run();
}

async function getAnalysisCache(env, cacheKey) {
  const entry = await getAnalysisCacheEntry(env, cacheKey);
  return entry?.payload ?? null;
}

async function getAnalysisCacheEntry(env, cacheKey) {
  if (!env.DB) {
    const cached = fallbackAnalysisCache.get(cacheKey);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      fallbackAnalysisCache.delete(cacheKey);
      return null;
    }
    return { payload: cached.payload, createdAt: new Date(cached.createdAt).toISOString(), expiresAt: new Date(cached.expiresAt).toISOString() };
  }
  await ensureOrchestratorTables(env);
  const row = await env.DB.prepare(
    "SELECT payload_json, created_at, expires_at FROM analysis_cache WHERE cache_key = ?"
  ).bind(cacheKey).first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await env.DB.prepare("DELETE FROM analysis_cache WHERE cache_key = ?").bind(cacheKey).run();
    return null;
  }
  try {
    return { payload: JSON.parse(row.payload_json), createdAt: row.created_at, expiresAt: row.expires_at };
  } catch {
    return null;
  }
}

async function setAnalysisCache(env, cacheKey, kind, payload, ttlSeconds) {
  const createdAtMs = Date.now();
  const createdAt = new Date(createdAtMs).toISOString();
  const expiresAt = new Date(createdAtMs + ttlSeconds * 1000).toISOString();
  const payloadJson = JSON.stringify(payload);
  if (!env.DB) {
    fallbackAnalysisCache.set(cacheKey, { kind, payload, createdAt: createdAtMs, expiresAt: createdAtMs + ttlSeconds * 1000 });
    return { payload, createdAt, expiresAt, resultDigest: await sha256Hex(payloadJson) };
  }
  await ensureOrchestratorTables(env);
  await env.DB.prepare(
    `INSERT INTO analysis_cache (cache_key, kind, payload_json, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET kind=excluded.kind, payload_json=excluded.payload_json,
       expires_at=excluded.expires_at, created_at=excluded.created_at, updated_at=excluded.updated_at`
  ).bind(cacheKey, kind, payloadJson, expiresAt, createdAt, createdAt).run();
  return { payload, createdAt, expiresAt, resultDigest: await sha256Hex(payloadJson) };
}

async function recordAnalysisTask(env, task) {
  if (!env.DB) return;
  await ensureOrchestratorTables(env);
  const now = new Date().toISOString();
  const result = task.result || null;
  await env.DB.prepare(
    `INSERT INTO analysis_tasks (
      id, fingerprint, source, origin, status, tickers, timeframe, strategies, risk, anchor_bars,
      request_json, result_json, error, attempts, response_ms, signal_count, quality_score, cache_hit,
      created_at, updated_at, started_at, completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      id=excluded.id,
      source=excluded.source,
      origin=excluded.origin,
      status=excluded.status,
      tickers=excluded.tickers,
      timeframe=excluded.timeframe,
      strategies=excluded.strategies,
      risk=excluded.risk,
      anchor_bars=excluded.anchor_bars,
      request_json=excluded.request_json,
      result_json=excluded.result_json,
      error=excluded.error,
      attempts=MAX(analysis_tasks.attempts, excluded.attempts),
      response_ms=excluded.response_ms,
      signal_count=excluded.signal_count,
      quality_score=excluded.quality_score,
      cache_hit=excluded.cache_hit,
      updated_at=excluded.updated_at,
      started_at=COALESCE(excluded.started_at, analysis_tasks.started_at),
      completed_at=excluded.completed_at`
  ).bind(
    task.id,
    task.fingerprint,
    task.source,
    task.origin,
    task.status,
    task.tickers.join(", "),
    task.config.timeframe,
    task.config.strategies.join(","),
    task.config.risk,
    task.config.anchorBars,
    JSON.stringify(task.request || {}),
    result ? JSON.stringify(result) : null,
    task.error || "",
    task.status === "queued" ? 0 : 1,
    task.responseMs ?? null,
    result ? countSignals(result.rows || []) : 0,
    result ? signalQualityScore(result) : 0,
    task.cacheHit ? 1 : 0,
    now,
    now,
    task.status === "completed" || task.status === "cache_hit" ? now : null,
    task.status === "completed" || task.status === "cache_hit" ? now : null
  ).run();
}

async function markAnalysisTask(env, taskId, status, patch = {}) {
  if (!env.DB) return;
  await ensureOrchestratorTables(env);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE analysis_tasks
     SET status = ?, attempts = COALESCE(?, attempts), error = COALESCE(?, error),
         response_ms = COALESCE(?, response_ms), started_at = COALESCE(?, started_at),
         completed_at = COALESCE(?, completed_at), updated_at = ?
     WHERE id = ?`
  ).bind(
    status,
    patch.attempts ?? null,
    patch.error ?? null,
    patch.responseMs ?? null,
    patch.startedAt ?? null,
    patch.completedAt ?? null,
    now,
    taskId
  ).run();
}

async function latestOrchestratorSnapshot(env) {
  if (!env.DB) return { tasks: [], metrics: { total: 0, cacheHits: 0, avgResponseMs: 0, errors: 0, avgQualityScore: 0 } };
  await ensureOrchestratorTables(env);
  const [tasks, metrics] = await Promise.all([
    env.DB.prepare(
      "SELECT id, source, status, tickers, timeframe, attempts, response_ms, signal_count, quality_score, cache_hit, created_at, updated_at FROM analysis_tasks ORDER BY updated_at DESC LIMIT 20"
    ).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(cache_hit) AS cache_hits,
              AVG(response_ms) AS avg_response_ms,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS errors,
              AVG(quality_score) AS avg_quality_score
       FROM analysis_tasks`
    ).first(),
  ]);
  return {
    tasks: tasks.results || [],
    metrics: {
      total: Number(metrics?.total || 0),
      cacheHits: Number(metrics?.cache_hits || 0),
      avgResponseMs: Math.round(Number(metrics?.avg_response_ms || 0)),
      errors: Number(metrics?.errors || 0),
      avgQualityScore: round(Number(metrics?.avg_quality_score || 0), 2),
    },
  };
}

async function latestTechnicalMonitoring(env) {
  if (!env.DB) {
    return {
      service: "online",
      avgResponseMs: 0,
      requestCount: 0,
      recentErrors: [],
      dataProviderErrors: [],
    };
  }
  await ensureOrchestratorTables(env);
  const [metrics, errors, providerErrors] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS request_count, AVG(response_ms) AS avg_response_ms FROM analysis_tasks"
    ).first(),
    env.DB.prepare(
      "SELECT id, source, tickers, error, updated_at FROM analysis_tasks WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 8"
    ).all(),
    env.DB.prepare(
      "SELECT id, source, tickers, error, updated_at FROM analysis_tasks WHERE error LIKE '%Yahoo%' OR error LIKE '%HTTP%' ORDER BY updated_at DESC LIMIT 8"
    ).all(),
  ]);
  return {
    service: "online",
    avgResponseMs: Math.round(Number(metrics?.avg_response_ms || 0)),
    requestCount: Number(metrics?.request_count || 0),
    recentErrors: errors.results || [],
    dataProviderErrors: providerErrors.results || [],
  };
}

async function ensureAccessTables(env) {
  if (!env.DB) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS allowed_users (telegram_user_id TEXT PRIMARY KEY, username TEXT, note TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS allowed_chats (telegram_chat_id TEXT PRIMARY KEY, title TEXT, chat_type TEXT, note TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
}

async function adminAccessList(env) {
  if (!env.DB) return { ok: true, users: [], chats: [] };
  await ensureAccessTables(env);
  const [users, chats] = await Promise.all([
    env.DB.prepare("SELECT telegram_user_id, username, note, enabled, created_at, updated_at FROM allowed_users ORDER BY updated_at DESC").all(),
    env.DB.prepare("SELECT telegram_chat_id, title, chat_type, note, enabled, created_at, updated_at FROM allowed_chats ORDER BY updated_at DESC").all(),
  ]);
  return { ok: true, users: users.results || [], chats: chats.results || [] };
}

async function saveAllowedUser(env, payload) {
  if (!env.DB) throw httpError("D1 DB is not configured", 500);
  await ensureAccessTables(env);
  const telegramUserId = String(payload.telegramUserId || payload.telegram_user_id || payload.userId || "").trim();
  if (!telegramUserId) throw httpError("telegramUserId is required", 400);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO allowed_users (telegram_user_id, username, note, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET username=excluded.username, note=excluded.note, enabled=excluded.enabled, updated_at=excluded.updated_at`
  ).bind(telegramUserId, payload.username || "", payload.note || "", payload.enabled === false ? 0 : 1, now, now).run();
}

async function saveAllowedChat(env, payload) {
  if (!env.DB) throw httpError("D1 DB is not configured", 500);
  await ensureAccessTables(env);
  const telegramChatId = String(payload.telegramChatId || payload.telegram_chat_id || payload.chatId || "").trim();
  if (!telegramChatId) throw httpError("telegramChatId is required", 400);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO allowed_chats (telegram_chat_id, title, chat_type, note, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_chat_id) DO UPDATE SET title=excluded.title, chat_type=excluded.chat_type, note=excluded.note, enabled=excluded.enabled, updated_at=excluded.updated_at`
  ).bind(telegramChatId, payload.title || "", payload.chatType || payload.chat_type || "", payload.note || "", payload.enabled === false ? 0 : 1, now, now).run();
}

async function setAllowedUserEnabled(env, telegramUserId, enabled) {
  if (!env.DB) throw httpError("D1 DB is not configured", 500);
  await ensureAccessTables(env);
  await env.DB.prepare("UPDATE allowed_users SET enabled = ?, updated_at = ? WHERE telegram_user_id = ?").bind(enabled, new Date().toISOString(), telegramUserId).run();
}

async function setAllowedChatEnabled(env, telegramChatId, enabled) {
  if (!env.DB) throw httpError("D1 DB is not configured", 500);
  await ensureAccessTables(env);
  await env.DB.prepare("UPDATE allowed_chats SET enabled = ?, updated_at = ? WHERE telegram_chat_id = ?").bind(enabled, new Date().toISOString(), telegramChatId).run();
}

async function isTelegramAllowed(env, message) {
  if (!env.DB) return true;
  await ensureAccessTables(env);
  const userId = String(message.from?.id || "").trim();
  const chatId = String(message.chat?.id || "").trim();
  const counts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM allowed_users WHERE enabled = 1) AS users, (SELECT COUNT(*) FROM allowed_chats WHERE enabled = 1) AS chats"
  ).first();
  if (!Number(counts?.users || 0) && !Number(counts?.chats || 0)) return true;
  const [user, chat] = await Promise.all([
    userId ? env.DB.prepare("SELECT telegram_user_id FROM allowed_users WHERE telegram_user_id = ? AND enabled = 1").bind(userId).first() : null,
    chatId ? env.DB.prepare("SELECT telegram_chat_id FROM allowed_chats WHERE telegram_chat_id = ? AND enabled = 1").bind(chatId).first() : null,
  ]);
  return Boolean(user || chat);
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) current = value * k + current * (1 - k);
  return current;
}

function movingAverage(values, period) {
  if (values.length < period) return null;
  const selected = values.slice(-period);
  return selected.reduce((sum, value) => sum + value, 0) / period;
}

function anchoredVwap(candles, bars) {
  const selected = candles.slice(-Math.min(candles.length, bars));
  let pv = 0;
  let volume = 0;
  for (const candle of selected) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    pv += typical * candle.volume;
    volume += candle.volume;
  }
  return volume ? pv / volume : selected[selected.length - 1].close;
}

function volumePoc(candles) {
  const buckets = new Map();
  for (const candle of candles) {
    const bucket = Math.round(candle.close * 100) / 100;
    buckets.set(bucket, (buckets.get(bucket) || 0) + candle.volume);
  }
  let bestPrice = candles[candles.length - 1].close;
  let bestVolume = -1;
  for (const [price, volume] of buckets.entries()) {
    if (volume > bestVolume) {
      bestPrice = price;
      bestVolume = volume;
    }
  }
  return bestPrice;
}

function rsi14(values) {
  if (values.length < 15) return 50;
  const period = 14;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (!losses) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function averageTrueRange(candles, period) {
  const selected = candles.slice(-Math.min(candles.length, period + 1));
  const trs = [];
  for (let i = 1; i < selected.length; i += 1) {
    const current = selected[i];
    const previous = selected[i - 1];
    trs.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }
  return trs.length ? trs.reduce((sum, value) => sum + value, 0) / trs.length : candles[candles.length - 1].close * 0.02;
}

function parseTickers(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  return raw
    .replace(/[\s;]+/g, ",")
    .split(",")
    .map((item) => item.trim().toUpperCase().replace(/^[^A-Z0-9]+|[^A-Z0-9.\-=]+$/g, ""))
    .filter((ticker, index, array) => ticker && array.indexOf(ticker) === index);
}

function parseTelegramText(text) {
  // Service boundary: raw valid tickers always run ordinary technical/signal analysis.
  // Only explicit mode commands such as FundRep/PromtRep switch to a different analysis flow.
  const cleaned = text.replace(/^\/(start|analyze|scan)\b/i, "").trim();
  return parseTickers(cleaned);
}

function parseTelegramReportCommand(text) {
  const match = String(text || "").trim().match(/^\/?(fundrep|promtrep)(?:@\w+)?(?:\s+(.+))?$/i);
  if (!match) return null;
  const type = match[1].toLowerCase();
  return {
    type,
    label: type === "fundrep" ? "FundRep" : "PromtRep",
    tickers: parseTickers(match[2] || ""),
  };
}

function isValidTicker(ticker) {
  return ticker && ticker.length <= MAX_TICKER_LENGTH && TICKER_PATTERN.test(ticker);
}

function tickerValidationError(ticker) {
  if (ticker.length > MAX_TICKER_LENGTH) return `ÑÐ»Ð¸ÑˆÐºÐ¾Ð¼ Ð´Ð»Ð¸Ð½Ð½Ñ‹Ð¹ Ñ‚Ð¸ÐºÐµÑ€, Ð¼Ð°ÐºÑÐ¸Ð¼ÑƒÐ¼ ${MAX_TICKER_LENGTH} ÑÐ¸Ð¼Ð²Ð¾Ð»Ð¾Ð²`;
  return "Ð½ÐµÐºÐ¾Ñ€Ñ€ÐµÐºÑ‚Ð½Ñ‹Ð¹ Ñ‚Ð¸ÐºÐµÑ€";
}

function normalizeStrategies(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : DEFAULT_STRATEGIES;
  return raw
    .map((item) => String(item).trim().toLowerCase())
    .map((item) => {
      if (item === "volume" || item === "avwap" || item === "volume_profile") return "volume_avwap";
      if (item === "breakout_trading") return "breakout";
      if (item === "trend_following") return "trend";
      if (item === "momentum_trading") return "momentum";
      return item;
    })
    .filter((item, index, array) => item && array.indexOf(item) === index);
}

function stringOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

async function readJson(request) {
  if (!request.headers.get("content-type")?.includes("application/json")) return {};
  return request.json();
}

function serviceToken(env) {
  return String(env.SERVICE_TOKEN || env.WEBHOOK_TOKEN || "").trim();
}

function tokenFromHeaders(request) {
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  return request.headers.get("X-Scanner-Token") || bearer || "";
}

function assertServiceToken(request, env) {
  const expected = serviceToken(env);
  if (!expected) throw httpError("SERVICE_TOKEN/WEBHOOK_TOKEN не задан", 500);
  const provided = tokenFromHeaders(request);
  if (provided !== expected) throw httpError("Неверный service token", 403);
}

function assertWebhookToken(request, env, payload) {
  const expected = String(env.WEBHOOK_TOKEN || "").trim();
  if (!expected) throw httpError("WEBHOOK_TOKEN Ð½Ðµ Ð·Ð°Ð´Ð°Ð½", 500);
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  const provided = request.headers.get("X-Scanner-Token") || bearer || payload.token || payload.apiToken || "";
  if (provided !== expected) throw httpError("ÐÐµÐ²ÐµÑ€Ð½Ñ‹Ð¹ Webhook/API token", 403);
}

function assertTelegramWebhookSecret(request, env) {
  const expected = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  if (!expected) throw httpError("TELEGRAM_WEBHOOK_SECRET не задан", 500);
  const provided = String(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "").trim();
  if (provided !== expected) throw httpError("Неверный Telegram webhook secret", 403);
}

function assertAdminToken(request, env, payload = {}) {
  const expected = String(env.ADMIN_TOKEN || "").trim();
  if (!expected) throw httpError("ADMIN_TOKEN не задан", 500);
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  const provided = request.headers.get("X-Admin-Token") || bearer || payload.adminToken || "";
  if (provided !== expected) throw httpError("Неверный admin token", 403);
}

function telegramOrigin(message, request) {
  const chat = message.chat || {};
  const user = message.from || {};
  const name = [user.first_name || chat.first_name || "", user.last_name || chat.last_name || ""].filter(Boolean).join(" ") || "-";
  return `telegram chat_id=${chat.id || "-"}; type=${chat.type || "-"}; user_id=${user.id || "-"}; username=@${user.username || chat.username || "-"}; name=${name}; lang=${user.language_code || "-"}; ip=${clientIp(request)}`;
}

function telegramUserId(message) {
  return String(message.from?.id || "").trim();
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "-";
}

function requestCountry(request) {
  return request.cf?.country || request.headers.get("CF-IPCountry") || "-";
}

function telegramCountry(message, request) {
  const language = String(message.from?.language_code || "").trim();
  if (language) return `lang:${language}`;
  return requestCountry(request);
}

function payloadCountryLabel(country = {}) {
  return country.iso2 || country.name || country.id || "-";
}

function extractReplyChatId(payload = {}, env = {}) {
  const candidates = [
    payload.telegramChatId,
    payload.chatId,
    payload.telegram?.chatId,
    payload.telegram?.chat_id,
    payload.telegram?.chat?.id,
    payload.chat?.id,
    payload.message?.chat?.id,
    payload.update?.message?.chat?.id,
    env.TELEGRAM_CHAT_ID,
  ];
  const value = candidates.find((candidate) => candidate != null && String(candidate).trim());
  return value == null ? "" : String(value).trim();
}

function countSignals(rows) {
  return rows.reduce((sum, row) => sum + (row.signals?.length || 0), 0);
}

function metricValue(data, section, key) {
  const value = data?.[section]?.[key];
  if (value && typeof value === "object") {
    if ("raw" in value) return value.raw;
    if ("fmt" in value) return value.fmt;
  }
  return value;
}

function numberOrNull(value) {
  const normalized = value && typeof value === "object" && "raw" in value ? value.raw : value;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function fmtMetric(value) {
  if (value == null || value === "" || Number.isNaN(value)) return "-";
  if (value && typeof value === "object") {
    if ("raw" in value) return fmtMetric(value.raw);
    if ("fmt" in value) return String(value.fmt);
    return "-";
  }
  if (typeof value === "number") return round(value, 2).toString();
  return String(value);
}

function fmtPercent(value) {
  const number = numberOrNull(value);
  if (number == null) return fmtMetric(value);
  const percent = Math.abs(number) <= 1 ? number * 100 : number;
  return `${round(percent, 2)}%`;
}

function fmtMoney(value) {
  const number = numberOrNull(value);
  if (number == null) return fmtMetric(value);
  const absolute = Math.abs(number);
  if (absolute >= 1_000_000_000_000) return `$${round(number / 1_000_000_000_000, 2)}T`;
  if (absolute >= 1_000_000_000) return `$${round(number / 1_000_000_000, 2)}B`;
  if (absolute >= 1_000_000) return `$${round(number / 1_000_000, 2)}M`;
  return `$${Math.round(number).toLocaleString("en-US")}`;
}

function valueOrDash(value) {
  return value == null || Number.isNaN(value) ? "-" : value;
}

function marketContext(row, language = "ru") {
  const trend = row.ema200 == null ? `EMA200 ${reportText(language, "unavailable")}` : row.price > row.ema200 ? reportText(language, "trendAbove") : row.price < row.ema200 ? reportText(language, "trendBelow") : reportText(language, "trendNear");
  const meanDistance = row.mma150_distance_percent == null ? `MMA150 ${reportText(language, "unavailable")}` : reportText(language, "mmaDistance", { distance: distanceText(row.mma150_distance_percent) });
  const momentum = row.rsi14 >= 55 ? reportText(language, "momentumPositive") : row.rsi14 <= 45 ? reportText(language, "momentumNegative") : reportText(language, "momentumNeutral");
  return `${trend}; ${meanDistance}; RSI ${valueOrDash(row.rsi14)} (${momentum}); ATR14 ${valueOrDash(row.atr14)}.`;
}

function localizedStatus(status, language = "ru") {
  return reportText(language, `status_${status}`);
}

function localizedSide(side, language = "ru") {
  return reportText(language, `side_${side}`);
}

function localizedStrategy(strategy, language = "ru") {
  const key = String(strategy || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return reportText(language, `strategy_${key}`);
}

function distanceText(value) {
  if (value == null || Number.isNaN(value)) return "-";
  return `${value > 0 ? "+" : ""}${round(value, 2)}%`;
}

function normalizeAnalysisConfig(config = {}) {
  const risk = Number(config.risk ?? 1);
  const anchorBars = Number(config.anchorBars ?? config.anchor_bars ?? 120);
  const strategies = normalizeStrategies(config.strategies || DEFAULT_STRATEGIES)
    .filter((strategy) => CONTRACT_STRATEGIES.includes(strategy));
  return {
    timeframe: config.timeframe || DEFAULT_TIMEFRAME,
    strategies: strategies.length ? strategies : DEFAULT_STRATEGIES,
    risk: Number.isFinite(risk) && risk > 0 ? risk : 1,
    anchorBars: Number.isFinite(anchorBars) && anchorBars > 0 ? Math.round(anchorBars) : 120,
    language: normalizeLanguage(config.language),
    generationVersion: stringOrNull(config.generationVersion) || DEFAULT_GENERATION_VERSION,
  };
}

async function analysisFingerprint(payload) {
  const encoded = new TextEncoder().encode(stableJson(payload));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function runWithRetries(fn, retryLimit) {
  let lastError;
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (error.noRetry) break;
      if (error.code === "INVALID_TICKER" || error.code === "INSUFFICIENT_DATA") break;
      if (attempt < retryLimit) await sleep(120 * (attempt + 1));
    }
  }
  throw lastError;
}

async function fetchJsonProviderWithRetry(url, providerName, retryLimit = ORCHESTRATOR_RETRY_LIMIT) {
  return runWithRetries(async () => {
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) {
      const error = analysisError(`${providerName} HTTP ${response.status}`, response.status === 429 || response.status >= 500 ? "DATA_PROVIDER_ERROR" : "NO_MARKET_DATA");
      if (error.code === "NO_MARKET_DATA") error.noRetry = true;
      throw error;
    }
    return response.json();
  }, retryLimit);
}

function signalQualityScore(result) {
  const rows = result.rows || [];
  const errors = result.errors || [];
  if (!rows.length && errors.length) return 0;
  const signalCount = countSignals(rows);
  const rowScore = rows.length * 0.35;
  const signalScore = Math.min(signalCount, 6) * 0.12;
  const errorPenalty = errors.length * 0.18;
  return Math.max(0, Math.min(1, round(rowScore + signalScore - errorPenalty, 2)));
}

function analysisError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function json(payload, status = 200) {
  return corsResponse(JSON.stringify(payload), status, { "Content-Type": "application/json; charset=utf-8" });
}

function corsResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      ...headers,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Scanner-Token, X-Admin-Token",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

