const DEFAULT_TIMEFRAME = "1d";
const DEFAULT_STRATEGIES = ["trend", "breakout", "volume_avwap", "momentum"];
const MAX_TICKER_LENGTH = 12;
const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-=]{0,11}$/;
const MARKET_CACHE_TTL_SECONDS = 60;
const RESULT_CACHE_TTL_SECONDS = 120;
const ORCHESTRATOR_RETRY_LIMIT = 2;

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
      if (request.method === "POST" && ["/scan", "/api/external/analyze", "/api/webhook/analyze"].includes(url.pathname)) {
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
        const payload = await readJson(request);
        assertWebhookToken(request, env, payload);
        await clearLogs(env);
        return json({ ok: true, logs: [] });
      }
      if (request.method === "POST" && url.pathname === "/telegram/webhook") {
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
    result.requestId = normalized.requestId || null;
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
    return { ok: true, status: "queued", requestId: requestKey, tickers, timeframe };
  }
  return execute();
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

  await addTickerRequestLog(env, {
    origin,
    source: "telegram",
    tickers,
    status: "received",
    country,
    chatId,
    userId: telegramUserId(message),
    detail: chat.title || chat.username || "",
  });
  await addLog(env, origin, "Telegram analysis", tickers.join(", "), "started", "", country);
  const result = await runAnalysisOrchestrator(env, {
    source: "telegram",
    origin,
    tickers,
    config: {
      timeframe: env.DEFAULT_TIMEFRAME || DEFAULT_TIMEFRAME,
      strategies: normalizeStrategies(env.DEFAULT_STRATEGIES || DEFAULT_STRATEGIES),
      risk: Number(env.DEFAULT_RISK || 1),
      anchorBars: Number(env.DEFAULT_ANCHOR_BARS || 120),
    },
    request: { chatId, userId: telegramUserId(message), text },
  });
  await sendTelegram(env, chatId, analysisReportMessage(result));
  await addLog(env, origin, "Telegram analysis", tickers.join(", "), result.errors.length ? "partial" : "ok", `errors=${result.errors.length}`, country);
}

async function handleTelegramReportCommand(command, env, chatId, origin, country = "-", userId = "") {
  if (!command.tickers.length) {
    await sendTelegram(env, chatId, `Напишите команду с тикером, например: ${command.label} AAPL`);
    return;
  }

  await addLog(env, origin, command.label, command.tickers.join(", "), "started", "", country);
  await addTickerRequestLog(env, {
    origin,
    source: `telegram/${command.label}`,
    tickers: command.tickers,
    status: "received",
    country,
    chatId,
    userId,
    detail: command.label,
  });
  for (const ticker of command.tickers) {
    if (!isValidTicker(ticker)) {
      await sendTelegram(env, chatId, `${ticker}: ${tickerValidationError(ticker)}`);
      await addLog(env, origin, command.label, ticker, "error", tickerValidationError(ticker), country);
      continue;
    }

    const result = await runAnalysisOrchestrator(env, {
      source: `telegram/${command.label}`,
      origin,
      tickers: [ticker],
      config: {
        timeframe: env.DEFAULT_TIMEFRAME || DEFAULT_TIMEFRAME,
        strategies: normalizeStrategies(env.DEFAULT_STRATEGIES || DEFAULT_STRATEGIES),
        risk: Number(env.DEFAULT_RISK || 1),
        anchorBars: Number(env.DEFAULT_ANCHOR_BARS || 120),
      },
      request: { chatId, userId, command: command.label },
    });
    if (command.type === "fundrep") {
      const fundamentals = await fetchFundamentalData(ticker);
      const html = fundRepHtml(ticker, result, fundamentals);
      await sendTelegramDocument(env, chatId, `fundrep_${ticker}_${compactTimestamp(result.timestamp)}.html`, html, `FundRep ${ticker}: фундаментальный отчёт.`);
    } else {
      await sendTelegram(env, chatId, promtRepMessage(ticker, result));
    }
    await addLog(env, origin, command.label, ticker, result.errors.length ? "partial" : "ok", `errors=${result.errors.length}`, country);
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

  await ensureOrchestratorTables(env);
  const cached = await getAnalysisCache(env, `result:${fingerprint}`);
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
    const result = await runWithRetries(async () => analyzeTickers(tickers, config, env), ORCHESTRATOR_RETRY_LIMIT);
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

async function analyzeTickers(tickers, config, env = {}) {
  const rows = [];
  const errors = [];
  for (const ticker of tickers) {
    if (!isValidTicker(ticker)) {
      errors.push({ ticker, error: tickerValidationError(ticker), code: "INVALID_TICKER" });
      continue;
    }
    try {
      const candles = await runWithRetries(() => fetchCandles(ticker, config.timeframe, env), ORCHESTRATOR_RETRY_LIMIT);
      const row = analyzeTicker(ticker, candles, config);
      row.signals = row.signals.map((signal) => ({ ...signal, message: telegramSignalMessage(signal) }));
      rows.push(row);
    } catch (error) {
      errors.push({ ticker, error: error.message || String(error), code: error.code || "ANALYSIS_ERROR" });
    }
  }
  return {
    timestamp: new Date().toISOString(),
    timeframe: config.timeframe,
    rows,
    errors,
  };
}

async function fetchCandles(ticker, timeframe, env = {}) {
  const tf = TIMEFRAMES[timeframe] || TIMEFRAMES["1d"];
  const cacheKey = `market:${ticker}:${tf.interval}:${tf.range}`;
  const cachedCandles = await getAnalysisCache(env, cacheKey);
  if (cachedCandles) return cachedCandles;
  let data = null;
  let lastError = "";
  for (const symbol of yahooTickerCandidates(ticker)) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${tf.interval}&range=${tf.range}`;
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) {
      lastError = `${symbol}: Yahoo chart HTTP ${response.status}`;
      continue;
    }
    data = await response.json();
    if (data?.chart?.result?.[0]) break;
    lastError = `${symbol}: ${data?.chart?.error?.description || "нет рыночных данных"}`;
    data = null;
  }
  const result = data?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result || !quote || !Array.isArray(result.timestamp)) throw analysisError(lastError || "Нет рыночных данных", "NO_MARKET_DATA");

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

  if (config.strategies.includes("trend") && ema200 && price > ema200 && price > avwap) {
    signals.push(makeSignal(ticker, "Trend Following", "long", price, "цена выше EMA200 и выше AVWAP", "возможный long", price - atr * 2, price + atr * 3, config.risk));
  }
  if (config.strategies.includes("trend") && ema200 && price < ema200 && price < avwap) {
    signals.push(makeSignal(ticker, "Trend Following", "short", price, "цена ниже EMA200 и ниже AVWAP", "возможный short", price + atr * 2, price - atr * 3, config.risk));
  }
  if (config.strategies.includes("breakout") && price > high20) {
    signals.push(makeSignal(ticker, "Breakout Trading", "long", price, "пробой 20-свечного максимума", "импульсный long", price - atr * 1.8, price + atr * 3.2, config.risk));
  }
  if (config.strategies.includes("breakout") && price < low20) {
    signals.push(makeSignal(ticker, "Breakout Trading", "short", price, "пробой 20-свечного минимума", "импульсный short", price + atr * 1.8, price - atr * 3.2, config.risk));
  }
  if (config.strategies.includes("volume_avwap") && price > avwap && price > poc) {
    signals.push(makeSignal(ticker, "Volume Profile + AVWAP", "long", price, "цена выше AVWAP и выше POC", "покупатели удерживают контроль", Math.min(avwap, poc), price + atr * 2.5, config.risk));
  }
  if (config.strategies.includes("volume_avwap") && price < avwap && price < poc) {
    signals.push(makeSignal(ticker, "Volume Profile + AVWAP", "short", price, "цена ниже AVWAP и ниже POC", "продавцы удерживают контроль", Math.max(avwap, poc), price - atr * 2.5, config.risk));
  }
  if (config.strategies.includes("momentum") && roc20 > 5 && rsi > 55) {
    signals.push(makeSignal(ticker, "Momentum Trading", "long", price, `ROC20 ${roc20.toFixed(1)}% и RSI14 ${rsi.toFixed(0)}`, "моментум усиливается", price - atr * 2, price + atr * 3, config.risk));
  }
  if (config.strategies.includes("momentum") && roc20 < -5 && rsi < 45) {
    signals.push(makeSignal(ticker, "Momentum Trading", "short", price, `ROC20 ${roc20.toFixed(1)}% и RSI14 ${rsi.toFixed(0)}`, "моментум вниз усиливается", price + atr * 2, price - atr * 3, config.risk));
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

function analysisReportMessage(result) {
  const lines = [
    "📊 Отчёт анализа",
    "━━━━━━━━━━━━━━",
    "",
  ];

  for (const row of result.rows) {
    const arrow = row.direction === "up" ? "🟢⬆️" : row.direction === "down" ? "🔴⬇️" : "⚪➡️";
    const movement = `${row.change > 0 ? "+" : ""}${row.change.toFixed(2)} (${row.change_percent > 0 ? "+" : ""}${row.change_percent.toFixed(2)}%)`;
    lines.push(`${arrow} ${row.ticker}`);
    lines.push(`Цена: ${row.price.toFixed(2)}`);
    lines.push(`Движение: ${movement}`);
    lines.push(`EMA200: ${valueOrDash(row.ema200)}, AVWAP: ${valueOrDash(row.avwap)}, RSI: ${valueOrDash(row.rsi14)}`);
    lines.push(`ATR14: ${valueOrDash(row.atr14)}, MMA150: ${valueOrDash(row.mma150)}, от MMA150: ${distanceText(row.mma150_distance_percent)}`);
    if (row.signals.length) {
      lines.push("");
      lines.push("✅ Сигналы:");
      row.signals.forEach((signal, index) => {
        if (index > 0) lines.push("━━━━━━━━━━━━━━");
        const icon = signal.side === "long" ? "📈" : "📉";
        lines.push(`${icon} ${signal.side} / ${signal.strategy}`);
        lines.push(`Почему: ${signal.condition}. ${marketContext(row)}`);
        lines.push(`Условие: ${signal.condition}`);
        lines.push(`Идея: ${signal.idea}`);
        lines.push(`Стоп: ${signal.stop.toFixed(2)}`);
        lines.push(`Цель: ${signal.target.toFixed(2)}`);
        lines.push(`Риск: ${signal.risk}%`);
      });
    } else {
      lines.push("");
      lines.push("ℹ️ Нет сигнала:");
      lines.push(`Условия входа не подтвердились. ${marketContext(row)}`);
    }
    lines.push("");
  }

  if (result.errors.length) {
    const insufficient = result.errors.filter((error) => error.code === "INSUFFICIENT_DATA" || error.code === "NO_MARKET_DATA");
    const otherErrors = result.errors.filter((error) => !insufficient.includes(error));
    if (insufficient.length) {
      lines.push("━━━━━━━━━━━━━━");
      lines.push("ℹ️ Нет данных для анализа:");
      for (const error of insufficient) lines.push(`${error.ticker}: ${error.error}`);
    }
    if (otherErrors.length) {
      lines.push("━━━━━━━━━━━━━━");
      lines.push("⚠️ Ошибки:");
      for (const error of otherErrors) lines.push(`${error.ticker}: ${error.error}`);
    }
  }
  return lines.join("\n").trim();
}

function fundRepMessage(ticker, result) {
  const row = result.rows[0];
  if (!row) return reportErrorMessage("FundRep", ticker, result);
  const price = `${row.price.toFixed(2)} USD`;
  const na = "н/д";
  const lines = [
    `FundRep: фундаментальный отчёт по ${ticker}`,
    `Дата: ${result.timestamp}`,
    "Не является инвестиционной рекомендацией.",
    "━━━━━━━━━━━━━━",
    "",
    "1. Profitability / Прибыльность",
    "Компания реально зарабатывает деньги и становится ли бизнес эффективнее?",
    `Компания: ${ticker}`,
    `Текущая цена: ${price}`,
    "Рыночная цена нужна как отправная точка для сравнения с фундаментальными метриками.",
    `Revenue Growth / Рост выручки: ${na}`,
    "Показывает темп роста верхней строки. Ускорение роста обычно поддерживает оценку компании.",
    `Gross Margin / Валовая маржа: ${na}`,
    "Показывает ценовую силу продукта и эффективность себестоимости.",
    `Operating Margin / Операционная маржа: ${na}`,
    "Показывает прибыльность основного бизнеса после операционных расходов.",
    `Net Margin / Чистая маржа: ${na}`,
    "Показывает, сколько прибыли остаётся акционерам после всех расходов.",
    `EPS / Прибыль на акцию: ${na}`,
    `EBITDA: ${na}`,
    "",
    "2. Valuation / Оценка стоимости",
    "Хорошая ли это компания по разумной цене, или рынок уже заложил слишком много ожиданий?",
    `Market Cap / Капитализация: ${na}`,
    `P/E / Цена к прибыли: ${na}`,
    `Forward P/E / Будущий P/E: ${na}`,
    `CAPE / Cyclically Adjusted P/E: ${na}`,
    "CAPE сравнивает цену с усреднённой прибылью за длинный цикл. Полезен для проверки, не завышена ли оценка относительно нормализованной прибыли, но по отдельным компаниям часто доступен хуже, чем по индексам.",
    `P/S / Цена к выручке: ${na}`,
    `EV / EBITDA: ${na}`,
    `PEG Ratio: ${na}`,
    `P/B / Цена к балансовой стоимости: ${na}`,
    "",
    "3. Cash Flow / Денежный поток",
    "Настоящая ли прибыль, и превращается ли бизнес в реальные свободные деньги?",
    `Operating Cash Flow / OCF: ${na}`,
    `Free Cash Flow / FCF: ${na}`,
    `FCF Margin: ${na}`,
    `FCF Yield: ${na}`,
    "",
    "4. Financial Health / Финансовое здоровье",
    "Компания выдержит спад и сможет финансировать рост без разрушения баланса?",
    `Debt-to-Equity / D/E: ${na}`,
    `Total Cash / Денежные средства: ${na}`,
    `Total Debt / Общий долг: ${na}`,
    `Current Ratio: ${na}`,
    `ROE / Рентабельность капитала: ${na}`,
    `ROA / Рентабельность активов: ${na}`,
    "",
    "5. Forward Signals / Будущие сигналы",
    "Куда меняются ожидания по компании?",
    `Recommendation: ${na}`,
    `Target Mean Price: ${na}`,
    `Earnings Growth: ${na}`,
    `Revenue Growth: ${na}`,
    `Beta: ${na}`,
    `Dividend Yield: ${na}`,
    "",
    "Технический контекст:",
    `Движение: ${row.change > 0 ? "+" : ""}${row.change.toFixed(2)} (${row.change_percent > 0 ? "+" : ""}${row.change_percent.toFixed(2)}%)`,
    `EMA200: ${valueOrDash(row.ema200)}, AVWAP: ${valueOrDash(row.avwap)}, RSI: ${valueOrDash(row.rsi14)}, ROC20: ${valueOrDash(row.roc20)}%`,
    "",
    "Короткая шпаргалка: Profitability отвечает на вопрос о качестве прибыли; Valuation — о цене; Cash Flow — о реальных деньгах; Financial Health — о прочности баланса; Forward Signals — об ожиданиях рынка.",
  ];
  return lines.join("\n").trim();
}

async function fetchFundamentalData(ticker) {
  const safeTicker = encodeURIComponent(ticker);
  const modules = "price,summaryDetail,defaultKeyStatistics,financialData,assetProfile";
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${safeTicker}?modules=${modules}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!response.ok) throw new Error(`quoteSummary HTTP ${response.status}`);
    const data = await response.json();
    const result = data?.quoteSummary?.result?.[0];
    if (result) {
      return {
        ...result,
        fundrepDataStatus: "Фундаментальные данные Yahoo Finance получены.",
      };
    }
    throw new Error("quoteSummary empty");
  } catch (error) {
    try {
      const response = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${safeTicker}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!response.ok) throw new Error(`quote HTTP ${response.status}`);
      const data = await response.json();
      const quote = data?.quoteResponse?.result?.[0] || {};
      return {
        fundrepDataStatus: `quoteSummary недоступен: ${error.message || error}. Использованы доступные quote-данные.`,
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
      return {
        fundrepDataStatus: `Фундаментальные данные недоступны: ${fallbackError.message || fallbackError}.`,
      };
    }
  }
}

function fundRepHtml(ticker, result, fundamentals = {}) {
  const row = result.rows[0];
  if (!row) {
    return `<!doctype html><meta charset="utf-8"><title>FundRep ${escapeHtml(ticker)}</title><body><pre>${escapeHtml(reportErrorMessage("FundRep", ticker, result))}</pre></body>`;
  }

  const sections = fundRepSections(ticker, row, fundamentals);
  const sectionHtml = sections.map((section) => `
    <section>
      <h2>${escapeHtml(section.title)}</h2>
      <p class="question">${escapeHtml(section.question)}</p>
      <table>
        <thead><tr><th>Метрика</th><th>Значение</th><th>Объяснение</th></tr></thead>
        <tbody>
          ${section.metrics.map((metric) => `<tr><td>${escapeHtml(metric[0])}</td><td>${escapeHtml(metric[1])}</td><td>${escapeHtml(metric[2])}</td></tr>`).join("")}
        </tbody>
      </table>
    </section>
  `).join("");

  return `<!doctype html>
<html lang="ru">
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
  <h1>FundRep: фундаментальный отчёт по ${escapeHtml(ticker)}</h1>
  <p class="meta">Дата: ${escapeHtml(result.timestamp)} · ${escapeHtml(fundamentals.fundrepDataStatus || "Фундаментальные данные частично доступны.")} · Не является инвестиционной рекомендацией.</p>
  ${sectionHtml}
  <div class="note">Короткая шпаргалка: Profitability отвечает на вопрос о качестве прибыли; Valuation — о цене; Cash Flow — о реальных деньгах; Financial Health — о прочности баланса; Forward Signals — об ожиданиях рынка.</div>
</body>
</html>`;
}

function fundRepSections(ticker, row, data = {}) {
  const na = "н/д";
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
      title: "1. Profitability / Прибыльность",
      question: "Компания реально зарабатывает деньги и становится ли бизнес эффективнее?",
      metrics: [
        ["Компания", fmtMetric(metricValue(data, "price", "shortName") || ticker), `Тикер: ${ticker}. Сектор: ${fmtMetric(metricValue(data, "assetProfile", "sector"))}. Индустрия: ${fmtMetric(metricValue(data, "assetProfile", "industry"))}.`],
        ["Текущая цена", price, "Рыночная цена нужна как отправная точка для сравнения с фундаментальными метриками."],
        ["Revenue Growth / Рост выручки", fmtPercent(metricValue(data, "financialData", "revenueGrowth")), "Показывает темп роста верхней строки. Ускорение роста обычно поддерживает оценку компании."],
        ["Gross Margin / Валовая маржа", fmtPercent(metricValue(data, "financialData", "grossMargins")), "Показывает ценовую силу продукта и эффективность себестоимости."],
        ["Operating Margin / Операционная маржа", fmtPercent(metricValue(data, "financialData", "operatingMargins")), "Показывает прибыльность основного бизнеса после операционных расходов."],
        ["Net Margin / Чистая маржа", fmtPercent(metricValue(data, "financialData", "profitMargins")), "Показывает, сколько прибыли остаётся акционерам после всех расходов."],
        ["EPS / Прибыль на акцию", fmtMetric(metricValue(data, "defaultKeyStatistics", "trailingEps")), "EPS показывает прибыль, приходящуюся на одну акцию."],
        ["EBITDA", fmtMoney(metricValue(data, "financialData", "ebitda")), "Грубая оценка операционной денежной генерации до процентов, налогов и амортизации."],
      ],
    },
    {
      title: "2. Valuation / Оценка стоимости",
      question: "Хорошая ли это компания по разумной цене, или рынок уже заложил слишком много ожиданий?",
      metrics: [
        ["Market Cap / Капитализация", fmtMoney(marketCap), "Размер компании на рынке. Важно сравнивать с выручкой, прибылью и денежным потоком."],
        ["P/E / Цена к прибыли", fmtMetric(metricValue(data, "summaryDetail", "trailingPE")), "Показывает, сколько инвестор платит за доллар текущей прибыли."],
        ["Forward P/E / Будущий P/E", fmtMetric(metricValue(data, "summaryDetail", "forwardPE")), "Использует ожидаемую прибыль и полезен для растущих компаний, но зависит от прогнозов."],
        ["CAPE / Cyclically Adjusted P/E", na, "CAPE сравнивает цену с усреднённой прибылью за длинный цикл. Он помогает увидеть оценку относительно нормализованной прибыли, но для отдельных компаний часто доступен хуже, чем для индексов."],
        ["P/S / Цена к выручке", fmtMetric(metricValue(data, "summaryDetail", "priceToSalesTrailing12Months")), "Особенно полезен для компаний, где прибыль пока нестабильна."],
        ["EV / EBITDA", fmtMetric(metricValue(data, "defaultKeyStatistics", "enterpriseToEbitda")), "Сравнивает стоимость предприятия с EBITDA и учитывает долг."],
        ["PEG Ratio", fmtMetric(metricValue(data, "defaultKeyStatistics", "pegRatio")), "Сравнивает P/E с темпом роста прибыли. Ниже 1 часто выглядит интереснее, но не является автоматическим сигналом."],
        ["P/B / Цена к балансовой стоимости", fmtMetric(metricValue(data, "defaultKeyStatistics", "priceToBook")), "Полезно для банков, страховых и капиталоёмких бизнесов."],
      ],
    },
    {
      title: "3. Cash Flow / Денежный поток",
      question: "Настоящая ли прибыль, и превращается ли бизнес в реальные свободные деньги?",
      metrics: [
        ["Operating Cash Flow / OCF", fmtMoney(metricValue(data, "financialData", "operatingCashflow")), "Деньги, которые компания генерирует основной деятельностью."],
        ["Free Cash Flow / FCF", fmtMoney(freeCashflow), "Деньги после капитальных расходов, доступные для buybacks, дивидендов, долга или роста."],
        ["FCF Margin", fmtPercent(fcfMargin), "FCF margin = FCF / выручка. Если данных выручки недостаточно, показатель нужно досчитать из отчётности."],
        ["FCF Yield", fmtPercent(fcfYield), "FCF yield = FCF / market cap. Помогает понять доходность свободного денежного потока относительно цены компании."],
      ],
    },
    {
      title: "4. Financial Health / Финансовое здоровье",
      question: "Компания выдержит спад и сможет финансировать рост без разрушения баланса?",
      metrics: [
        ["Debt-to-Equity / D/E", fmtMetric(metricValue(data, "financialData", "debtToEquity")), "Показывает финансовый рычаг и риск зависимости от долга."],
        ["Total Cash / Денежные средства", fmtMoney(metricValue(data, "financialData", "totalCash")), "Запас ликвидности для кризиса, инвестиций, buybacks и погашения долга."],
        ["Total Debt / Общий долг", fmtMoney(metricValue(data, "financialData", "totalDebt")), "Важно сравнивать с cash, EBITDA и денежным потоком."],
        ["Current Ratio", fmtMetric(metricValue(data, "financialData", "currentRatio")), "Показывает способность закрывать ближайшие обязательства текущими активами."],
        ["ROE / Рентабельность капитала", fmtPercent(metricValue(data, "financialData", "returnOnEquity")), "Показывает эффективность использования капитала акционеров."],
        ["ROA / Рентабельность активов", fmtPercent(metricValue(data, "financialData", "returnOnAssets")), "Показывает эффективность использования всех активов компании."],
      ],
    },
    {
      title: "5. Forward Signals / Будущие сигналы",
      question: "Куда меняются ожидания по компании?",
      metrics: [
        ["Recommendation", fmtMetric(metricValue(data, "financialData", "recommendationKey")), "Сводная рекомендация аналитиков, если источник её предоставляет."],
        ["Target Mean Price", fmtMetric(metricValue(data, "financialData", "targetMeanPrice")), "Средняя целевая цена аналитиков. Это ориентир ожиданий, а не гарантия."],
        ["Earnings Growth", fmtPercent(metricValue(data, "financialData", "earningsGrowth")), "Рост прибыли поддерживает переоценку, если ожидания подтверждаются."],
        ["Revenue Growth", fmtPercent(metricValue(data, "financialData", "revenueGrowth")), "Рост выручки показывает направление спроса на продукт или услугу."],
        ["Beta", fmtMetric(metricValue(data, "summaryDetail", "beta")), "Показывает чувствительность акции к рынку. Выше 1 означает более высокую волатильность."],
        ["Dividend Yield", fmtPercent(metricValue(data, "summaryDetail", "dividendYield")), "Доходность дивидендов важна для компаний, где часть инвестиционной идеи связана с выплатами."],
        ["Технический контекст", `Движение: ${movement}`, `EMA200: ${valueOrDash(row.ema200)}, AVWAP: ${valueOrDash(row.avwap)}, ATR14: ${valueOrDash(row.atr14)}, MMA150: ${valueOrDash(row.mma150)}, от MMA150: ${distanceText(row.mma150_distance_percent)}, RSI: ${valueOrDash(row.rsi14)}, ROC20: ${valueOrDash(row.roc20)}%.`],
      ],
    },
  ];
}

function promtRepMessage(ticker, result) {
  const row = result.rows[0];
  if (!row) return reportErrorMessage("PromtRep", ticker, result);
  return [
    `🧠 PromtRep ${ticker}`,
    "━━━━━━━━━━━━━━",
    "",
    "Скопируй этот промт в Perplexity Finance:",
    "",
    `Подготовь профессиональный PDF-отчёт по тикеру ${ticker}.`,
    "Структура отчёта:",
    "1. Income Statement: выручка, маржа, прибыль, динамика и причины изменений.",
    "2. Momentum: тренд цены, относительная сила, RSI, объём и ключевые уровни.",
    "3. Valuation History: мультипликаторы, сравнение с историей и сектором.",
    "   В Valuation History отдельно добавь CAPE / Cyclically Adjusted P/E: объясни метод расчёта, ограничения для отдельной компании и вывод по нормализованной прибыли.",
    "4. Capital & Conviction: баланс, долги, buybacks, insider/institutional activity.",
    "",
    "Текущие технические вводные:",
    `Цена: ${row.price.toFixed(2)}`,
    `Движение: ${row.change > 0 ? "+" : ""}${row.change.toFixed(2)} (${row.change_percent > 0 ? "+" : ""}${row.change_percent.toFixed(2)}%)`,
    `EMA200: ${valueOrDash(row.ema200)}, AVWAP: ${valueOrDash(row.avwap)}, RSI: ${valueOrDash(row.rsi14)}, ROC20: ${valueOrDash(row.roc20)}%`,
    "",
    "Для каждого KPI объясни: что значит показатель, почему он изменился, на что влияет для инвестора и что отслеживать дальше. Итог должен выглядеть как современный аналитический dashboard с графиками, KPI-карточками и кратким инвестиционным выводом.",
  ].join("\n").trim();
}

function reportErrorMessage(label, ticker, result) {
  const error = result.errors[0]?.error || "не удалось получить данные";
  return `⚠️ ${label} ${ticker}\n━━━━━━━━━━━━━━\n${error}`;
}

function telegramSignalMessage(signal) {
  const icon = signal.side === "long" ? "📈" : "📉";
  return [
    `${icon} Сигнал по ${signal.ticker}`,
    "",
    `Стратегия: ${signal.strategy}`,
    `Цена: ${signal.price.toFixed(2)}`,
    `Условие: ${signal.condition}`,
    `Идея: ${signal.idea}`,
    `Стоп: ${signal.stop.toFixed(2)}`,
    `Цель: ${signal.target.toFixed(2)}`,
    `Риск: ${signal.risk}%`,
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
    news: normalizeNews(payload.news),
    tickers,
    timeframe: analysis.timeframe || payload.timeframe || env.DEFAULT_TIMEFRAME || DEFAULT_TIMEFRAME,
    strategies: normalizeStrategies(analysis.strategies || payload.strategies || env.DEFAULT_STRATEGIES || DEFAULT_STRATEGIES),
    risk: Number(analysis.risk || payload.risk || env.DEFAULT_RISK || 1),
    anchorBars: Number(analysis.anchorBars || payload.anchorBars || env.DEFAULT_ANCHOR_BARS || 120),
    delivery: {
      sendToTelegram: delivery.sendToTelegram !== false,
      messageOrder: delivery.messageOrder || "news_then_analysis",
      async: delivery.async === true || payload.async === true,
    },
  };
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
  const news = normalized.news;
  const country = normalized.country?.name || normalized.country?.iso2 || "-";
  const tickers = normalized.tickers.map((ticker) => {
    const suffix = ticker.companyName ? ` (${ticker.companyName})` : "";
    return `${ticker.symbol}${suffix}`;
  }).join(", ");
  return [
    "Market news",
    "--------------",
    `Country: ${country}`,
    news.source ? `Source: ${news.source}` : "",
    news.publishedAt ? `Published: ${news.publishedAt}` : "",
    "",
    news.title,
    news.summary ? `\n${news.summary}` : "",
    news.url ? `\n${news.url}` : "",
    "",
    `Tickers: ${tickers || "-"}`,
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
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_analysis_tasks_created ON analysis_tasks(created_at)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_analysis_tasks_status ON analysis_tasks(status)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_analysis_cache_expires ON analysis_cache(expires_at)").run();
}

async function getAnalysisCache(env, cacheKey) {
  if (!env.DB) return null;
  await ensureOrchestratorTables(env);
  const row = await env.DB.prepare(
    "SELECT payload_json, expires_at FROM analysis_cache WHERE cache_key = ?"
  ).bind(cacheKey).first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await env.DB.prepare("DELETE FROM analysis_cache WHERE cache_key = ?").bind(cacheKey).run();
    return null;
  }
  try {
    return JSON.parse(row.payload_json);
  } catch {
    return null;
  }
}

async function setAnalysisCache(env, cacheKey, kind, payload, ttlSeconds) {
  if (!env.DB) return;
  await ensureOrchestratorTables(env);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO analysis_cache (cache_key, kind, payload_json, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET kind=excluded.kind, payload_json=excluded.payload_json, expires_at=excluded.expires_at, updated_at=excluded.updated_at`
  ).bind(cacheKey, kind, JSON.stringify(payload), expiresAt, now, now).run();
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
  const cleaned = text.replace(/^\/start\b/i, "").replace(/^\/analyze\b/i, "").trim();
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
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return DEFAULT_STRATEGIES;
}

function stringOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

async function readJson(request) {
  if (!request.headers.get("content-type")?.includes("application/json")) return {};
  return request.json();
}

function assertWebhookToken(request, env, payload) {
  const expected = String(env.WEBHOOK_TOKEN || "").trim();
  if (!expected) throw httpError("WEBHOOK_TOKEN Ð½Ðµ Ð·Ð°Ð´Ð°Ð½", 500);
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  const provided = request.headers.get("X-Scanner-Token") || bearer || payload.token || payload.apiToken || "";
  if (provided !== expected) throw httpError("ÐÐµÐ²ÐµÑ€Ð½Ñ‹Ð¹ Webhook/API token", 403);
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
  if (value == null || value === "" || Number.isNaN(value)) return "н/д";
  if (value && typeof value === "object") {
    if ("raw" in value) return fmtMetric(value.raw);
    if ("fmt" in value) return String(value.fmt);
    return "н/д";
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

function marketContext(row) {
  const trend = row.ema200 == null ? "EMA200 לא זמין" : row.price > row.ema200 ? "מחיר מעל EMA200" : row.price < row.ema200 ? "מחיר מתחת EMA200" : "מחיר ליד EMA200";
  const meanDistance = row.mma150_distance_percent == null ? "מרחק מ-MMA150 לא זמין" : `מרחק מ-MMA150: ${distanceText(row.mma150_distance_percent)}`;
  const momentum = row.rsi14 >= 55 ? "מומנטום חיובי" : row.rsi14 <= 45 ? "מומנטום שלילי" : "מומנטום ניטרלי";
  return `${trend}; ${meanDistance}; RSI ${valueOrDash(row.rsi14)} (${momentum}); ATR14 ${valueOrDash(row.atr14)}.`;
}

function distanceText(value) {
  if (value == null || Number.isNaN(value)) return "-";
  return `${value > 0 ? "+" : ""}${round(value, 2)}%`;
}

function normalizeAnalysisConfig(config = {}) {
  return {
    timeframe: config.timeframe || DEFAULT_TIMEFRAME,
    strategies: normalizeStrategies(config.strategies || DEFAULT_STRATEGIES),
    risk: Number(config.risk || 1),
    anchorBars: Number(config.anchorBars || 120),
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
      if (error.code === "INVALID_TICKER" || error.code === "INSUFFICIENT_DATA") break;
      if (attempt < retryLimit) await sleep(120 * (attempt + 1));
    }
  }
  throw lastError;
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

