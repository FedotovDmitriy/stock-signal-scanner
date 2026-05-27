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
      if (request.method === "GET" && url.pathname === "/") {
        return json({
          ok: true,
          service: "stock-signal-scanner-cloudflare",
          endpoints: ["/api/external/analyze", "/api/webhook/analyze", "/telegram/webhook"],
        });
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        const logs = await latestLogs(env);
        return json({ ok: true, environment: env.APP_ENV || "dev", time: new Date().toISOString(), logs });
      }
      if (request.method === "POST" && ["/api/external/analyze", "/api/webhook/analyze"].includes(url.pathname)) {
        const payload = await readJson(request);
        assertWebhookToken(request, env, payload);
        const result = await runAnalysisFromPayload(payload, env, `external ip=${clientIp(request)}`);
        return json(result);
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
  const tickers = parseTickers(payload.tickers ?? payload.ticker ?? "");
  if (!tickers.length) throw httpError("ÐŸÐµÑ€ÐµÐ´Ð°Ð¹Ñ‚Ðµ ticker Ð¸Ð»Ð¸ tickers", 400);

  const timeframe = payload.timeframe || env.DEFAULT_TIMEFRAME || DEFAULT_TIMEFRAME;
  const strategies = normalizeStrategies(payload.strategies || env.DEFAULT_STRATEGIES || DEFAULT_STRATEGIES);
  const risk = Number(payload.risk || env.DEFAULT_RISK || 1);
  const anchorBars = Number(payload.anchorBars || env.DEFAULT_ANCHOR_BARS || 120);
  const chatId = String(payload.telegramChatId || payload.chatId || env.TELEGRAM_CHAT_ID || "").trim();

  await addLog(env, origin, "External analysis", tickers.join(", "), "started", `timeframe=${timeframe}`);
  const result = await analyzeTickers(tickers, { timeframe, strategies, risk, anchorBars });
  result.origin = origin;

  if (chatId) {
    await sendTelegram(env, chatId, analysisReportMessage(result));
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

  const tickers = parseTelegramText(text);
  if (!tickers.length) {
    await sendTelegram(env, chatId, "ÐÐ°Ð¿Ð¸ÑˆÐ¸Ñ‚Ðµ Ñ‚Ð¸ÐºÐµÑ€ Ð¸Ð»Ð¸ ÑÐ¿Ð¸ÑÐ¾Ðº Ñ‚Ð¸ÐºÐµÑ€Ð¾Ð²: AAPL Ð¸Ð»Ð¸ AAPL, MSFT");
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
    signals.push(makeSignal(ticker, "Trend Following", "long", price, "Ñ†ÐµÐ½Ð° Ð²Ñ‹ÑˆÐµ EMA200 Ð¸ Ð²Ñ‹ÑˆÐµ AVWAP", "Ð²Ð¾Ð·Ð¼Ð¾Ð¶Ð½Ñ‹Ð¹ long", price - atr * 2, price + atr * 3, config.risk));
  }
  if (config.strategies.includes("trend") && ema200 && price < ema200 && price < avwap) {
    signals.push(makeSignal(ticker, "Trend Following", "short", price, "Ñ†ÐµÐ½Ð° Ð½Ð¸Ð¶Ðµ EMA200 Ð¸ Ð½Ð¸Ð¶Ðµ AVWAP", "Ð²Ð¾Ð·Ð¼Ð¾Ð¶Ð½Ñ‹Ð¹ short", price + atr * 2, price - atr * 3, config.risk));
  }
  if (config.strategies.includes("breakout") && price > high20) {
    signals.push(makeSignal(ticker, "Breakout Trading", "long", price, "Ð¿Ñ€Ð¾Ð±Ð¾Ð¹ 20-ÑÐ²ÐµÑ‡Ð½Ð¾Ð³Ð¾ Ð¼Ð°ÐºÑÐ¸Ð¼ÑƒÐ¼Ð°", "Ð¸Ð¼Ð¿ÑƒÐ»ÑŒÑÐ½Ñ‹Ð¹ long", price - atr * 1.8, price + atr * 3.2, config.risk));
  }
  if (config.strategies.includes("breakout") && price < low20) {
    signals.push(makeSignal(ticker, "Breakout Trading", "short", price, "Ð¿Ñ€Ð¾Ð±Ð¾Ð¹ 20-ÑÐ²ÐµÑ‡Ð½Ð¾Ð³Ð¾ Ð¼Ð¸Ð½Ð¸Ð¼ÑƒÐ¼Ð°", "Ð¸Ð¼Ð¿ÑƒÐ»ÑŒÑÐ½Ñ‹Ð¹ short", price + atr * 1.8, price - atr * 3.2, config.risk));
  }
  if (config.strategies.includes("volume_avwap") && price > avwap && price > poc) {
    signals.push(makeSignal(ticker, "Volume Profile + AVWAP", "long", price, "Ñ†ÐµÐ½Ð° Ð²Ñ‹ÑˆÐµ AVWAP Ð¸ Ð²Ñ‹ÑˆÐµ POC", "Ð¿Ð¾ÐºÑƒÐ¿Ð°Ñ‚ÐµÐ»Ð¸ ÑƒÐ´ÐµÑ€Ð¶Ð¸Ð²Ð°ÑŽÑ‚ ÐºÐ¾Ð½Ñ‚Ñ€Ð¾Ð»ÑŒ", Math.min(avwap, poc), price + atr * 2.5, config.risk));
  }
  if (config.strategies.includes("volume_avwap") && price < avwap && price < poc) {
    signals.push(makeSignal(ticker, "Volume Profile + AVWAP", "short", price, "Ñ†ÐµÐ½Ð° Ð½Ð¸Ð¶Ðµ AVWAP Ð¸ Ð½Ð¸Ð¶Ðµ POC", "Ð¿Ñ€Ð¾Ð´Ð°Ð²Ñ†Ñ‹ ÑƒÐ´ÐµÑ€Ð¶Ð¸Ð²Ð°ÑŽÑ‚ ÐºÐ¾Ð½Ñ‚Ñ€Ð¾Ð»ÑŒ", Math.max(avwap, poc), price - atr * 2.5, config.risk));
  }
  if (config.strategies.includes("momentum") && roc20 > 5 && rsi > 55) {
    signals.push(makeSignal(ticker, "Momentum Trading", "long", price, `ROC20 ${roc20.toFixed(1)}% Ð¸ RSI14 ${rsi.toFixed(0)}`, "Ð¼Ð¾Ð¼ÐµÐ½Ñ‚ÑƒÐ¼ ÑƒÑÐ¸Ð»Ð¸Ð²Ð°ÐµÑ‚ÑÑ", price - atr * 2, price + atr * 3, config.risk));
  }
  if (config.strategies.includes("momentum") && roc20 < -5 && rsi < 45) {
    signals.push(makeSignal(ticker, "Momentum Trading", "short", price, `ROC20 ${roc20.toFixed(1)}% Ð¸ RSI14 ${rsi.toFixed(0)}`, "Ð¼Ð¾Ð¼ÐµÐ½Ñ‚ÑƒÐ¼ Ð²Ð½Ð¸Ð· ÑƒÑÐ¸Ð»Ð¸Ð²Ð°ÐµÑ‚ÑÑ", price + atr * 2, price - atr * 3, config.risk));
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
    "ðŸ“Š ÐžÑ‚Ñ‡Ñ‘Ñ‚ Ð°Ð½Ð°Ð»Ð¸Ð·Ð°",
    "â”â”â”â”â”â”â”â”â”â”â”â”â”â”",
    "",
    `Ð’Ñ€ÐµÐ¼Ñ: ${result.timestamp}`,
    `Ð¢Ð°Ð¹Ð¼Ñ„Ñ€ÐµÐ¹Ð¼: ${result.timeframe}`,
    `Ð¢Ð¸ÐºÐµÑ€Ð¾Ð²: ${result.rows.length}`,
    `Ð¡Ð¸Ð³Ð½Ð°Ð»Ð¾Ð²: ${signalCount}`,
    "",
  ];

  for (const row of result.rows) {
    const arrow = row.direction === "up" ? "ðŸŸ¢â¬†ï¸" : row.direction === "down" ? "ðŸ”´â¬‡ï¸" : "âšªâž¡ï¸";
    const movement = `${row.change > 0 ? "+" : ""}${row.change.toFixed(2)} (${row.change_percent > 0 ? "+" : ""}${row.change_percent.toFixed(2)}%)`;
    lines.push("â”â”â”â”â”â”â”â”â”â”â”â”â”â”");
    lines.push(`${arrow} ${row.ticker}`);
    lines.push(`Ð¦ÐµÐ½Ð°: ${row.price.toFixed(2)}`);
    lines.push(`Ð”Ð²Ð¸Ð¶ÐµÐ½Ð¸Ðµ: ${movement}`);
    lines.push(`EMA200: ${valueOrDash(row.ema200)}, AVWAP: ${valueOrDash(row.avwap)}, RSI: ${valueOrDash(row.rsi14)}`);
    if (row.signals.length) {
      lines.push("");
      lines.push("âœ… Ð¡Ð¸Ð³Ð½Ð°Ð»Ñ‹:");
      for (const signal of row.signals) {
        const icon = signal.side === "long" ? "ðŸ“ˆ" : "ðŸ“‰";
        lines.push(`${icon} ${signal.side} / ${signal.strategy}`);
        lines.push(`Ð£ÑÐ»Ð¾Ð²Ð¸Ðµ: ${signal.condition}`);
        lines.push(`Ð˜Ð´ÐµÑ: ${signal.idea}`);
        lines.push(`Ð¡Ñ‚Ð¾Ð¿: ${signal.stop.toFixed(2)}`);
        lines.push(`Ð¦ÐµÐ»ÑŒ: ${signal.target.toFixed(2)}`);
        lines.push(`Ð Ð¸ÑÐº: ${signal.risk}%`);
      }
    } else {
      lines.push("");
      lines.push("Ð¡Ð¸Ð³Ð½Ð°Ð»Ñ‹: Ð½ÐµÑ‚");
    }
    lines.push("");
  }

  if (result.errors.length) {
    lines.push("â”â”â”â”â”â”â”â”â”â”â”â”â”â”");
    lines.push("âš ï¸ ÐžÑˆÐ¸Ð±ÐºÐ¸:");
    for (const error of result.errors) lines.push(`${error.ticker}: ${error.error}`);
  }
  return lines.join("\n").trim();
}

function telegramSignalMessage(signal) {
  const icon = signal.side === "long" ? "ðŸ“ˆ" : "ðŸ“‰";
  return [
    `${icon} Ð¡Ð¸Ð³Ð½Ð°Ð» Ð¿Ð¾ ${signal.ticker}`,
    "",
    `Ð¡Ñ‚Ñ€Ð°Ñ‚ÐµÐ³Ð¸Ñ: ${signal.strategy}`,
    `Ð¦ÐµÐ½Ð°: ${signal.price.toFixed(2)}`,
    `Ð£ÑÐ»Ð¾Ð²Ð¸Ðµ: ${signal.condition}`,
    `Ð˜Ð´ÐµÑ: ${signal.idea}`,
    `Ð¡Ñ‚Ð¾Ð¿: ${signal.stop.toFixed(2)}`,
    `Ð¦ÐµÐ»ÑŒ: ${signal.target.toFixed(2)}`,
    `Ð Ð¸ÑÐº: ${signal.risk}%`,
  ].join("\n");
}

async function sendTelegram(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) throw httpError("TELEGRAM_BOT_TOKEN Ð½Ðµ Ð·Ð°Ð´Ð°Ð½", 500);
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || "Telegram Ð½Ðµ Ð¿Ñ€Ð¸Ð½ÑÐ» ÑÐ¾Ð¾Ð±Ñ‰ÐµÐ½Ð¸Ðµ");
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
  if (/^\/?(fundrep|promtrep)\b/i.test(cleaned)) return [];
  return parseTickers(cleaned);
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
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

