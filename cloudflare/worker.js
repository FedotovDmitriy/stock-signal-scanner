const DEFAULT_TIMEFRAME = "1d";
const DEFAULT_STRATEGIES = ["trend", "breakout", "volume_avwap", "momentum"];
const MAX_TICKER_LENGTH = 12;
const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-=]{0,11}$/;

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
          endpoints: ["/api/status", "/api/external/analyze", "/api/webhook/analyze", "/api/test-telegram", "/api/clear-logs", "/telegram/webhook"],
        });
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        const logs = await latestLogs(env);
        const stats = await latestStats(env);
        return json({
          ok: true,
          environment: env.APP_ENV || "dev",
          time: new Date().toISOString(),
          defaultTimeframe: env.DEFAULT_TIMEFRAME || DEFAULT_TIMEFRAME,
          worker: "online",
          logs,
          stats,
        });
      }
      if (request.method === "POST" && ["/api/external/analyze", "/api/webhook/analyze"].includes(url.pathname)) {
        const payload = await readJson(request);
        assertWebhookToken(request, env, payload);
        const result = await runAnalysisFromPayload(payload, env, `external ip=${clientIp(request)}`);
        return json(result);
      }
      if (request.method === "POST" && url.pathname === "/api/test-telegram") {
        const payload = await readJson(request);
        assertWebhookToken(request, env, payload);
        const normalized = normalizeExternalPayload(payload, env);
        const chatId = String(payload.telegramChatId || payload.chatId || env.TELEGRAM_CHAT_ID || "").trim();
        if (!chatId) throw httpError("telegramChatId is required for test message", 400);
        await sendTelegram(env, chatId, `Stock Signal Scanner test\nEnvironment: ${env.APP_ENV || "dev"}\nTime: ${new Date().toISOString()}`, normalized.bot);
        await addLog(env, `ui ip=${clientIp(request)}`, "Telegram test", "-", "ok", `bot=${normalized.bot.id || "-"}`);
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

async function runAnalysisFromPayload(payload, env, origin) {
  const normalized = normalizeExternalPayload(payload, env);
  const tickers = normalized.tickers.map((ticker) => ticker.symbol);
  if (!tickers.length) throw httpError("ÐŸÐµÑ€ÐµÐ´Ð°Ð¹Ñ‚Ðµ ticker Ð¸Ð»Ð¸ tickers", 400);

  const { timeframe, strategies, risk, anchorBars, chatId, country, bot, news, delivery } = normalized;
  const requestKey = normalized.requestId || news?.id || crypto.randomUUID();
  const newsId = news?.id || (news ? requestKey : null);

  await addLog(env, origin, "External analysis", tickers.join(", "), "started", `timeframe=${timeframe}; request=${requestKey}`);
  if (env.DB) await storeMatcherPayload(env, normalized, newsId);
  const result = await analyzeTickers(tickers, { timeframe, strategies, risk, anchorBars });
  result.origin = origin;
  result.requestId = normalized.requestId || null;
  result.country = country;
  result.bot = bot;
  result.news = news;

  if (chatId && delivery.sendToTelegram) {
    if (news) await sendTelegram(env, chatId, newsMessage(normalized), bot);
    await sendTelegram(env, chatId, analysisReportMessage(result), bot);
    result.sent = [{ ticker: "ALL", strategy: "Analysis report", side: "report" }];
  } else {
    result.sent = [];
  }

  await addLog(
    env,
    origin,
    "External analysis",
    tickers.join(", "),
    result.errors.length ? "partial" : "ok",
    `errors=${result.errors.length}; signals=${countSignals(result.rows)}`
  );
  return result;
}

async function handleTelegramUpdate(update, env, request) {
  const message = update.message || update.edited_message || {};
  const chat = message.chat || {};
  const chatId = String(chat.id || "");
  const text = String(message.text || "").trim();
  const origin = telegramOrigin(message, request);
  if (!chatId || !text) return;

  const reportCommand = parseTelegramReportCommand(text);
  if (reportCommand) {
    await handleTelegramReportCommand(reportCommand, env, chatId, origin);
    return;
  }

  const tickers = parseTelegramText(text);
  if (!tickers.length) {
    await sendTelegram(env, chatId, "Напишите тикер или список тикеров: AAPL или AAPL, MSFT");
    return;
  }

  await addLog(env, origin, "Telegram analysis", tickers.join(", "), "started", "");
  const result = await analyzeTickers(tickers, {
    timeframe: env.DEFAULT_TIMEFRAME || DEFAULT_TIMEFRAME,
    strategies: normalizeStrategies(env.DEFAULT_STRATEGIES || DEFAULT_STRATEGIES),
    risk: Number(env.DEFAULT_RISK || 1),
    anchorBars: Number(env.DEFAULT_ANCHOR_BARS || 120),
  });
  await sendTelegram(env, chatId, analysisReportMessage(result));
  await addLog(env, origin, "Telegram analysis", tickers.join(", "), result.errors.length ? "partial" : "ok", `errors=${result.errors.length}`);
}

async function handleTelegramReportCommand(command, env, chatId, origin) {
  if (!command.tickers.length) {
    await sendTelegram(env, chatId, `Напишите команду с тикером, например: ${command.label} AAPL`);
    return;
  }

  await addLog(env, origin, command.label, command.tickers.join(", "), "started", "");
  for (const ticker of command.tickers) {
    if (!isValidTicker(ticker)) {
      await sendTelegram(env, chatId, `${ticker}: ${tickerValidationError(ticker)}`);
      await addLog(env, origin, command.label, ticker, "error", tickerValidationError(ticker));
      continue;
    }

    const result = await analyzeTickers([ticker], {
      timeframe: env.DEFAULT_TIMEFRAME || DEFAULT_TIMEFRAME,
      strategies: normalizeStrategies(env.DEFAULT_STRATEGIES || DEFAULT_STRATEGIES),
      risk: Number(env.DEFAULT_RISK || 1),
      anchorBars: Number(env.DEFAULT_ANCHOR_BARS || 120),
    });
    const text = command.type === "fundrep" ? fundRepMessage(ticker, result) : promtRepMessage(ticker, result);
    await sendTelegram(env, chatId, text);
    await addLog(env, origin, command.label, ticker, result.errors.length ? "partial" : "ok", `errors=${result.errors.length}`);
  }
}

async function analyzeTickers(tickers, config) {
  const rows = [];
  const errors = [];
  for (const ticker of tickers) {
    if (!isValidTicker(ticker)) {
      errors.push({ ticker, error: tickerValidationError(ticker) });
      continue;
    }
    try {
      const candles = await fetchCandles(ticker, config.timeframe);
      const row = analyzeTicker(ticker, candles, config);
      row.signals = row.signals.map((signal) => ({ ...signal, message: telegramSignalMessage(signal) }));
      rows.push(row);
    } catch (error) {
      errors.push({ ticker, error: error.message || String(error) });
    }
  }
  return {
    timestamp: new Date().toISOString(),
    timeframe: config.timeframe,
    rows,
    errors,
  };
}

async function fetchCandles(ticker, timeframe) {
  const tf = TIMEFRAMES[timeframe] || TIMEFRAMES["1d"];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${tf.interval}&range=${tf.range}`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`Yahoo chart HTTP ${response.status}`);
  const data = await response.json();
  const result = data?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result || !quote || !Array.isArray(result.timestamp)) throw new Error("ÐÐµÑ‚ Ñ€Ñ‹Ð½Ð¾Ñ‡Ð½Ñ‹Ñ… Ð´Ð°Ð½Ð½Ñ‹Ñ…");

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
  if (candles.length < 60) throw new Error("ÐÐµÐ´Ð¾ÑÑ‚Ð°Ñ‚Ð¾Ñ‡Ð½Ð¾ ÑÐ²ÐµÑ‡ÐµÐ¹ Ð´Ð»Ñ Ð°Ð½Ð°Ð»Ð¸Ð·Ð°");
  return candles;
}

function analyzeTicker(ticker, candles, config) {
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2] || latest;
  const closes = candles.map((candle) => candle.close);
  const price = latest.close;
  const ema200 = ema(closes, 200);
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
    avwap: round(avwap, 2),
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
  const signalCount = countSignals(result.rows);
  const lines = [
    "📊 Отчёт анализа",
    "━━━━━━━━━━━━━━",
    "",
    `Время: ${result.timestamp}`,
    `Таймфрейм: ${result.timeframe}`,
    `Тикеров: ${result.rows.length}`,
    `Сигналов: ${signalCount}`,
    "",
  ];

  for (const row of result.rows) {
    const arrow = row.direction === "up" ? "🟩⬆️" : row.direction === "down" ? "🟥⬇️" : "⬜➡️";
    const movement = `${row.change > 0 ? "+" : ""}${row.change.toFixed(2)} (${row.change_percent > 0 ? "+" : ""}${row.change_percent.toFixed(2)}%)`;
    lines.push(`${arrow} ${row.ticker}`);
    lines.push(`Цена: ${row.price.toFixed(2)}`);
    lines.push(`Движение: ${movement}`);
    lines.push(`EMA200: ${valueOrDash(row.ema200)}, AVWAP: ${valueOrDash(row.avwap)}, RSI: ${valueOrDash(row.rsi14)}`);
    if (row.signals.length) {
      lines.push("");
      lines.push("✅ Сигналы:");
      row.signals.forEach((signal, index) => {
        if (index > 0) lines.push("━━━━━━━━━━━━━━");
        const icon = signal.side === "long" ? "📈" : "📉";
        lines.push(`${icon} ${signal.side} / ${signal.strategy}`);
        lines.push(`Условие: ${signal.condition}`);
        lines.push(`Идея: ${signal.idea}`);
        lines.push(`Стоп: ${signal.stop.toFixed(2)}`);
        lines.push(`Цель: ${signal.target.toFixed(2)}`);
        lines.push(`Риск: ${signal.risk}%`);
      });
    } else {
      lines.push("");
      lines.push("Сигналы: нет");
    }
    lines.push("");
  }

  if (result.errors.length) {
    lines.push("━━━━━━━━━━━━━━");
    lines.push("⚠️ Ошибки:");
    for (const error of result.errors) lines.push(`${error.ticker}: ${error.error}`);
  }
  return lines.join("\n").trim();
}

function fundRepMessage(ticker, result) {
  const row = result.rows[0];
  if (!row) return reportErrorMessage("FundRep", ticker, result);
  const trend = row.price > row.ema200 && row.price > row.avwap ? "бычий" : row.price < row.ema200 && row.price < row.avwap ? "медвежий" : "нейтральный";
  const movement = `${row.change > 0 ? "+" : ""}${row.change.toFixed(2)} (${row.change_percent > 0 ? "+" : ""}${row.change_percent.toFixed(2)}%)`;
  const bestSignals = row.signals.slice(0, 4);
  const lines = [
    `📘 FundRep ${ticker}`,
    "━━━━━━━━━━━━━━",
    "",
    `Время: ${result.timestamp}`,
    `Цена: ${row.price.toFixed(2)}`,
    `Движение: ${movement}`,
    `Тренд: ${trend}`,
    "",
    "Ключевые метрики:",
    `EMA200: ${valueOrDash(row.ema200)}`,
    `AVWAP: ${valueOrDash(row.avwap)}`,
    `RSI: ${valueOrDash(row.rsi14)}`,
    `ROC20: ${valueOrDash(row.roc20)}%`,
    "",
    "Вывод:",
    row.signals.length ? "Есть технические сигналы, требующие проверки на новостях, отчётности и рисках компании." : "Явных технических сигналов нет; лучше ждать подтверждения тренда и объёма.",
  ];
  if (bestSignals.length) {
    lines.push("", "Сигналы:");
    bestSignals.forEach((signal, index) => {
      if (index > 0) lines.push("━━━━━━━━━━━━━━");
      lines.push(`${signal.side === "long" ? "📈" : "📉"} ${signal.side} / ${signal.strategy}`);
      lines.push(`Условие: ${signal.condition}`);
      lines.push(`Идея: ${signal.idea}`);
      lines.push(`Стоп: ${signal.stop.toFixed(2)}`);
      lines.push(`Цель: ${signal.target.toFixed(2)}`);
    });
  }
  return lines.join("\n").trim();
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
    chatId: String(payload.telegramChatId || payload.chatId || env.TELEGRAM_CHAT_ID || "").trim(),
    news: normalizeNews(payload.news),
    tickers,
    timeframe: analysis.timeframe || payload.timeframe || env.DEFAULT_TIMEFRAME || DEFAULT_TIMEFRAME,
    strategies: normalizeStrategies(analysis.strategies || payload.strategies || env.DEFAULT_STRATEGIES || DEFAULT_STRATEGIES),
    risk: Number(analysis.risk || payload.risk || env.DEFAULT_RISK || 1),
    anchorBars: Number(analysis.anchorBars || payload.anchorBars || env.DEFAULT_ANCHOR_BARS || 120),
    delivery: {
      sendToTelegram: delivery.sendToTelegram !== false,
      messageOrder: delivery.messageOrder || "news_then_analysis",
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

async function addLog(env, origin, action, tickers, status, detail = "") {
  if (!env.DB) return;
  await env.DB.prepare(
    "INSERT INTO request_logs (time, origin, action, tickers, status, detail) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(new Date().toISOString(), origin, action, tickers, status, detail).run();
}

async function latestLogs(env) {
  if (!env.DB) return [];
  const result = await env.DB.prepare(
    "SELECT time, origin, action, tickers, status, detail FROM request_logs ORDER BY id DESC LIMIT 80"
  ).all();
  return result.results || [];
}

async function latestStats(env) {
  if (!env.DB) return { logs: 0, news: 0, tickers: 0 };
  const [logs, news, tickers] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM request_logs").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM news_items").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM news_tickers").first(),
  ]);
  return {
    logs: Number(logs?.count || 0),
    news: Number(news?.count || 0),
    tickers: Number(tickers?.count || 0),
  };
}

async function clearLogs(env) {
  if (!env.DB) return;
  await env.DB.prepare("DELETE FROM request_logs").run();
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) current = value * k + current * (1 - k);
  return current;
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

function telegramOrigin(message, request) {
  const chat = message.chat || {};
  const user = message.from || {};
  const name = [user.first_name || chat.first_name || "", user.last_name || chat.last_name || ""].filter(Boolean).join(" ") || "-";
  return `telegram chat_id=${chat.id || "-"}; type=${chat.type || "-"}; user_id=${user.id || "-"}; username=@${user.username || chat.username || "-"}; name=${name}; lang=${user.language_code || "-"}; ip=${clientIp(request)}`;
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "-";
}

function countSignals(rows) {
  return rows.reduce((sum, row) => sum + (row.signals?.length || 0), 0);
}

function valueOrDash(value) {
  return value == null || Number.isNaN(value) ? "-" : value;
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Scanner-Token",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

