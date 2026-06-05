from __future__ import annotations

import json
import hmac
import math
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid
import urllib.parse
import urllib.request
import urllib.error
from dataclasses import dataclass
from datetime import datetime, time as day_time
from html import escape as html_escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8787"))
MAX_TICKER_LENGTH = 12
TICKER_PATTERN = re.compile(r"^[A-Z][A-Z0-9.\-=]{0,11}$")
FUNDREP_PDF = Path(
    os.environ.get(
        "FUNDREP_TEMPLATE_PDF",
        r"C:\Users\fnemo\Documents\Codex\2026-05-23\https-www-youtube-com-watch-v\investment_kpi_framework_ru.pdf",
    )
)
REPORTS_DIR = DATA_DIR / "generated_reports"
APP_CONFIG_FILE = DATA_DIR / "app_settings.json"
REQUEST_DB_FILE = DATA_DIR / "requests.db"
MAX_REQUEST_LOGS = 80

sent_signals: set[str] = set()
request_logs: list[dict[str, Any]] = []
analysis_results: dict[str, dict[str, Any]] = {}
active_bot_config: dict[str, Any] = {}
request_db_lock = threading.Lock()
scheduler_lock = threading.Lock()
scheduler_thread: threading.Thread | None = None
telegram_thread: threading.Thread | None = None
scheduler_stop = threading.Event()
telegram_stop = threading.Event()
telegram_offset: int | None = None
scheduler_state: dict[str, Any] = {
    "running": False,
    "telegram_listening": False,
    "last_run": None,
    "next_run": None,
    "last_result": None,
    "last_error": None,
    "request_logs": request_logs,
}


TIMEFRAMES = {
    "1m": {"interval": "1m", "range": "7d"},
    "2m": {"interval": "2m", "range": "60d"},
    "5m": {"interval": "5m", "range": "60d"},
    "15m": {"interval": "15m", "range": "60d"},
    "30m": {"interval": "30m", "range": "60d"},
    "1h": {"interval": "60m", "range": "730d"},
    "1d": {"interval": "1d", "range": "3y"},
    "1wk": {"interval": "1wk", "range": "10y"},
}


@dataclass
class Candle:
    timestamp: int
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass
class Signal:
    ticker: str
    strategy: str
    side: str
    price: float
    condition: str
    idea: str
    stop: float
    target: float
    risk: float


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def init_request_db() -> None:
    REQUEST_DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    with request_db_lock:
        with sqlite3.connect(REQUEST_DB_FILE) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS request_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    time TEXT NOT NULL,
                    origin TEXT NOT NULL,
                    action TEXT NOT NULL,
                    tickers TEXT NOT NULL,
                    status TEXT NOT NULL,
                    detail TEXT NOT NULL DEFAULT ''
                )
                """
            )
            conn.commit()


def load_request_logs(limit: int = MAX_REQUEST_LOGS) -> list[dict[str, Any]]:
    init_request_db()
    with request_db_lock:
        with sqlite3.connect(REQUEST_DB_FILE) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT time, origin, action, tickers, status, detail
                FROM request_logs
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
    return [dict(row) for row in rows]


def refresh_request_logs() -> None:
    global request_logs
    request_logs = load_request_logs()
    scheduler_state["request_logs"] = request_logs


def add_request_log(origin: str, action: str, tickers: list[str] | str, status: str, detail: str = "") -> None:
    if isinstance(tickers, str):
        ticker_text = tickers
    else:
        ticker_text = ", ".join(tickers)
    init_request_db()
    with request_db_lock:
        with sqlite3.connect(REQUEST_DB_FILE) as conn:
            conn.execute(
                """
                INSERT INTO request_logs (time, origin, action, tickers, status, detail)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (now_iso(), origin, action, ticker_text, status, detail),
            )
            conn.commit()
    refresh_request_logs()


CONFIG_FIELDS = {
    "tickers",
    "timeframe",
    "risk",
    "intervalMinutes",
    "anchorBars",
    "startTime",
    "endTime",
    "telegramToken",
    "telegramChatId",
    "externalApiToken",
    "fundrepSource",
    "fmpApiKey",
    "alphaVantageApiKey",
    "polygonApiKey",
    "finnhubApiKey",
    "twelveDataApiKey",
    "yahooPaidApiKey",
    "yahooPaidApiHost",
    "strategies",
}


def clean_config(config: dict[str, Any]) -> dict[str, Any]:
    return {key: config[key] for key in CONFIG_FIELDS if key in config}


def load_app_config() -> dict[str, Any]:
    if not APP_CONFIG_FILE.exists():
        return {}
    try:
        data = json.loads(APP_CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return clean_config(data if isinstance(data, dict) else {})


def save_app_config(config: dict[str, Any]) -> dict[str, Any]:
    cleaned = clean_config(config)
    APP_CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    APP_CONFIG_FILE.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2), encoding="utf-8")
    return cleaned


def persist_active_config(config: dict[str, Any]) -> dict[str, Any]:
    global active_bot_config
    active_bot_config = save_app_config(config)
    return active_bot_config


def clear_request_logs() -> None:
    init_request_db()
    with request_db_lock:
        with sqlite3.connect(REQUEST_DB_FILE) as conn:
            conn.execute("DELETE FROM request_logs")
            conn.execute("DELETE FROM sqlite_sequence WHERE name = 'request_logs'")
            conn.commit()
    refresh_request_logs()


def telegram_origin(message: dict[str, Any]) -> str:
    chat = message.get("chat") or {}
    user = message.get("from") or {}
    username = user.get("username") or chat.get("username") or "-"
    first_name = user.get("first_name") or chat.get("first_name") or ""
    last_name = user.get("last_name") or chat.get("last_name") or ""
    full_name = " ".join(part for part in [first_name, last_name] if part) or "-"
    return (
        f"telegram chat_id={chat.get('id', '-')}; "
        f"type={chat.get('type', '-')}; "
        f"user_id={user.get('id', '-')}; "
        f"username=@{username}; "
        f"name={full_name}; "
        f"lang={user.get('language_code', '-')}; "
        "ip=not provided by Telegram; address=only if user shares location"
    )


def parse_tickers(value: str | list[str]) -> list[str]:
    if isinstance(value, list):
        raw = ",".join(str(item) for item in value)
    else:
        raw = value
    tickers = []
    normalized = re.sub(r"[\s;]+", ",", raw)
    for item in normalized.split(","):
        ticker = re.sub(r"^[^A-Za-z0-9]+|[^A-Za-z0-9.\-=]+$", "", item.strip().upper())
        if ticker and ticker not in tickers:
            tickers.append(ticker)
    return tickers


def is_valid_ticker(ticker: str) -> bool:
    return bool(ticker and len(ticker) <= MAX_TICKER_LENGTH and TICKER_PATTERN.fullmatch(ticker))


def ticker_validation_error(ticker: str) -> str:
    if len(ticker) > MAX_TICKER_LENGTH:
        return f"слишком длинный тикер, максимум {MAX_TICKER_LENGTH} символов"
    return "некорректный тикер: используйте латинские буквы, цифры, точку, дефис или знак ="


def read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def request_ip(handler: BaseHTTPRequestHandler) -> str:
    forwarded = handler.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return handler.client_address[0] if handler.client_address else "-"


def request_auth_token(handler: BaseHTTPRequestHandler, payload: dict[str, Any]) -> str:
    auth = handler.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (
        handler.headers.get("X-Scanner-Token", "")
        or str(payload.get("token", ""))
        or str(payload.get("apiToken", ""))
    ).strip()


def send_json(handler: BaseHTTPRequestHandler, payload: Any, status: int = 200) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def fetch_candles(ticker: str, timeframe: str) -> list[Candle]:
    config = TIMEFRAMES.get(timeframe, TIMEFRAMES["1d"])
    params = urllib.parse.urlencode(
        {
            "range": config["range"],
            "interval": config["interval"],
            "includePrePost": "false",
        }
    )
    payload = None
    last_error = ""
    for yahoo_ticker in yahoo_ticker_candidates(ticker):
        safe_ticker = urllib.parse.quote(yahoo_ticker)
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{safe_ticker}?{params}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last_error = f"{yahoo_ticker}: Yahoo chart HTTP {exc.code}"
            continue
        if payload.get("chart", {}).get("result"):
            break
        last_error = f"{yahoo_ticker}: {payload.get('chart', {}).get('error', {}).get('description', 'нет данных')}"
        payload = None

    if payload is None:
        raise ValueError(f"{ticker}: {last_error or 'нет данных'}")
    result = payload.get("chart", {}).get("result")
    if not result:
        error = payload.get("chart", {}).get("error", {}).get("description", "нет данных")
        raise ValueError(f"{ticker}: {error}")

    chart = result[0]
    timestamps = chart.get("timestamp") or []
    quote = (chart.get("indicators", {}).get("quote") or [{}])[0]
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []

    candles: list[Candle] = []
    for idx, stamp in enumerate(timestamps):
        values = [
            opens[idx] if idx < len(opens) else None,
            highs[idx] if idx < len(highs) else None,
            lows[idx] if idx < len(lows) else None,
            closes[idx] if idx < len(closes) else None,
            volumes[idx] if idx < len(volumes) else 0,
        ]
        if any(value is None for value in values[:4]):
            continue
        candles.append(
            Candle(
                timestamp=int(stamp),
                open=float(values[0]),
                high=float(values[1]),
                low=float(values[2]),
                close=float(values[3]),
                volume=float(values[4] or 0),
            )
        )
    if len(candles) < 60:
        raise ValueError(f"{ticker}: мало свечей для анализа ({len(candles)})")
    return candles


def yahoo_ticker_candidates(ticker: str) -> list[str]:
    normalized = str(ticker or "").strip().upper()
    if not normalized or "." in normalized:
        return [normalized]
    return [normalized, f"{normalized}.TA"]


def fetch_fundamental_data(ticker: str) -> dict[str, Any]:
    return fetch_yahoo_fundamental_data(ticker)


def get_source_api_key(config: dict[str, Any], source: str) -> str:
    source = source.strip().lower()
    key_fields = {
        "fmp": "fmpApiKey",
        "alpha_vantage": "alphaVantageApiKey",
        "polygon": "polygonApiKey",
        "finnhub": "finnhubApiKey",
        "twelve_data": "twelveDataApiKey",
        "yahoo_paid": "yahooPaidApiKey",
    }
    return str(config.get(key_fields.get(source, ""), "")).strip()


def fetch_fundamental_data_for_source(ticker: str, source: str, api_key_or_config: Any = "") -> dict[str, Any]:
    selected = (source or "auto").strip().lower()
    if isinstance(api_key_or_config, dict):
        config = api_key_or_config
        key = get_source_api_key(config, selected if selected != "auto" else "fmp")
    else:
        config = {"fmpApiKey": str(api_key_or_config)}
        key = str(api_key_or_config).strip()
    if selected == "fmp":
        if not key:
            raise ValueError("Для Financial Modeling Prep нужен API key")
        return fetch_fmp_fundamental_data(ticker, key)
    if selected == "alpha_vantage":
        if not key:
            raise ValueError("Для Alpha Vantage нужен API key")
        return fetch_alpha_vantage_fundamental_data(ticker, key)
    if selected == "polygon":
        if not key:
            raise ValueError("Для Polygon.io нужен API key")
        return fetch_polygon_fundamental_data(ticker, key)
    if selected == "finnhub":
        if not key:
            raise ValueError("Для Finnhub нужен API key")
        return fetch_finnhub_fundamental_data(ticker, key)
    if selected == "twelve_data":
        if not key:
            raise ValueError("Для Twelve Data нужен API key")
        return fetch_twelve_data_fundamental_data(ticker, key)
    if selected == "yahoo_paid":
        if not key:
            raise ValueError("Для платного Yahoo Finance API нужен API key")
        return fetch_yahoo_paid_fundamental_data(ticker, key, str(config.get("yahooPaidApiHost", "")).strip())
    if selected == "yahoo":
        return fetch_yahoo_fundamental_data(ticker)
    if selected == "auto":
        return fetch_aggregate_fundamental_data(ticker, config)
    raise ValueError(f"Неизвестный источник FundRep: {source}")


def is_missing_value(value: Any) -> bool:
    if value in (None, "", {}, [], "н/д", "N/A", "None"):
        return True
    if isinstance(value, dict):
        return all(is_missing_value(item) for item in value.values())
    return False


def merge_missing_fields(base: Any, incoming: Any) -> Any:
    if isinstance(base, dict) and isinstance(incoming, dict):
        merged = dict(base)
        for key, value in incoming.items():
            if key in {"fundrepDataStatus", "fundrepSources", "fundrepErrors"}:
                continue
            if key not in merged or is_missing_value(merged[key]):
                merged[key] = value
            elif isinstance(merged[key], dict) and isinstance(value, dict):
                merged[key] = merge_missing_fields(merged[key], value)
        return merged
    return incoming if is_missing_value(base) else base


def count_available_metrics(data: dict[str, Any]) -> int:
    paths = [
        ("price", "shortName"),
        ("price", "regularMarketPrice"),
        ("price", "marketCap"),
        ("assetProfile", "sector"),
        ("assetProfile", "industry"),
        ("financialData", "revenueGrowth"),
        ("financialData", "grossMargins"),
        ("financialData", "operatingMargins"),
        ("financialData", "profitMargins"),
        ("financialData", "ebitda"),
        ("financialData", "operatingCashflow"),
        ("financialData", "freeCashflow"),
        ("financialData", "debtToEquity"),
        ("financialData", "currentRatio"),
        ("financialData", "returnOnEquity"),
        ("financialData", "returnOnAssets"),
        ("financialData", "recommendationKey"),
        ("financialData", "targetMeanPrice"),
        ("financialData", "earningsGrowth"),
        ("summaryDetail", "trailingPE"),
        ("summaryDetail", "forwardPE"),
        ("defaultKeyStatistics", "capeRatio"),
        ("summaryDetail", "priceToSalesTrailing12Months"),
        ("summaryDetail", "beta"),
        ("summaryDetail", "dividendYield"),
        ("defaultKeyStatistics", "trailingEps"),
        ("defaultKeyStatistics", "enterpriseToEbitda"),
        ("defaultKeyStatistics", "pegRatio"),
        ("defaultKeyStatistics", "priceToBook"),
    ]
    return sum(0 if is_missing_value(metric_value(data, *path)) else 1 for path in paths)


def fetch_aggregate_fundamental_data(ticker: str, config: dict[str, Any]) -> dict[str, Any]:
    ordered_sources = ["fmp", "alpha_vantage", "polygon", "finnhub", "twelve_data", "yahoo_paid"]
    merged: dict[str, Any] = {}
    used = []
    errors = []
    before = 0
    for source in ordered_sources:
        if not get_source_api_key(config, source):
            continue
        try:
            data = fetch_fundamental_data_for_source(ticker, source, config)
            merged = merge_missing_fields(merged, data)
            after = count_available_metrics(merged)
            gained = after - before
            before = after
            used.append(f"{source} (+{gained})")
        except Exception as exc:
            errors.append(f"{source}: {exc}")

    try:
        yahoo_data = fetch_yahoo_fundamental_data(ticker)
        merged = merge_missing_fields(merged, yahoo_data)
        after = count_available_metrics(merged)
        gained = after - before
        before = after
        used.append(f"yahoo_fallback (+{gained})")
    except Exception as exc:
        errors.append(f"yahoo_fallback: {exc}")

    if not merged:
        raise ValueError(f"Не удалось получить данные ни из одного источника: {'; '.join(errors)}")
    merged["fundrepSources"] = used
    merged["fundrepErrors"] = errors
    status = f"Данные собраны из источников: {', '.join(used) if used else 'нет'}."
    if errors:
        status += f" Ошибки источников: {'; '.join(errors)}."
    merged["fundrepDataStatus"] = status
    return merged


def fetch_json_url(url: str, timeout: int = 20) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def first_item(payload: Any) -> dict[str, Any]:
    if isinstance(payload, list):
        return payload[0] if payload else {}
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            return data[0] if data else {}
        return payload
    return {}


def fmp_request(path: str, api_key: str, **params: Any) -> Any:
    query = dict(params)
    query["apikey"] = api_key
    return fetch_json_url(f"https://financialmodelingprep.com{path}?{urllib.parse.urlencode(query)}")


def fmp_get_first(api_key: str, stable_path: str, legacy_path: str, ticker: str) -> dict[str, Any]:
    try:
        return first_item(fmp_request(stable_path, api_key, symbol=ticker))
    except Exception:
        return first_item(fmp_request(legacy_path.format(ticker=urllib.parse.quote(ticker)), api_key))


def fetch_fmp_fundamental_data(ticker: str, api_key: str) -> dict[str, Any]:
    profile = fmp_get_first(api_key, "/stable/profile", "/api/v3/profile/{ticker}", ticker)
    quote = fmp_get_first(api_key, "/stable/quote", "/api/v3/quote/{ticker}", ticker)
    key_metrics = fmp_get_first(api_key, "/stable/key-metrics-ttm", "/api/v3/key-metrics-ttm/{ticker}", ticker)
    ratios = fmp_get_first(api_key, "/stable/ratios-ttm", "/api/v3/ratios-ttm/{ticker}", ticker)
    growth = fmp_get_first(api_key, "/stable/financial-growth", "/api/v3/financial-growth/{ticker}", ticker)

    if not any([profile, quote, key_metrics, ratios, growth]):
        raise ValueError("FMP не вернул данные по тикеру")

    def pick(*values: Any) -> Any:
        for value in values:
            if value not in (None, "", {}):
                return value
        return None

    return {
        "fundrepDataStatus": "Фундаментальные данные Financial Modeling Prep получены.",
        "price": {
            "shortName": pick(profile.get("companyName"), profile.get("companyName"), quote.get("name"), ticker),
            "regularMarketPrice": pick(quote.get("price"), profile.get("price")),
            "currency": pick(profile.get("currency"), quote.get("currency"), "USD"),
            "marketCap": pick(quote.get("marketCap"), profile.get("mktCap"), profile.get("marketCap")),
        },
        "assetProfile": {
            "sector": profile.get("sector"),
            "industry": profile.get("industry"),
        },
        "financialData": {
            "revenueGrowth": pick(growth.get("revenueGrowth"), growth.get("growthRevenue")),
            "grossMargins": ratios.get("grossProfitMarginTTM"),
            "operatingMargins": ratios.get("operatingProfitMarginTTM"),
            "profitMargins": ratios.get("netProfitMarginTTM"),
            "ebitda": pick(key_metrics.get("ebitdaTTM"), None),
            "operatingCashflow": pick(key_metrics.get("operatingCashFlowTTM"), None),
            "freeCashflow": pick(key_metrics.get("freeCashFlowTTM"), None),
            "debtToEquity": pick(key_metrics.get("debtToEquityTTM"), ratios.get("debtEquityRatioTTM")),
            "totalCash": None,
            "totalDebt": None,
            "currentRatio": pick(key_metrics.get("currentRatioTTM"), ratios.get("currentRatioTTM")),
            "returnOnEquity": pick(ratios.get("returnOnEquityTTM"), key_metrics.get("roeTTM")),
            "returnOnAssets": ratios.get("returnOnAssetsTTM"),
            "recommendationKey": quote.get("ratingRecommendation"),
            "targetMeanPrice": quote.get("priceAvg50"),
            "earningsGrowth": pick(growth.get("epsgrowth"), growth.get("growthEPS")),
        },
        "summaryDetail": {
            "trailingPE": pick(quote.get("pe"), key_metrics.get("peRatioTTM")),
            "forwardPE": None,
            "priceToSalesTrailing12Months": key_metrics.get("priceToSalesRatioTTM"),
            "beta": profile.get("beta"),
            "dividendYield": pick(key_metrics.get("dividendYieldTTM"), ratios.get("dividendYieldTTM")),
        },
        "defaultKeyStatistics": {
            "trailingEps": pick(quote.get("eps"), key_metrics.get("netIncomePerShareTTM")),
            "enterpriseToEbitda": key_metrics.get("enterpriseValueOverEBITDATTM"),
            "pegRatio": key_metrics.get("pegRatioTTM"),
            "capeRatio": pick(
                key_metrics.get("capeRatioTTM"),
                key_metrics.get("capeRatio"),
                key_metrics.get("shillerPERatio"),
                ratios.get("capeRatioTTM"),
                ratios.get("capeRatio"),
                ratios.get("shillerPERatio"),
            ),
            "priceToBook": key_metrics.get("pbRatioTTM"),
        },
    }


def build_standard_fundamental_data(
    ticker: str,
    provider: str,
    profile: dict[str, Any] | None = None,
    quote: dict[str, Any] | None = None,
    metrics: dict[str, Any] | None = None,
    ratios: dict[str, Any] | None = None,
    growth: dict[str, Any] | None = None,
) -> dict[str, Any]:
    profile = profile or {}
    quote = quote or {}
    metrics = metrics or {}
    ratios = ratios or {}
    growth = growth or {}

    def pick(*values: Any) -> Any:
        for value in values:
            if value not in (None, "", {}):
                return value
        return None

    return {
        "fundrepDataStatus": f"Данные {provider} получены. Недоступные по тарифу или API метрики отмечены как н/д.",
        "price": {
            "shortName": pick(profile.get("Name"), profile.get("name"), profile.get("companyName"), quote.get("name"), ticker),
            "regularMarketPrice": pick(quote.get("price"), quote.get("c"), quote.get("close"), profile.get("price")),
            "currency": pick(profile.get("Currency"), profile.get("currency"), quote.get("currency"), "USD"),
            "marketCap": pick(profile.get("MarketCapitalization"), profile.get("market_cap"), quote.get("marketCap"), metrics.get("marketCapitalization")),
        },
        "assetProfile": {
            "sector": pick(profile.get("Sector"), profile.get("sector")),
            "industry": pick(profile.get("Industry"), profile.get("industry")),
        },
        "financialData": {
            "revenueGrowth": pick(growth.get("revenueGrowth"), metrics.get("revenueGrowth")),
            "grossMargins": pick(ratios.get("grossMargin"), ratios.get("grossProfitMargin"), metrics.get("grossMargin")),
            "operatingMargins": pick(ratios.get("operatingMargin"), ratios.get("operatingProfitMargin"), profile.get("OperatingMarginTTM")),
            "profitMargins": pick(ratios.get("netMargin"), ratios.get("netProfitMargin"), profile.get("ProfitMargin")),
            "ebitda": pick(profile.get("EBITDA"), metrics.get("ebitda")),
            "operatingCashflow": pick(metrics.get("operatingCashFlow"), metrics.get("operatingCashflow")),
            "freeCashflow": pick(metrics.get("freeCashFlow"), metrics.get("freeCashflow")),
            "debtToEquity": pick(ratios.get("debtToEquity"), metrics.get("debtToEquity")),
            "totalCash": pick(metrics.get("totalCash"), profile.get("totalCash")),
            "totalDebt": pick(metrics.get("totalDebt"), profile.get("totalDebt")),
            "currentRatio": pick(ratios.get("currentRatio"), metrics.get("currentRatio")),
            "returnOnEquity": pick(ratios.get("returnOnEquity"), profile.get("ReturnOnEquityTTM")),
            "returnOnAssets": pick(ratios.get("returnOnAssets"), profile.get("ReturnOnAssetsTTM")),
            "recommendationKey": pick(quote.get("ratingRecommendation"), quote.get("recommendation")),
            "targetMeanPrice": pick(quote.get("targetMeanPrice"), quote.get("targetPrice")),
            "earningsGrowth": pick(growth.get("earningsGrowth"), growth.get("epsGrowth"), profile.get("QuarterlyEarningsGrowthYOY")),
        },
        "summaryDetail": {
            "trailingPE": pick(profile.get("PERatio"), quote.get("pe"), metrics.get("peRatio"), ratios.get("priceEarningsRatio")),
            "forwardPE": pick(profile.get("ForwardPE"), metrics.get("forwardPE")),
            "priceToSalesTrailing12Months": pick(profile.get("PriceToSalesRatioTTM"), metrics.get("priceToSalesRatio")),
            "beta": pick(profile.get("Beta"), profile.get("beta")),
            "dividendYield": pick(profile.get("DividendYield"), metrics.get("dividendYield")),
        },
        "defaultKeyStatistics": {
            "trailingEps": pick(profile.get("EPS"), quote.get("eps"), metrics.get("eps")),
            "enterpriseToEbitda": pick(metrics.get("enterpriseToEbitda"), ratios.get("enterpriseValueOverEBITDA")),
            "pegRatio": pick(profile.get("PEGRatio"), metrics.get("pegRatio")),
            "capeRatio": pick(
                profile.get("CAPE"),
                profile.get("CapeRatio"),
                profile.get("ShillerPE"),
                profile.get("ShillerPERatio"),
                metrics.get("capeRatio"),
                metrics.get("capeRatioTTM"),
                metrics.get("shillerPERatio"),
                ratios.get("capeRatio"),
                ratios.get("capeRatioTTM"),
                ratios.get("shillerPERatio"),
            ),
            "priceToBook": pick(profile.get("PriceToBookRatio"), metrics.get("priceToBookRatio")),
        },
    }


def fetch_alpha_vantage_fundamental_data(ticker: str, api_key: str) -> dict[str, Any]:
    payload = fetch_json_url(
        f"https://www.alphavantage.co/query?{urllib.parse.urlencode({'function': 'OVERVIEW', 'symbol': ticker, 'apikey': api_key})}"
    )
    if not payload or "Error Message" in payload or "Note" in payload or "Information" in payload:
        raise ValueError(payload.get("Error Message") or payload.get("Note") or payload.get("Information") or "Alpha Vantage не вернул данные")
    return build_standard_fundamental_data(ticker, "Alpha Vantage", profile=payload)


def fetch_polygon_fundamental_data(ticker: str, api_key: str) -> dict[str, Any]:
    profile_payload = fetch_json_url(f"https://api.polygon.io/v3/reference/tickers/{urllib.parse.quote(ticker)}?apiKey={urllib.parse.quote(api_key)}")
    profile = profile_payload.get("results") or {}
    quote = {}
    try:
        prev = fetch_json_url(f"https://api.polygon.io/v2/aggs/ticker/{urllib.parse.quote(ticker)}/prev?adjusted=true&apiKey={urllib.parse.quote(api_key)}")
        result = (prev.get("results") or [{}])[0]
        quote = {"price": result.get("c")}
    except Exception:
        quote = {}
    mapped_profile = {
        "name": profile.get("name"),
        "currency": profile.get("currency_name"),
        "market_cap": profile.get("market_cap"),
        "sector": profile.get("sic_description"),
        "industry": profile.get("type"),
    }
    return build_standard_fundamental_data(ticker, "Polygon.io", profile=mapped_profile, quote=quote)


def fetch_finnhub_fundamental_data(ticker: str, api_key: str) -> dict[str, Any]:
    query = urllib.parse.urlencode({"symbol": ticker, "token": api_key})
    profile = fetch_json_url(f"https://finnhub.io/api/v1/stock/profile2?{query}")
    quote = fetch_json_url(f"https://finnhub.io/api/v1/quote?{query}")
    metric_payload = fetch_json_url(f"https://finnhub.io/api/v1/stock/metric?{urllib.parse.urlencode({'symbol': ticker, 'metric': 'all', 'token': api_key})}")
    metrics = metric_payload.get("metric") or {}
    if not profile and not metrics:
        raise ValueError("Finnhub не вернул данные по тикеру")
    return build_standard_fundamental_data(ticker, "Finnhub", profile=profile, quote=quote, metrics=metrics, ratios=metrics)


def fetch_twelve_data_fundamental_data(ticker: str, api_key: str) -> dict[str, Any]:
    base = {"symbol": ticker, "apikey": api_key}
    profile = fetch_json_url(f"https://api.twelvedata.com/profile?{urllib.parse.urlencode(base)}")
    quote = fetch_json_url(f"https://api.twelvedata.com/quote?{urllib.parse.urlencode(base)}")
    if isinstance(profile, dict) and profile.get("status") == "error":
        raise ValueError(profile.get("message", "Twelve Data profile error"))
    if isinstance(quote, dict) and quote.get("status") == "error":
        quote = {}
    return build_standard_fundamental_data(ticker, "Twelve Data", profile=profile, quote=quote)


def fetch_yahoo_paid_fundamental_data(ticker: str, api_key: str, api_host: str = "") -> dict[str, Any]:
    if not api_host:
        raise ValueError("Для платного Yahoo API укажите API host")
    # Most paid Yahoo-compatible providers on RapidAPI use provider-specific hosts and schemas.
    # This adapter fetches quoteSummary-compatible JSON when the host supports it.
    modules = "price,summaryDetail,defaultKeyStatistics,financialData,assetProfile"
    url = f"https://{api_host}/stock/v2/get-summary?{urllib.parse.urlencode({'symbol': ticker, 'region': 'US', 'modules': modules})}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "X-RapidAPI-Key": api_key,
            "X-RapidAPI-Host": api_host,
        },
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Yahoo paid API вернул неожиданный формат")
    payload["fundrepDataStatus"] = "Данные платного Yahoo Finance API получены."
    return payload


def fetch_yahoo_fundamental_data(ticker: str) -> dict[str, Any]:
    modules = ",".join(
        [
            "price",
            "summaryDetail",
            "defaultKeyStatistics",
            "financialData",
            "assetProfile",
            "earningsTrend",
            "recommendationTrend",
        ]
    )
    safe_ticker = urllib.parse.quote(ticker)
    url = f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{safe_ticker}?modules={modules}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
        result = payload.get("quoteSummary", {}).get("result")
        if result:
            result[0]["fundrepDataStatus"] = "Фундаментальные данные Yahoo Finance получены."
            return result[0]
        error = payload.get("quoteSummary", {}).get("error", {}).get("description", "нет фундаментальных данных")
        return fetch_fundamental_fallback(ticker, f"quoteSummary недоступен: {error}")
    except urllib.error.HTTPError as exc:
        if exc.code in {401, 403, 404}:
            return fetch_fundamental_fallback(ticker, f"quoteSummary недоступен: HTTP {exc.code}")
        raise


def fetch_fundamental_fallback(ticker: str, reason: str) -> dict[str, Any]:
    safe_ticker = urllib.parse.quote(ticker)
    quote_url = f"https://query1.finance.yahoo.com/v7/finance/quote?symbols={safe_ticker}"
    req = urllib.request.Request(quote_url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
        quote = (payload.get("quoteResponse", {}).get("result") or [{}])[0]
    except Exception:
        quote = {}

    if not quote:
        try:
            candles = fetch_candles(ticker, "1d")
            latest = candles[-1]
            previous = candles[-2]
            quote = {
                "shortName": ticker,
                "regularMarketPrice": latest.close,
                "currency": "USD",
                "regularMarketChange": latest.close - previous.close,
                "regularMarketChangePercent": ((latest.close / previous.close) - 1) * 100 if previous.close else None,
            }
        except Exception:
            quote = {"shortName": ticker}

    return {
        "fundrepDataStatus": f"{reason}. Отчёт создан с доступными рыночными данными; закрытые фундаментальные метрики отмечены как н/д.",
        "price": {
            "shortName": quote.get("shortName") or quote.get("longName") or ticker,
            "regularMarketPrice": quote.get("regularMarketPrice"),
            "currency": quote.get("currency") or "USD",
            "marketCap": quote.get("marketCap"),
        },
        "assetProfile": {
            "sector": quote.get("sector"),
            "industry": quote.get("industry"),
        },
        "financialData": {
            "recommendationKey": quote.get("recommendationKey"),
            "targetMeanPrice": quote.get("targetMeanPrice"),
        },
        "summaryDetail": {
            "trailingPE": quote.get("trailingPE"),
            "forwardPE": quote.get("forwardPE"),
            "priceToSalesTrailing12Months": quote.get("priceToSalesTrailing12Months"),
            "beta": quote.get("beta"),
            "dividendYield": quote.get("dividendYield"),
        },
        "defaultKeyStatistics": {
            "trailingEps": quote.get("epsTrailingTwelveMonths"),
            "enterpriseToEbitda": quote.get("enterpriseToEbitda"),
            "pegRatio": quote.get("pegRatio"),
            "priceToBook": quote.get("priceToBook"),
        },
    }


def metric_value(data: dict[str, Any], *path: str) -> Any:
    current: Any = data
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    if isinstance(current, dict):
        if "fmt" in current:
            return current["fmt"]
        if "raw" in current:
            return current["raw"]
    return current


def fmt_metric(value: Any, suffix: str = "") -> str:
    if value in (None, "", {}):
        return "н/д"
    if isinstance(value, float):
        return f"{value:.2f}{suffix}"
    return f"{value}{suffix}"


def fmt_percent(value: Any) -> str:
    if value in (None, "", {}):
        return "н/д"
    if isinstance(value, str):
        return value
    return f"{float(value) * 100:.2f}%"


def format_distance(value: Any) -> str:
    if value in (None, "", {}):
        return "-"
    number = float(value)
    return f"{'+' if number > 0 else ''}{number:.2f}%"


def fmt_money(value: Any) -> str:
    if value in (None, "", {}):
        return "н/д"
    if isinstance(value, str):
        return value
    absolute = abs(float(value))
    if absolute >= 1_000_000_000_000:
        return f"${float(value) / 1_000_000_000_000:.2f}T"
    if absolute >= 1_000_000_000:
        return f"${float(value) / 1_000_000_000:.2f}B"
    if absolute >= 1_000_000:
        return f"${float(value) / 1_000_000:.2f}M"
    return f"${float(value):,.0f}"


def ema(values: list[float], period: int) -> list[float | None]:
    if len(values) < period:
        return [None] * len(values)
    result: list[float | None] = [None] * len(values)
    sma = sum(values[:period]) / period
    result[period - 1] = sma
    multiplier = 2 / (period + 1)
    previous = sma
    for idx in range(period, len(values)):
        previous = (values[idx] - previous) * multiplier + previous
        result[idx] = previous
    return result


def moving_average(values: list[float], period: int) -> float | None:
    if len(values) < period:
        return None
    selected = values[-period:]
    return sum(selected) / period


def atr(candles: list[Candle], period: int = 14) -> float:
    if len(candles) < period + 1:
        return max(candles[-1].high - candles[-1].low, candles[-1].close * 0.015)
    ranges = []
    for idx in range(1, len(candles)):
        current = candles[idx]
        previous = candles[idx - 1]
        ranges.append(
            max(
                current.high - current.low,
                abs(current.high - previous.close),
                abs(current.low - previous.close),
            )
        )
    return sum(ranges[-period:]) / period


def rsi(closes: list[float], period: int = 14) -> float:
    if len(closes) <= period:
        return 50.0
    gains = []
    losses = []
    for idx in range(-period, 0):
        change = closes[idx] - closes[idx - 1]
        gains.append(max(change, 0))
        losses.append(abs(min(change, 0)))
    average_gain = sum(gains) / period
    average_loss = sum(losses) / period
    if average_loss == 0:
        return 100.0
    relative_strength = average_gain / average_loss
    return 100 - (100 / (1 + relative_strength))


def avwap(candles: list[Candle], anchor_bars: int) -> float:
    selected = candles[-anchor_bars:] if len(candles) > anchor_bars else candles
    weighted_sum = 0.0
    volume_sum = 0.0
    for candle in selected:
        typical = (candle.high + candle.low + candle.close) / 3
        weighted_sum += typical * candle.volume
        volume_sum += candle.volume
    if volume_sum <= 0:
        return selected[-1].close
    return weighted_sum / volume_sum


def volume_poc(candles: list[Candle], bars: int = 120, bins: int = 24) -> float:
    selected = candles[-bars:] if len(candles) > bars else candles
    low = min(candle.low for candle in selected)
    high = max(candle.high for candle in selected)
    if math.isclose(low, high):
        return selected[-1].close
    step = (high - low) / bins
    buckets = [0.0] * bins
    for candle in selected:
        typical = (candle.high + candle.low + candle.close) / 3
        index = min(bins - 1, max(0, int((typical - low) / step)))
        buckets[index] += candle.volume
    poc_index = max(range(bins), key=lambda idx: buckets[idx])
    return low + step * (poc_index + 0.5)


def make_signal(
    ticker: str,
    strategy: str,
    side: str,
    price: float,
    condition: str,
    risk: float,
    atr_value: float,
) -> Signal:
    direction = 1 if side == "long" else -1
    stop = price - direction * atr_value * 1.5
    target = price + direction * atr_value * 2.2
    return Signal(
        ticker=ticker,
        strategy=strategy,
        side=side,
        price=price,
        condition=condition,
        idea=f"возможный {side}",
        stop=stop,
        target=target,
        risk=risk,
    )


def analyze_ticker(ticker: str, timeframe: str, strategies: list[str], risk: float, anchor_bars: int) -> dict[str, Any]:
    candles = fetch_candles(ticker, timeframe)
    closes = [candle.close for candle in candles]
    price = closes[-1]
    ema200 = ema(closes, 200)[-1]
    mma150 = moving_average(closes, 150)
    avwap_value = avwap(candles, anchor_bars)
    atr_value = atr(candles)
    poc = volume_poc(candles)
    latest = candles[-1]
    previous = candles[-2]
    avg_volume = sum(candle.volume for candle in candles[-21:-1]) / min(20, max(1, len(candles[-21:-1])))
    high20 = max(candle.high for candle in candles[-21:-1])
    low20 = min(candle.low for candle in candles[-21:-1])
    roc20 = ((price / closes[-21]) - 1) * 100 if len(closes) > 21 and closes[-21] else 0
    rsi14 = rsi(closes)

    signals: list[Signal] = []
    selected = set(strategies)

    if "trend" in selected and ema200 is not None:
        if price > ema200 and price > avwap_value:
            signals.append(
                make_signal(
                    ticker,
                    "Trend Following",
                    "long",
                    price,
                    "цена выше EMA200 и выше AVWAP",
                    risk,
                    atr_value,
                )
            )
        elif price < ema200 and price < avwap_value:
            signals.append(
                make_signal(
                    ticker,
                    "Trend Following",
                    "short",
                    price,
                    "цена ниже EMA200 и ниже AVWAP",
                    risk,
                    atr_value,
                )
            )

    if "breakout" in selected and avg_volume > 0:
        if latest.close > high20 and latest.volume > avg_volume * 1.25:
            signals.append(
                make_signal(
                    ticker,
                    "Breakout Trading",
                    "long",
                    price,
                    "пробой 20-свечного максимума с повышенным объёмом",
                    risk,
                    atr_value,
                )
            )
        elif latest.close < low20 and latest.volume > avg_volume * 1.25:
            signals.append(
                make_signal(
                    ticker,
                    "Breakout Trading",
                    "short",
                    price,
                    "пробой 20-свечного минимума с повышенным объёмом",
                    risk,
                    atr_value,
                )
            )

    if "volume_avwap" in selected:
        if price > avwap_value and price > poc and previous.close <= max(avwap_value, poc):
            signals.append(
                make_signal(
                    ticker,
                    "Volume Profile + AVWAP",
                    "long",
                    price,
                    "цена вернулась выше AVWAP и POC объёмного профиля",
                    risk,
                    atr_value,
                )
            )
        elif price < avwap_value and price < poc and previous.close >= min(avwap_value, poc):
            signals.append(
                make_signal(
                    ticker,
                    "Volume Profile + AVWAP",
                    "short",
                    price,
                    "цена ушла ниже AVWAP и POC объёмного профиля",
                    risk,
                    atr_value,
                )
            )

    if "momentum" in selected:
        if roc20 > 3 and rsi14 > 55 and price > previous.close:
            signals.append(
                make_signal(
                    ticker,
                    "Momentum Trading",
                    "long",
                    price,
                    f"ROC20 {roc20:.1f}% и RSI14 {rsi14:.0f}",
                    risk,
                    atr_value,
                )
            )
        elif roc20 < -3 and rsi14 < 45 and price < previous.close:
            signals.append(
                make_signal(
                    ticker,
                    "Momentum Trading",
                    "short",
                    price,
                    f"ROC20 {roc20:.1f}% и RSI14 {rsi14:.0f}",
                    risk,
                    atr_value,
                )
            )

    return {
        "ticker": ticker,
        "price": round(price, 2),
        "previous_close": round(previous.close, 2),
        "change": round(price - previous.close, 2),
        "change_percent": round(((price / previous.close) - 1) * 100, 2) if previous.close else 0,
        "direction": "up" if price > previous.close else "down" if price < previous.close else "flat",
        "ema200": round(ema200, 2) if ema200 else None,
        "mma150": round(mma150, 2) if mma150 else None,
        "mma150_distance_percent": round(((price / mma150) - 1) * 100, 2) if mma150 else None,
        "avwap": round(avwap_value, 2),
        "atr14": round(atr_value, 2),
        "poc": round(poc, 2),
        "rsi14": round(rsi14, 1),
        "roc20": round(roc20, 2),
        "volume": int(latest.volume),
        "signals": [signal.__dict__ for signal in signals],
    }


def telegram_message(signal: dict[str, Any]) -> str:
    icon = "📈" if signal["side"] == "long" else "📉"
    return (
        f"{icon} Сигнал по {signal['ticker']}\n\n"
        f"Стратегия: {signal['strategy']}\n"
        f"Цена: {signal['price']:.2f}\n"
        f"Условие: {signal['condition']}\n"
        f"Идея: {signal['idea']}\n"
        f"Стоп: {signal['stop']:.2f}\n"
        f"Цель: {signal['target']:.2f}\n"
        f"Риск: {signal['risk']}%"
    )


def analysis_report_message(result: dict[str, Any]) -> str:
    rows = result.get("rows", [])
    errors = result.get("errors", [])
    signal_count = sum(len(row.get("signals", [])) for row in rows)
    lines = [
        "📊 Отчёт анализа",
        "━━━━━━━━━━━━━━",
        "",
        f"Время: {result.get('timestamp', '-')}",
        f"Таймфрейм: {result.get('timeframe', '-')}",
        f"Тикеров: {len(rows)}",
        f"Сигналов: {signal_count}",
        "",
    ]

    for row in rows:
        signals = row.get("signals", [])
        direction = row.get("direction", "flat")
        if direction == "up":
            arrow = "🟢⬆️"
            movement = f"+{row.get('change', 0):.2f} (+{row.get('change_percent', 0):.2f}%)"
        elif direction == "down":
            arrow = "🔴⬇️"
            movement = f"{row.get('change', 0):.2f} ({row.get('change_percent', 0):.2f}%)"
        else:
            arrow = "⚪➡️"
            movement = "0.00 (0.00%)"
        lines.extend(
            [
                "━━━━━━━━━━━━━━",
                f"{arrow} {row['ticker']}",
                f"Цена: {row['price']:.2f}",
                f"Движение: {movement}",
                f"EMA200: {row.get('ema200', '-')}, AVWAP: {row.get('avwap', '-')}, RSI: {row.get('rsi14', '-')}",
                f"ATR14: {row.get('atr14', '-')}, MMA150: {row.get('mma150', '-')}, от MMA150: {format_distance(row.get('mma150_distance_percent'))}",
            ]
        )
        if signals:
            lines.append("")
            lines.append("✅ Сигналы:")
            for signal in signals:
                icon = "📈" if signal["side"] == "long" else "📉"
                lines.extend(
                    [
                        f"{icon} {signal['side']} / {signal['strategy']}",
                        f"Условие: {signal['condition']}",
                        f"Идея: {signal['idea']}",
                        f"Стоп: {signal['stop']:.2f}",
                        f"Цель: {signal['target']:.2f}",
                        f"Риск: {signal['risk']}%",
                    ]
                )
        else:
            lines.append("")
            lines.append("Сигналы: нет")
        lines.append("")

    if errors:
        lines.append("━━━━━━━━━━━━━━")
        lines.append("⚠️ Ошибки:")
        for error in errors:
            lines.append(f"{error['ticker']}: {error['error']}")

    return "\n".join(lines).strip()


def update_analysis_results(result: dict[str, Any]) -> dict[str, Any]:
    timestamp = str(result.get("timestamp") or now_iso())
    timeframe = str(result.get("timeframe") or "-")
    for row in result.get("rows", []):
        ticker = str(row.get("ticker", "")).upper()
        if not ticker:
            continue
        enriched = dict(row)
        enriched["last_checked"] = timestamp
        enriched["timeframe"] = timeframe
        analysis_results[ticker] = enriched
    combined = dict(result)
    combined["rows"] = [analysis_results[key] for key in sorted(analysis_results)]
    combined["request_rows"] = result.get("rows", [])
    combined["cached_count"] = len(analysis_results)
    return combined


def send_telegram(token: str, chat_id: str, text: str) -> None:
    if not token or not chat_id:
        return
    url = f"https://api.telegram.org/bot{urllib.parse.quote(token, safe='')}/sendMessage"
    payload = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        data = json.loads(response.read().decode("utf-8"))
    if not data.get("ok"):
        raise ValueError(data.get("description", "Telegram не принял сообщение"))


def send_telegram_document(token: str, chat_id: str, file_path: Path, caption: str = "") -> None:
    if not token or not chat_id:
        return
    if not file_path.exists():
        raise FileNotFoundError(f"PDF файл не найден: {file_path}")

    boundary = f"----CodexBoundary{uuid.uuid4().hex}"
    filename = file_path.name
    mime_type = mimetypes.guess_type(filename)[0] or "application/pdf"
    file_bytes = file_path.read_bytes()

    fields = {
        "chat_id": chat_id,
        "caption": caption,
    }
    body = bytearray()
    for name, value in fields.items():
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        body.extend(str(value).encode("utf-8"))
        body.extend(b"\r\n")
    body.extend(f"--{boundary}\r\n".encode("utf-8"))
    body.extend(
        (
            f'Content-Disposition: form-data; name="document"; filename="{filename}"\r\n'
            f"Content-Type: {mime_type}\r\n\r\n"
        ).encode("utf-8")
    )
    body.extend(file_bytes)
    body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode("utf-8"))

    url = f"https://api.telegram.org/bot{urllib.parse.quote(token, safe='')}/sendDocument"
    req = urllib.request.Request(
        url,
        data=bytes(body),
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        data = json.loads(response.read().decode("utf-8"))
    if not data.get("ok"):
        raise ValueError(data.get("description", "Telegram не принял PDF"))


def build_fundrep_sections(ticker: str, data: dict[str, Any]) -> list[dict[str, Any]]:
    short_name = fmt_metric(metric_value(data, "price", "shortName"))
    sector = fmt_metric(metric_value(data, "assetProfile", "sector"))
    industry = fmt_metric(metric_value(data, "assetProfile", "industry"))
    price = fmt_metric(metric_value(data, "price", "regularMarketPrice"))
    currency = fmt_metric(metric_value(data, "price", "currency"))

    return [
        {
            "title": "1. Profitability / Прибыльность",
            "question": "Компания реально зарабатывает деньги и становится ли бизнес эффективнее?",
            "metrics": [
                ("Компания", short_name, f"Тикер: {ticker}. Сектор: {sector}. Индустрия: {industry}."),
                ("Текущая цена", f"{price} {currency}", "Рыночная цена нужна как отправная точка для сравнения с фундаментальными метриками."),
                ("Revenue Growth / Рост выручки", fmt_percent(metric_value(data, "financialData", "revenueGrowth")), "Показывает темп роста верхней строки. Ускорение роста обычно поддерживает оценку компании."),
                ("Gross Margin / Валовая маржа", fmt_percent(metric_value(data, "financialData", "grossMargins")), "Показывает ценовую силу продукта и эффективность себестоимости."),
                ("Operating Margin / Операционная маржа", fmt_percent(metric_value(data, "financialData", "operatingMargins")), "Показывает прибыльность основного бизнеса после операционных расходов."),
                ("Net Margin / Чистая маржа", fmt_percent(metric_value(data, "financialData", "profitMargins")), "Показывает, сколько прибыли остаётся акционерам после всех расходов."),
                ("EPS / Прибыль на акцию", fmt_metric(metric_value(data, "defaultKeyStatistics", "trailingEps")), "EPS показывает прибыль, приходящуюся на одну акцию."),
                ("EBITDA", fmt_money(metric_value(data, "financialData", "ebitda")), "Грубая оценка операционной денежной генерации до процентов, налогов и амортизации."),
            ],
        },
        {
            "title": "2. Valuation / Оценка стоимости",
            "question": "Хорошая ли это компания по разумной цене, или рынок уже заложил слишком много ожиданий?",
            "metrics": [
                ("Market Cap / Капитализация", fmt_money(metric_value(data, "price", "marketCap")), "Размер компании на рынке. Важно сравнивать с выручкой, прибылью и денежным потоком."),
                ("P/E / Цена к прибыли", fmt_metric(metric_value(data, "summaryDetail", "trailingPE")), "Показывает, сколько инвестор платит за доллар текущей прибыли."),
                ("Forward P/E / Будущий P/E", fmt_metric(metric_value(data, "summaryDetail", "forwardPE")), "Использует ожидаемую прибыль и полезен для растущих компаний, но зависит от прогнозов."),
                ("CAPE / Cyclically Adjusted P/E", fmt_metric(metric_value(data, "defaultKeyStatistics", "capeRatio")), "CAPE сравнивает цену с усреднённой инфляционно сглаженной прибылью за длинный цикл. Он помогает понять, не завышена ли оценка относительно нормализованной прибыли, но для отдельных компаний часто доступен хуже, чем для индексов."),
                ("P/S / Цена к выручке", fmt_metric(metric_value(data, "summaryDetail", "priceToSalesTrailing12Months")), "Особенно полезен для компаний, где прибыль пока нестабильна."),
                ("EV / EBITDA", fmt_metric(metric_value(data, "defaultKeyStatistics", "enterpriseToEbitda")), "Сравнивает стоимость предприятия с EBITDA и учитывает долг."),
                ("PEG Ratio", fmt_metric(metric_value(data, "defaultKeyStatistics", "pegRatio")), "Сравнивает P/E с темпом роста прибыли. Ниже 1 часто выглядит интереснее, но не является автоматическим сигналом."),
                ("P/B / Цена к балансовой стоимости", fmt_metric(metric_value(data, "defaultKeyStatistics", "priceToBook")), "Полезно для банков, страховых и капиталоёмких бизнесов."),
            ],
        },
        {
            "title": "3. Cash Flow / Денежный поток",
            "question": "Настоящая ли прибыль, и превращается ли бизнес в реальные свободные деньги?",
            "metrics": [
                ("Operating Cash Flow / OCF", fmt_money(metric_value(data, "financialData", "operatingCashflow")), "Деньги, которые компания генерирует основной деятельностью."),
                ("Free Cash Flow / FCF", fmt_money(metric_value(data, "financialData", "freeCashflow")), "Деньги после капитальных расходов, доступные для buybacks, дивидендов, долга или роста."),
                ("FCF Margin", "н/д", "FCF margin = FCF / выручка. Если данных выручки недостаточно, показатель нужно досчитать из отчётности."),
                ("FCF Yield", "н/д", "FCF yield = FCF / market cap. Помогает понять доходность свободного денежного потока относительно цены компании."),
            ],
        },
        {
            "title": "4. Financial Health / Финансовое здоровье",
            "question": "Компания выдержит спад и сможет финансировать рост без разрушения баланса?",
            "metrics": [
                ("Debt-to-Equity / D/E", fmt_metric(metric_value(data, "financialData", "debtToEquity")), "Показывает финансовый рычаг и риск зависимости от долга."),
                ("Total Cash / Денежные средства", fmt_money(metric_value(data, "financialData", "totalCash")), "Запас ликвидности для кризиса, инвестиций, buybacks и погашения долга."),
                ("Total Debt / Общий долг", fmt_money(metric_value(data, "financialData", "totalDebt")), "Важно сравнивать с cash, EBITDA и денежным потоком."),
                ("Current Ratio", fmt_metric(metric_value(data, "financialData", "currentRatio")), "Показывает способность закрывать ближайшие обязательства текущими активами."),
                ("ROE / Рентабельность капитала", fmt_percent(metric_value(data, "financialData", "returnOnEquity")), "Показывает эффективность использования капитала акционеров."),
                ("ROA / Рентабельность активов", fmt_percent(metric_value(data, "financialData", "returnOnAssets")), "Показывает эффективность использования всех активов компании."),
            ],
        },
        {
            "title": "5. Forward Signals / Будущие сигналы",
            "question": "Куда меняются ожидания по компании?",
            "metrics": [
                ("Recommendation", fmt_metric(metric_value(data, "financialData", "recommendationKey")), "Сводная рекомендация аналитиков, если Yahoo её предоставляет."),
                ("Target Mean Price", fmt_metric(metric_value(data, "financialData", "targetMeanPrice")), "Средняя целевая цена аналитиков. Это ориентир ожиданий, а не гарантия."),
                ("Earnings Growth", fmt_percent(metric_value(data, "financialData", "earningsGrowth")), "Рост прибыли поддерживает переоценку, если ожидания подтверждаются."),
                ("Revenue Growth", fmt_percent(metric_value(data, "financialData", "revenueGrowth")), "Рост выручки показывает направление спроса на продукт или услугу."),
                ("Beta", fmt_metric(metric_value(data, "summaryDetail", "beta")), "Показывает чувствительность акции к рынку. Выше 1 означает более высокую волатильность."),
                ("Dividend Yield", fmt_percent(metric_value(data, "summaryDetail", "dividendYield")), "Доходность дивидендов важна для компаний, где часть инвестиционной идеи связана с выплатами."),
            ],
        },
    ]


def find_chrome_executable() -> str | None:
    candidates = [
        shutil.which("chrome"),
        shutil.which("chrome.exe"),
        shutil.which("msedge"),
        shutil.which("msedge.exe"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return str(candidate)
    return None


def markdown_to_prompt_html(markdown: str) -> str:
    html_parts = []
    in_paragraph: list[str] = []

    def flush() -> None:
        if in_paragraph:
            html_parts.append(f"<p>{html_escape(' '.join(in_paragraph))}</p>")
            in_paragraph.clear()

    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        if not line:
            flush()
            continue
        if line.startswith("# "):
            flush()
            html_parts.append(f"<h1>{html_escape(line[2:])}</h1>")
        elif line.startswith("## "):
            flush()
            html_parts.append(f"<h2>{html_escape(line[3:])}</h2>")
        elif line.startswith("### "):
            flush()
            html_parts.append(f"<h3>{html_escape(line[4:])}</h3>")
        elif line.startswith("**") and line.endswith("**") and len(line) > 4:
            flush()
            html_parts.append(f"<div class='tag'>{html_escape(line.strip('*'))}</div>")
        else:
            in_paragraph.append(line)
    flush()
    return "\n".join(html_parts)


def dashboard_prompt_markdown(ticker: str) -> str:
    return f"""# Full Perplexity Finance Dashboard Prompt for {ticker}

Use ticker: {ticker}

Create a professional, modern investment dashboard report for {ticker}. The final output must be prepared in PDF format. The report must look institutional-grade: clean layout, clear section hierarchy, concise executive summary, modern visual style, and charts that are easy to compare. Use tables only where they improve readability. Prefer charts, trend lines, dual-axis visuals, reference bands, and short verdict boxes.

For every section, KPI, chart, and verdict, include:

- What the point means in plain language.
- What it can affect: valuation, profitability, risk, liquidity, growth, earnings quality, market sentiment, analyst expectations, or capital efficiency.
- Possible reasons behind the result: business trend, pricing power, cost pressure, debt, buybacks, dilution, macro conditions, sector cycle, accounting effects, one-time items, or estimate revisions.
- Why this matters for an investor and what to monitor next.

The final report should include:

- Executive Summary with 5-7 bullet points.
- Dashboard Overview with the most important KPI cards.
- Four visual analysis blocks: Income Statement, Momentum, Valuation History, Capital & Conviction.
- A final verdict: cheap/fair/expensive, momentum building/fading, quality improving/deteriorating, and key risks.
- All charts should include labels, units, time period, and source notes.
- If a data point is unavailable, mark it as N/A and explain what source would be needed.

## Prompt 01 of 04 - Income Statement

### DATA

Pull {ticker}'s quarterly revenue, net income, and free cash flow for the last 8 quarters. Calculate the YoY growth rate for each metric.

### COMPARE

Are all three metrics growing together, or is there divergence? Compare the FCF-to-net-income conversion ratio each quarter to the sector median.

### INTERPRET

Plot each as a separate bar chart with a YoY growth line overlay. Tell me whether FCF is outpacing, tracking, or lagging net income growth — and what that signals about earnings quality.

## Prompt 02 of 04 - Momentum

### DATA

Pull {ticker}'s LTM revenue, diluted EPS, and FCF with YoY growth rates. Also pull the last 8 quarters of reported EPS vs. analyst consensus EPS, plus the current trailing and forward P/E.

### COMPARE

Is growth accelerating or decelerating across all three metrics? Has the magnitude of EPS beats expanded or shrunk over the last 4 quarters compared to the prior 4?

### INTERPRET

Plot each as dual-axis charts: bars plus YoY line. Tell me whether momentum is building or fading, and whether the NTM P/E is expanding or compressing as estimates are revised.

## Prompt 03 of 04 - Valuation History

### DATA

Pull {ticker}'s current NTM P/E, NTM P/S, NTM EV/EBITDA, and LTM EV/Gross Profit. For each multiple, calculate the 5-year mean and +/-1 standard deviation.

### COMPARE

Where does each multiple sit today relative to its own 5-year mean and standard deviation bands? Is {ticker} cheap, fair value, or expensive versus its own history on each measure?

### INTERPRET

Plot each as a 5-year time series with mean and +/-1 standard deviation as reference lines. Give me a composite verdict: across all 4 multiples, is {ticker} trading at a historical discount or premium?

## Prompt 04 of 04 - Capital & Conviction

### DATA

Pull {ticker}'s LTM P/FCF vs. 5-year mean, revenue per employee over 5 years, quarterly share buybacks vs. diluted shares outstanding for 8 quarters, and current analyst price targets: high, average, low.

### COMPARE

Are buybacks actually reducing diluted share count or just offsetting stock-based compensation dilution? Is revenue per employee improving? What is the upside and downside implied by the analyst target range vs current price?

### INTERPRET

Plot P/FCF as a time series, buybacks vs share count as dual-axis, and revenue per employee as a trend. Give me a verdict on capital efficiency and what the analyst price target range says about institutional conviction.

## Full KPI Framework Prompts

Use the KPI framework below in addition to the 4 dashboard blocks. For every KPI, provide DATA, COMPARE, and INTERPRET. Under each KPI also add a short explanation of what the metric means, what it can influence, possible reasons for improvement or deterioration, and what an investor should monitor next. If data is unavailable, mark it as N/A and state exactly what source or filing is needed.

## Layer 01 - Profitability

### Revenue Growth

**DATA**

Pull {ticker}'s quarterly revenue for the last 8 quarters and calculate YoY and QoQ growth for each period.

**COMPARE**

Compare revenue growth to the sector median and to two direct competitors.

**INTERPRET**

Is growth accelerating or decelerating? Explain whether business momentum is improving or weakening.

### Gross Margin

**DATA**

Pull {ticker}'s gross margin for the last 8 quarters.

**COMPARE**

Compare gross margin to the sector median and to two direct competitors.

**INTERPRET**

Is gross margin expanding or compressing? Explain what this says about pricing power and input cost control.

### Operating Margin

**DATA**

Pull {ticker}'s operating margin or EBIT margin for the last 8 quarters.

**COMPARE**

Compare operating margin to the sector median and to two direct competitors.

**INTERPRET**

Is operating leverage improving? Is the company converting revenue into operating profit more efficiently?

### Net Margin

**DATA**

Pull {ticker}'s net margin for the last 8 quarters.

**COMPARE**

Compare net margin to the sector median and to two direct competitors.

**INTERPRET**

Flag quarters where net margin diverges from operating margin. Identify whether interest expense, tax events, or one-time items drove the divergence.

### Earnings Per Share / EPS

**DATA**

Pull {ticker}'s reported EPS versus analyst consensus EPS for the last 8 quarters. Calculate beat or miss percentage for each quarter.

**COMPARE**

Compare the beat/miss trend to the sector average earnings surprise rate.

**INTERPRET**

Is the magnitude of EPS beats expanding or shrinking? Explain what estimate revisions suggest about analyst sentiment.

### EBITDA

**DATA**

Pull {ticker}'s reported EBITDA versus adjusted EBITDA for the last 8 quarters. List what was excluded from adjustments where available.

**COMPARE**

Compare adjusted EBITDA margin to the sector median and to two direct competitors.

**INTERPRET**

Is the gap between reported and adjusted EBITDA widening? Explain what this signals about earnings quality.

## Layer 02 - Valuation

### Price-to-Earnings / P/E

**DATA**

Pull {ticker}'s current trailing P/E and its own 5-year average P/E.

**COMPARE**

Compare to the sector median P/E and to two direct competitors.

**INTERPRET**

Is the stock trading at a premium or discount to its own history and peers? Explain what that has historically implied for forward returns.

### Forward P/E

**DATA**

Pull {ticker}'s current forward P/E based on NTM consensus EPS and show how it changed over the last 3 months.

**COMPARE**

Compare to the sector median forward P/E and to two direct competitors.

**INTERPRET**

Is the multiple expanding or compressing, and is that driven by price movement or earnings estimate changes?

### CAPE / Cyclically Adjusted P/E

**DATA**

Pull {ticker}'s CAPE ratio where available. If company-level CAPE is unavailable, calculate or approximate it from price divided by long-cycle average inflation-adjusted EPS, and clearly label the method and limitations.

**COMPARE**

Compare CAPE to the company's own long-term valuation history, the sector median where available, and the broad market CAPE as context.

**INTERPRET**

Explain whether valuation looks stretched or reasonable versus normalized earnings. Note that CAPE is more robust for indexes than single companies, so use it as a long-cycle valuation lens rather than a standalone signal.

### Price-to-Sales / P/S

**DATA**

Pull {ticker}'s current P/S ratio and its own 3-year average.

**COMPARE**

Compare to the sector median P/S and to two competitors with similar gross margin profiles.

**INTERPRET**

Given gross margin and revenue growth, is the P/S multiple justified, stretched, or discounted?

### EV / EBITDA

**DATA**

Pull {ticker}'s current EV/EBITDA including net cash or net debt adjustment.

**COMPARE**

Compare to the sector median EV/EBITDA and to two direct competitors.

**INTERPRET**

Is the stock cheap or expensive on an enterprise value basis after adjusting for cash and debt?

### PEG Ratio

**DATA**

Calculate {ticker}'s PEG ratio using current trailing P/E and consensus 3-year EPS CAGR.

**COMPARE**

Compare to the sector median PEG and to two direct competitors.

**INTERPRET**

Does expected earnings growth justify the current P/E multiple?

### Price-to-Book / P/B

**DATA**

Pull {ticker}'s current P/B ratio and its own 5-year average P/B.

**COMPARE**

Compare to sector median P/B and to two direct competitors.

**INTERPRET**

Is the P/B premium or discount justified by ROE quality relative to peers?

## Layer 03 - Cash Flow

### Operating Cash Flow / OCF

**DATA**

Pull {ticker}'s operating cash flow and net income for the last 8 quarters. Calculate OCF-to-net-income conversion ratio.

**COMPARE**

Compare the OCF conversion ratio trend to the sector median.

**INTERPRET**

Does OCF consistently exceed net income? Explain working capital, receivables, deferred revenue, or other drivers of divergence.

### Free Cash Flow / FCF

**DATA**

Pull {ticker}'s FCF for the last 8 quarters and calculate YoY FCF growth.

**COMPARE**

Compare FCF growth to revenue growth and net income growth.

**INTERPRET**

Is FCF conversion improving or deteriorating? Identify capex, working capital, or operating efficiency drivers.

### FCF Margin

**DATA**

Pull {ticker}'s FCF margin for the last 8 quarters.

**COMPARE**

Compare to sector median FCF margin and to two direct competitors.

**INTERPRET**

Is the company in the top or bottom quartile for FCF margin? Estimate the annual cash impact of a 1 percentage-point improvement.

### FCF Yield

**DATA**

Calculate {ticker}'s current FCF yield using last 12 months FCF divided by current market cap.

**COMPARE**

Compare to the current 10-year Treasury yield, sector median FCF yield, and the stock's own 3-year range.

**INTERPRET**

Does FCF yield adequately compensate for equity risk in the current rate environment?

## Layer 04 - Financial Health

### Debt-to-Equity / D/E

**DATA**

Pull {ticker}'s debt-to-equity ratio and interest coverage ratio for each of the last 4 years.

**COMPARE**

Compare to sector median D/E and to two direct competitors.

**INTERPRET**

Is leverage increasing or decreasing? Stress test whether the current debt load remains sustainable if EBITDA falls 30%.

### Net Cash / Net Debt

**DATA**

Pull {ticker}'s cash, short-term investments, and total debt from the latest quarter. Calculate net cash or net debt.

**COMPARE**

Compare net position to sector median and to two direct competitors.

**INTERPRET**

How many quarters of operating expenses does cash cover? Explain management's capital allocation priorities.

### Current Ratio

**DATA**

Pull {ticker}'s current ratio and quick ratio for the last 4 quarters.

**COMPARE**

Compare to sector median current ratio.

**INTERPRET**

Is liquidity improving or deteriorating? Flag unusual receivables, inventory build, or debt maturities in the next 12-18 months.

### Return on Equity / ROE

**DATA**

Pull {ticker}'s ROE for the last 5 years and decompose using DuPont: net margin x asset turnover x financial leverage.

**COMPARE**

Compare to sector median ROE and to two direct competitors.

**INTERPRET**

Is ROE improvement driven by operating efficiency or increased leverage?

### Return on Invested Capital / ROIC

**DATA**

Pull {ticker}'s ROIC for the last 5 years and compare it to estimated WACC.

**COMPARE**

Compare ROIC-to-WACC spread to sector median and to two direct competitors.

**INTERPRET**

Is the company creating or destroying economic value? Is the ROIC-WACC spread widening or narrowing?

## Layer 05 - Forward Signals

### Management Guidance

**DATA**

Pull {ticker}'s most recent management guidance for next quarter and full-year revenue and EPS from the last earnings call.

**COMPARE**

Compare guidance to current analyst consensus and to guidance issued for the same period last year.

**INTERPRET**

Is management guiding above or below consensus? Does management tend to guide conservatively or aggressively?

### Analyst Consensus

**DATA**

Pull current analyst consensus for {ticker}: buy/hold/sell count, median price target, and full range of targets.

**COMPARE**

Show how consensus distribution and median price target changed over the last 3 months.

**INTERPRET**

Is analyst sentiment improving or deteriorating? Flag extreme divergence in targets.

### Earnings Revisions

**DATA**

Pull analyst NTM EPS estimate revisions for {ticker} over the last 90 days.

**COMPARE**

Show what percentage of analysts raised versus lowered estimates and how much consensus moved.

**INTERPRET**

Has the revision trend been a reliable leading indicator for this stock?

### Share Buybacks

**DATA**

Pull {ticker}'s buyback history for the last 8 quarters: dollars spent, shares repurchased, and average price paid.

**COMPARE**

Compare diluted share count today to 2 years ago and calculate net reduction after stock-based compensation.

**INTERPRET**

Are buybacks reducing shares outstanding or merely offsetting SBC dilution? Calculate annualized buyback yield.

### Insider Transactions

**DATA**

Pull all insider buying and selling transactions for {ticker} over the last 6 months: executive role, dollar value, and transaction price.

**COMPARE**

Compare insider buying-to-selling ratio to historical norm for this stock.

**INTERPRET**

Are there cluster buying events? Has insider activity historically been a reliable directional signal for this stock?

## Output Format

Return the report as a polished dashboard-style analysis. Use:

- KPI cards for current valuation, growth, FCF quality, analyst target upside/downside, and capital efficiency.
- Four chart sections matching the four prompts.
- A summary table with metric, current value, historical context, sector/peer context, and interpretation.
- A final investor checklist: Bull Case, Bear Case, Watch Items, and Data Gaps.

Style requirements:

- Professional and modern.
- Clear typography and section spacing.
- Avoid generic commentary; every conclusion must reference a metric or chart.
- Do not present this as investment advice.
- Use concise language suitable for an investor memo.
"""


def print_html_to_pdf(html: str, html_path: Path, output: Path) -> Path:
    html_path.write_text(html, encoding="utf-8")
    chrome = find_chrome_executable()
    if not chrome:
        raise RuntimeError("Не найден Chrome или Edge для создания PDF")
    chrome_profile = REPORTS_DIR / "chrome-pdf-profile"
    chrome_profile.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            str(chrome),
            "--headless=new",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--allow-file-access-from-files",
            f"--user-data-dir={chrome_profile}",
            f"--print-to-pdf={output}",
            html_path.as_uri(),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=45,
    )
    if not output.exists() or output.stat().st_size == 0:
        raise RuntimeError("PDF не был создан")
    return output


def generate_fundrep_pdf(ticker: str, source: str = "auto", fmp_api_key: str = "") -> Path:
    data = fetch_fundamental_data_for_source(ticker, source, fmp_api_key)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    html_path = REPORTS_DIR / f"fundrep_{ticker}_{stamp}.html"
    output = REPORTS_DIR / f"fundrep_{ticker}_{stamp}.pdf"
    section_html = []
    for section in build_fundrep_sections(ticker, data):
        rows = []
        for name, value, explanation in section["metrics"]:
            rows.append(
                "<tr>"
                f"<td class='metric'>{html_escape(str(name))}</td>"
                f"<td class='value'>{html_escape(str(value))}</td>"
                f"<td>{html_escape(str(explanation))}</td>"
                "</tr>"
            )
        section_html.append(
            f"""
            <section>
              <h2>{html_escape(section['title'])}</h2>
              <p class="question">{html_escape(section['question'])}</p>
              <table>
                <thead><tr><th>Метрика</th><th>Значение</th><th>Объяснение</th></tr></thead>
                <tbody>{''.join(rows)}</tbody>
              </table>
            </section>
            """
        )

    html = f"""<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>FundRep {html_escape(ticker)}</title>
  <style>
    @page {{ size: A4; margin: 14mm; }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      color: #111827;
      font-family: Arial, "Segoe UI", sans-serif;
      font-size: 12px;
      line-height: 1.45;
      background: #fff;
    }}
    .cover {{
      border-bottom: 3px solid #15803d;
      padding-bottom: 12px;
      margin-bottom: 14px;
    }}
    h1 {{ margin: 0 0 8px; font-size: 27px; line-height: 1.15; }}
    h2 {{
      margin: 18px 0 6px;
      color: #0f5132;
      font-size: 17px;
      break-after: avoid;
    }}
    .meta {{ color: #4b5563; margin: 0; }}
    .question {{
      margin: 0 0 8px;
      color: #374151;
      font-weight: 700;
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 8px;
      page-break-inside: auto;
    }}
    tr {{ page-break-inside: avoid; page-break-after: auto; }}
    th {{
      background: #e9f7ef;
      color: #111827;
      text-align: left;
      font-size: 11px;
      padding: 7px;
      border: 1px solid #cfd8d3;
    }}
    td {{
      vertical-align: top;
      padding: 7px;
      border: 1px solid #d1d5db;
      font-size: 11px;
    }}
    .metric {{ width: 27%; font-weight: 700; }}
    .value {{ width: 16%; color: #0f5132; font-weight: 700; }}
    .note {{
      color: #4b5563;
      border-top: 1px solid #d1d5db;
      margin-top: 14px;
      padding-top: 10px;
      font-size: 10px;
    }}
  </style>
</head>
<body>
  <div class="cover">
    <h1>FundRep: фундаментальный отчёт по {html_escape(ticker)}</h1>
    <p class="meta">Дата: {datetime.now().strftime('%Y-%m-%d %H:%M')} · Не является инвестиционной рекомендацией.</p>
  </div>
  {''.join(section_html)}
  <p class="note">Короткая шпаргалка: Profitability отвечает на вопрос о качестве прибыли; Valuation — о цене; Cash Flow — о реальных деньгах; Financial Health — о прочности баланса; Forward Signals — об ожиданиях рынка.</p>
</body>
</html>
"""
    return print_html_to_pdf(html, html_path, output)


def generate_promtrep_pdf(ticker: str) -> Path:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    html_path = REPORTS_DIR / f"promtrep_{ticker}_{stamp}.html"
    output = REPORTS_DIR / f"promtrep_{ticker}_{stamp}.pdf"
    markdown = dashboard_prompt_markdown(ticker)
    body = markdown_to_prompt_html(markdown)
    html = f"""<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>PromtRep {html_escape(ticker)}</title>
  <style>
    @page {{ size: A4; margin: 14mm; }}
    body {{
      margin: 0;
      color: #111827;
      font-family: Arial, "Segoe UI", sans-serif;
      font-size: 11.5px;
      line-height: 1.5;
      background: #fff;
    }}
    h1 {{
      margin: 0 0 12px;
      padding-bottom: 10px;
      border-bottom: 3px solid #2563eb;
      font-size: 25px;
      line-height: 1.15;
    }}
    h2 {{
      margin: 18px 0 8px;
      color: #1d4ed8;
      font-size: 17px;
      break-after: avoid;
      border-bottom: 1px solid #bfdbfe;
      padding-bottom: 4px;
    }}
    h3 {{
      margin: 13px 0 6px;
      font-size: 13.5px;
      color: #111827;
      break-after: avoid;
    }}
    p {{ margin: 0 0 7px; }}
    .tag {{
      display: inline-block;
      margin: 4px 0 4px;
      padding: 3px 7px;
      border-radius: 5px;
      background: #eff6ff;
      color: #1d4ed8;
      border: 1px solid #bfdbfe;
      font-weight: 700;
      font-size: 10px;
      letter-spacing: .04em;
    }}
    .intro {{
      margin: 0 0 14px;
      padding: 10px 12px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #f9fafb;
      color: #374151;
      font-size: 11px;
    }}
  </style>
</head>
<body>
  <div class="intro">Готовый полный промт для Perplexity Finance по тикеру <b>{html_escape(ticker)}</b>. Промт собран из 4 dashboard-блоков: Income Statement, Momentum, Valuation History, Capital & Conviction. Внутри прописано, что итоговый репорт должен выглядеть профессионально и современно, с графиками и KPI-карточками.</div>
  {body}
</body>
</html>
"""
    return print_html_to_pdf(html, html_path, output)


def telegram_get_updates(token: str, offset: int | None, timeout: int = 20) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"timeout": timeout, "allowed_updates": json.dumps(["message"])}
    if offset is not None:
        params["offset"] = offset
    url = f"https://api.telegram.org/bot{urllib.parse.quote(token, safe='')}/getUpdates?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout + 5) as response:
        data = json.loads(response.read().decode("utf-8"))
    if not data.get("ok"):
        raise ValueError(data.get("description", "Telegram getUpdates error"))
    return data.get("result", [])


def parse_telegram_command(text: str) -> list[str]:
    cleaned = text.strip()
    if not cleaned:
        return []
    if cleaned.startswith("/start"):
        return []
    if cleaned.startswith("/help"):
        return []
    if cleaned.startswith("/scan"):
        cleaned = cleaned.replace("/scan", "", 1).strip()
    tokens = parse_tickers(cleaned)
    ignored = {"SCAN", "START", "HELP"}
    return [token for token in tokens if token not in ignored]


def parse_fundrep_tickers(text: str) -> list[str] | None:
    cleaned = text.strip()
    match = re.match(r"^/?fundrep(?:@\w+)?(?:\s+(.+))?$", cleaned, flags=re.IGNORECASE)
    if not match:
        return None
    rest = match.group(1) or ""
    return parse_tickers(rest)


def parse_promtrep_tickers(text: str) -> list[str] | None:
    cleaned = text.strip()
    match = re.match(r"^/?promtrep(?:@\w+)?(?:\s+(.+))?$", cleaned, flags=re.IGNORECASE)
    if not match:
        return None
    rest = match.group(1) or ""
    return parse_tickers(rest)


def send_fundrep_pdf(token: str, chat_id: str, ticker: str, config: dict[str, Any] | None = None) -> None:
    if not is_valid_ticker(ticker):
        send_telegram(token, chat_id, f"{ticker}: {ticker_validation_error(ticker)}")
        return
    config = config or {}
    source = str(config.get("fundrepSource", "auto"))
    send_telegram(token, chat_id, f"⏳ Готовлю FundRep PDF по {ticker}...")
    report_path = generate_fundrep_pdf(
        ticker,
        source,
        config,
    )
    send_telegram_document(
        token,
        chat_id,
        report_path,
        f"FundRep {ticker}: фундаментальный отчёт с разделами, метриками и объяснениями.",
    )


def send_promtrep_pdf(token: str, chat_id: str, ticker: str) -> None:
    if not is_valid_ticker(ticker):
        send_telegram(token, chat_id, f"{ticker}: {ticker_validation_error(ticker)}")
        return
    send_telegram(token, chat_id, f"⏳ Готовлю PromtRep PDF по {ticker}...")
    report_path = generate_promtrep_pdf(ticker)
    send_telegram_document(
        token,
        chat_id,
        report_path,
        f"PromtRep {ticker}: полный промт для Perplexity по KPI-анализу.",
    )


def telegram_listener_loop(config: dict[str, Any]) -> None:
    global telegram_offset
    token = str(config.get("telegramToken", "")).strip()
    if not token:
        scheduler_state["telegram_listening"] = False
        return

    scheduler_state["telegram_listening"] = True
    if telegram_offset is None:
        old_updates = telegram_get_updates(token, None, timeout=1)
        if old_updates:
            telegram_offset = int(old_updates[-1]["update_id"]) + 1
    while not telegram_stop.is_set():
        try:
            updates = telegram_get_updates(token, telegram_offset)
            for update in updates:
                telegram_offset = int(update["update_id"]) + 1
                message = update.get("message") or {}
                incoming_chat_id = str((message.get("chat") or {}).get("id", ""))
                text = str(message.get("text") or "")
                origin = telegram_origin(message)
                current_config = dict(active_bot_config or config)
                promtrep_tickers = parse_promtrep_tickers(text)
                if promtrep_tickers is not None:
                    if not promtrep_tickers:
                        send_telegram(token, incoming_chat_id, "Напишите команду с тикером, например: PromtRep AAPL")
                        continue
                    add_request_log(origin, "PromtRep", promtrep_tickers, "started")
                    for ticker in promtrep_tickers:
                        try:
                            send_promtrep_pdf(token, incoming_chat_id, ticker)
                            add_request_log(origin, "PromtRep", ticker, "ok")
                        except Exception as exc:
                            scheduler_state["last_error"] = str(exc)
                            add_request_log(origin, "PromtRep", ticker, "error", str(exc))
                            send_telegram(
                                token,
                                incoming_chat_id,
                                f"⚠️ Не смог создать PromtRep по {ticker}: {exc}",
                            )
                    continue
                fundrep_tickers = parse_fundrep_tickers(text)
                if fundrep_tickers is not None:
                    if not fundrep_tickers:
                        send_telegram(token, incoming_chat_id, "Напишите команду с тикером, например: FundRep AAPL")
                        continue
                    add_request_log(
                        origin,
                        "FundRep",
                        fundrep_tickers,
                        "started",
                        f"source={current_config.get('fundrepSource', 'auto')}",
                    )
                    for ticker in fundrep_tickers:
                        try:
                            send_fundrep_pdf(token, incoming_chat_id, ticker, current_config)
                            add_request_log(
                                origin,
                                "FundRep",
                                ticker,
                                "ok",
                                f"source={current_config.get('fundrepSource', 'auto')}",
                            )
                        except Exception as exc:
                            scheduler_state["last_error"] = str(exc)
                            add_request_log(
                                origin,
                                "FundRep",
                                ticker,
                                "error",
                                str(exc),
                            )
                            send_telegram(
                                token,
                                incoming_chat_id,
                                f"⚠️ Не смог создать FundRep по {ticker}: {exc}",
                            )
                    continue
                tickers = parse_telegram_command(text)
                if not tickers:
                    send_telegram(token, incoming_chat_id, "Напишите тикер или список тикеров: AAPL или AAPL, MSFT")
                    continue
                request_config = dict(current_config)
                request_config["tickers"] = ", ".join(tickers)
                request_config["telegramChatId"] = incoming_chat_id
                request_config["requestOrigin"] = origin
                run_analysis(request_config, notify=True)
        except Exception as exc:
            scheduler_state["last_error"] = str(exc)
            telegram_stop.wait(5)
    scheduler_state["telegram_listening"] = False


def test_telegram(config: dict[str, Any]) -> dict[str, Any]:
    token = str(config.get("telegramToken", "")).strip()
    chat_id = str(config.get("telegramChatId", "")).strip()
    if not token:
        raise ValueError("Введите Bot token")
    if not chat_id:
        raise ValueError("Введите Chat ID")
    send_telegram(token, chat_id, f"✅ Тест Telegram работает\nВремя: {now_iso()}")
    return {"ok": True, "message": "Тестовое сообщение отправлено в Telegram"}


def run_external_analysis(payload: dict[str, Any], origin: str, provided_token: str) -> dict[str, Any]:
    base_config = dict(active_bot_config or load_app_config())
    expected_token = str(base_config.get("externalApiToken", "")).strip()
    if not expected_token:
        raise ValueError("В настройках укажите Webhook/API token для внешнего сервера")
    if not provided_token or not hmac.compare_digest(provided_token, expected_token):
        raise PermissionError("Неверный Webhook/API token")

    tickers = payload.get("tickers", payload.get("ticker", ""))
    parsed_tickers = parse_tickers(tickers)
    if not parsed_tickers:
        raise ValueError("Передайте ticker или tickers")

    request_config = dict(base_config)
    request_config["tickers"] = ", ".join(parsed_tickers)
    request_config["requestOrigin"] = origin
    for key in ["timeframe", "risk", "anchorBars", "strategies"]:
        if key in payload:
            request_config[key] = payload[key]
    chat_id = extract_reply_chat_id(payload)
    if chat_id:
        request_config["telegramChatId"] = chat_id

    add_request_log(origin, "External webhook", parsed_tickers, "accepted")
    return run_analysis(request_config, notify=True)


def extract_reply_chat_id(payload: dict[str, Any]) -> str:
    candidates = [
        payload.get("telegramChatId"),
        payload.get("chatId"),
        (payload.get("telegram") or {}).get("chatId") if isinstance(payload.get("telegram"), dict) else None,
        (payload.get("telegram") or {}).get("chat_id") if isinstance(payload.get("telegram"), dict) else None,
        ((payload.get("telegram") or {}).get("chat") or {}).get("id") if isinstance(payload.get("telegram"), dict) and isinstance((payload.get("telegram") or {}).get("chat"), dict) else None,
        (payload.get("chat") or {}).get("id") if isinstance(payload.get("chat"), dict) else None,
        ((payload.get("message") or {}).get("chat") or {}).get("id") if isinstance(payload.get("message"), dict) and isinstance((payload.get("message") or {}).get("chat"), dict) else None,
        (((payload.get("update") or {}).get("message") or {}).get("chat") or {}).get("id") if isinstance(payload.get("update"), dict) and isinstance((payload.get("update") or {}).get("message"), dict) and isinstance(((payload.get("update") or {}).get("message") or {}).get("chat"), dict) else None,
    ]
    value = next((candidate for candidate in candidates if candidate is not None and str(candidate).strip()), "")
    return str(value).strip()


def should_run_now(start: str, end: str) -> bool:
    if not start or not end:
        return True
    current = datetime.now().time()
    start_time = day_time.fromisoformat(start)
    end_time = day_time.fromisoformat(end)
    if start_time <= end_time:
        return start_time <= current <= end_time
    return current >= start_time or current <= end_time


def run_analysis(config: dict[str, Any], notify: bool = True) -> dict[str, Any]:
    tickers = parse_tickers(config.get("tickers", ""))
    if not tickers:
        raise ValueError("Добавьте хотя бы один тикер")
    origin = str(config.get("requestOrigin") or ("web/manual" if notify else "internal"))
    add_request_log(origin, "Signal analysis", tickers, "started")
    timeframe = config.get("timeframe", "1d")
    strategies = config.get("strategies") or ["trend"]
    risk = float(config.get("risk", 1) or 1)
    anchor_bars = int(config.get("anchorBars", 120) or 120)
    token = str(config.get("telegramToken", "")).strip()
    chat_id = str(config.get("telegramChatId", "")).strip()

    rows = []
    sent = []
    errors = [
        {"ticker": ticker, "error": ticker_validation_error(ticker)}
        for ticker in tickers
        if not is_valid_ticker(ticker)
    ]
    for ticker in tickers:
        if not is_valid_ticker(ticker):
            continue
        try:
            row = analyze_ticker(ticker, timeframe, strategies, risk, anchor_bars)
            rows.append(row)
            for signal in row["signals"]:
                signal["message"] = telegram_message(signal)
        except Exception as exc:
            errors.append({"ticker": ticker, "error": str(exc)})

    result = {
        "timestamp": now_iso(),
        "timeframe": timeframe,
        "rows": rows,
        "sent": sent,
        "errors": errors,
    }
    if notify and token and chat_id:
        send_telegram(token, chat_id, analysis_report_message(result))
        sent.append({"ticker": "ALL", "strategy": "Analysis report", "side": "report", "destination": "telegram", "chatId": chat_id})
        result["reply"] = {"type": "telegram", "chatId": chat_id, "delivered": True}
    else:
        result["reply"] = {"type": "http", "delivered": True}
    result = update_analysis_results(result)
    scheduler_state["last_run"] = result["timestamp"]
    scheduler_state["last_result"] = result
    scheduler_state["last_error"] = errors[-1]["error"] if errors else None
    add_request_log(origin, "Signal analysis", tickers, "ok" if not errors else "partial", f"errors={len(errors)}")
    return result


def scheduler_loop(config: dict[str, Any]) -> None:
    interval_minutes = max(1, int(config.get("intervalMinutes", 15) or 15))
    while not scheduler_stop.is_set():
        try:
            if should_run_now(config.get("startTime", ""), config.get("endTime", "")):
                run_analysis(config, notify=True)
            scheduler_state["next_run"] = datetime.fromtimestamp(time.time() + interval_minutes * 60).isoformat(timespec="seconds")
        except Exception as exc:
            scheduler_state["last_error"] = str(exc)
        scheduler_stop.wait(interval_minutes * 60)
    scheduler_state["running"] = False
    scheduler_state["next_run"] = None


def start_scheduler(config: dict[str, Any]) -> dict[str, Any]:
    global scheduler_thread, telegram_thread, active_bot_config
    with scheduler_lock:
        active_bot_config = persist_active_config(config)
        if scheduler_state["running"]:
            add_request_log(
                "web/manual",
                "Settings update",
                parse_tickers(config.get("tickers", "")),
                "ok",
                f"fundrepSource={config.get('fundrepSource', 'auto')}",
            )
            return scheduler_state
        scheduler_stop.clear()
        telegram_stop.clear()
        scheduler_state["running"] = True
        scheduler_state["last_error"] = None
        scheduler_thread = threading.Thread(target=scheduler_loop, args=(active_bot_config,), daemon=True)
        scheduler_thread.start()
        add_request_log("web/manual", "Start", parse_tickers(config.get("tickers", "")), "ok", f"fundrepSource={config.get('fundrepSource', 'auto')}")
        if str(config.get("telegramToken", "")).strip():
            telegram_thread = threading.Thread(target=telegram_listener_loop, args=(active_bot_config,), daemon=True)
            telegram_thread.start()
        return scheduler_state


def stop_scheduler() -> dict[str, Any]:
    scheduler_stop.set()
    telegram_stop.set()
    scheduler_state["running"] = False
    scheduler_state["next_run"] = None
    scheduler_state["telegram_listening"] = False
    add_request_log("web/manual", "Stop", "-", "ok")
    return scheduler_state


HTML = r"""<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Stock Signal Scanner</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101417;
      --panel: #171d21;
      --panel-2: #1d2529;
      --line: #2c363b;
      --text: #eef4ef;
      --muted: #9dafaa;
      --green: #34d399;
      --red: #fb7185;
      --amber: #f4b860;
      --blue: #7dd3fc;
      --shadow: 0 20px 50px rgba(0,0,0,.28);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, rgba(125, 211, 252, .08), transparent 360px),
        var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    button, input, textarea, select { font: inherit; }
    .shell { max-width: 1440px; margin: 0 auto; padding: 28px; }
    header {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: flex-start;
      margin-bottom: 24px;
    }
    h1 { margin: 0; font-size: 30px; font-weight: 760; }
    .sub { margin: 8px 0 0; color: var(--muted); max-width: 780px; line-height: 1.5; }
    .status {
      display: grid;
      grid-template-columns: repeat(3, minmax(130px, 1fr));
      gap: 10px;
      min-width: 430px;
    }
    .metric {
      background: rgba(23, 29, 33, .78);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      box-shadow: var(--shadow);
    }
    .metric span { display: block; color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin-top: 4px; font-size: 15px; }
    main {
      display: grid;
      grid-template-columns: minmax(330px, 430px) 1fr;
      gap: 18px;
      align-items: start;
    }
    .panel {
      background: rgba(23, 29, 33, .92);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .form { padding: 18px; display: grid; gap: 16px; }
    .section-title {
      color: var(--blue);
      font-size: 12px;
      font-weight: 760;
      text-transform: uppercase;
      letter-spacing: .08em;
      margin-bottom: 8px;
    }
    label { color: var(--muted); font-size: 13px; display: grid; gap: 7px; }
    input, textarea, select {
      width: 100%;
      color: var(--text);
      background: #0d1114;
      border: 1px solid #334047;
      border-radius: 7px;
      padding: 10px 11px;
      outline: none;
    }
    textarea { min-height: 90px; resize: vertical; }
    input:focus, textarea:focus, select:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(125,211,252,.12); }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .strategies { display: grid; gap: 8px; }
    .check {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 10px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      border-radius: 7px;
      color: var(--text);
      font-size: 14px;
    }
    .check input { width: 16px; height: 16px; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .actions button:first-child { grid-column: 1 / -1; }
    button {
      border: 0;
      border-radius: 7px;
      color: #07100c;
      background: var(--green);
      padding: 11px 12px;
      font-weight: 760;
      cursor: pointer;
      min-height: 44px;
    }
    button.secondary { background: var(--blue); color: #071016; }
    button.danger { background: var(--red); color: #18070b; }
    button:disabled { opacity: .55; cursor: wait; }
    .hint { color: var(--muted); font-size: 12px; line-height: 1.45; margin: 0; }
    .workspace { display: grid; gap: 18px; }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
    }
    .toolbar strong { font-size: 16px; }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      border-radius: 999px;
      padding: 4px 10px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: #11171a;
      font-size: 12px;
    }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 840px; }
    th, td { padding: 12px 14px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; font-weight: 700; background: rgba(13,17,20,.4); }
    td { font-size: 14px; }
    .ticker { font-weight: 800; }
    .long { color: var(--green); font-weight: 760; }
    .short { color: var(--red); font-weight: 760; }
    .none { color: var(--muted); }
    .signals { display: grid; gap: 10px; padding: 16px; }
    .logs { display: grid; gap: 8px; padding: 14px 16px 16px; }
    .log-row {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 10px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #11171a;
      font-size: 12px;
      line-height: 1.4;
    }
    .log-row strong { color: var(--text); }
    .log-row span { color: var(--muted); }
    .log-note {
      margin: 12px 16px 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .signal {
      border: 1px solid var(--line);
      border-left: 4px solid var(--green);
      background: #11171a;
      border-radius: 8px;
      padding: 13px;
      white-space: pre-line;
      line-height: 1.45;
    }
    .signal.short-border { border-left-color: var(--red); }
    .empty { color: var(--muted); padding: 22px; text-align: center; }
    .toast {
      min-height: 42px;
      color: var(--amber);
      padding: 0 18px 16px;
      font-size: 13px;
      line-height: 1.45;
    }
    @media (max-width: 980px) {
      .shell { padding: 18px; }
      header, main { display: grid; grid-template-columns: 1fr; }
      .status { min-width: 0; grid-template-columns: 1fr; }
      h1 { font-size: 25px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div>
        <h1>Stock Signal Scanner</h1>
        <p class="sub">Тикеры → цены → стратегия → сигнал → Telegram. Это инструмент для мониторинга, не финансовая рекомендация.</p>
      </div>
      <div class="status">
        <div class="metric"><span>Сканер</span><strong id="running">Остановлен</strong></div>
        <div class="metric"><span>Последний анализ</span><strong id="lastRun">-</strong></div>
        <div class="metric"><span>Следующий запуск</span><strong id="nextRun">-</strong></div>
      </div>
    </header>

    <main>
      <aside class="panel form">
        <div>
          <div class="section-title">Рынок</div>
          <label>Тикеры
            <textarea id="tickers">AAPL, MSFT, NVDA, TSLA</textarea>
          </label>
        </div>

        <div class="grid-2">
          <label>Таймфрейм
            <select id="timeframe">
              <option value="1m">1 минута</option>
              <option value="5m">5 минут</option>
              <option value="15m">15 минут</option>
              <option value="30m">30 минут</option>
              <option value="1h">1 час</option>
              <option value="1d" selected>1 день</option>
              <option value="1wk">1 неделя</option>
            </select>
          </label>
          <label>Риск, %
            <input id="risk" type="number" min="0.1" step="0.1" value="1">
          </label>
        </div>

        <div>
          <div class="section-title">Стратегии</div>
          <div class="strategies">
            <label class="check"><input type="checkbox" name="strategy" value="trend" checked> Trend Following</label>
            <label class="check"><input type="checkbox" name="strategy" value="breakout" checked> Breakout Trading</label>
            <label class="check"><input type="checkbox" name="strategy" value="volume_avwap" checked> Volume Profile + AVWAP</label>
            <label class="check"><input type="checkbox" name="strategy" value="momentum" checked> Momentum Trading</label>
          </div>
        </div>

        <div>
          <div class="section-title">Время анализа</div>
          <div class="grid-2">
            <label>Начало
              <input id="startTime" type="time" value="09:30">
            </label>
            <label>Конец
              <input id="endTime" type="time" value="16:00">
            </label>
          </div>
        </div>

        <div class="grid-2">
          <label>Интервал, минут
            <input id="intervalMinutes" type="number" min="1" value="15">
          </label>
          <label>AVWAP, свечей
            <input id="anchorBars" type="number" min="20" value="120">
          </label>
        </div>

        <div>
          <div class="section-title">Telegram</div>
          <label>Bot token
            <input id="telegramToken" type="password" autocomplete="off" placeholder="123456:ABC...">
          </label>
        </div>
        <label>Chat ID для теста или веб-отчёта
          <input id="telegramChatId" placeholder="Можно оставить пустым для ответов пользователям бота">
        </label>
        <label>Webhook/API token для внешнего сервера
          <input id="externalApiToken" type="password" autocomplete="off" placeholder="Секретный токен для входящих запросов">
        </label>

        <div>
          <div class="section-title">FundRep</div>
          <label>Источник данных
            <select id="fundrepSource">
              <option value="auto" selected>Auto: первый доступный источник</option>
              <option value="fmp">Financial Modeling Prep</option>
              <option value="alpha_vantage">Alpha Vantage</option>
              <option value="polygon">Polygon.io</option>
              <option value="finnhub">Finnhub</option>
              <option value="twelve_data">Twelve Data</option>
              <option value="yahoo_paid">Платный/официальный Yahoo Finance API</option>
              <option value="yahoo">Yahoo fallback</option>
            </select>
          </label>
        </div>
        <label>Financial Modeling Prep API key
          <input id="fmpApiKey" type="password" autocomplete="off" placeholder="Сохраняется локально">
        </label>
        <label>Alpha Vantage API key
          <input id="alphaVantageApiKey" type="password" autocomplete="off" placeholder="Сохраняется локально">
        </label>
        <label>Polygon.io API key
          <input id="polygonApiKey" type="password" autocomplete="off" placeholder="Сохраняется локально">
        </label>
        <label>Finnhub API key
          <input id="finnhubApiKey" type="password" autocomplete="off" placeholder="Сохраняется локально">
        </label>
        <label>Twelve Data API key
          <input id="twelveDataApiKey" type="password" autocomplete="off" placeholder="Сохраняется локально">
        </label>
        <label>Yahoo paid API key
          <input id="yahooPaidApiKey" type="password" autocomplete="off" placeholder="Сохраняется локально">
        </label>
        <label>Yahoo paid API host
          <input id="yahooPaidApiHost" autocomplete="off" placeholder="Например, host из RapidAPI">
        </label>

        <div class="actions">
          <button id="analyzeBtn">▶ Анализ сейчас</button>
          <button class="secondary" id="testTelegramBtn">✉ Тест Telegram</button>
          <button class="secondary" id="saveSettingsBtn">💾 Сохранить ключи</button>
          <button class="secondary" id="startBtn">⏱ Старт</button>
          <button class="danger" id="stopBtn">■ Стоп</button>
        </div>
        <p class="hint">После кнопки «Старт» пользователи могут писать боту тикер в личку. Бот отвечает одним сообщением с отчётом и списком сигналов.</p>
      </aside>

      <section class="workspace">
        <div class="panel">
          <div class="toolbar">
            <strong>Результаты</strong>
            <span class="pill" id="summary">Нет данных</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Тикер</th>
                  <th>Цена</th>
                  <th>EMA200</th>
                  <th>AVWAP</th>
                  <th>ATR14</th>
                  <th>MMA150</th>
                  <th>POC</th>
                  <th>RSI</th>
                  <th>Momentum</th>
                  <th>Сигнал</th>
                </tr>
              </thead>
              <tbody id="rows"><tr><td colspan="10" class="empty">Запустите анализ</td></tr></tbody>
            </table>
          </div>
          <div class="toast" id="toast"></div>
        </div>

        <div class="panel">
          <div class="toolbar">
            <strong>Логи запросов</strong>
            <span class="pill" id="logCount">0 записей</span>
            <button class="secondary small" id="clearLogsBtn">Очистить</button>
          </div>
          <p class="log-note">Telegram не передаёт IP или физический адрес пользователя. Для Telegram логируются chat id, user id, username, имя, тип чата и язык; физический адрес возможен только если пользователь сам отправит геолокацию.</p>
          <div class="logs" id="requestLogs"><div class="empty">Пока запросов нет</div></div>
        </div>
      </section>
    </main>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[char]));
    const formatSignedPercent = (value) => {
      if (value === null || value === undefined || value === "") return "-";
      const number = Number(value);
      if (Number.isNaN(number)) return "-";
      return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
    };

    function config() {
      return {
        tickers: $("tickers").value,
        timeframe: $("timeframe").value,
        risk: Number($("risk").value || 1),
        intervalMinutes: Number($("intervalMinutes").value || 15),
        anchorBars: Number($("anchorBars").value || 120),
        startTime: $("startTime").value,
        endTime: $("endTime").value,
        telegramToken: $("telegramToken").value,
        telegramChatId: $("telegramChatId").value,
        externalApiToken: $("externalApiToken").value,
        fundrepSource: $("fundrepSource").value,
        fmpApiKey: $("fmpApiKey").value,
        alphaVantageApiKey: $("alphaVantageApiKey").value,
        polygonApiKey: $("polygonApiKey").value,
        finnhubApiKey: $("finnhubApiKey").value,
        twelveDataApiKey: $("twelveDataApiKey").value,
        yahooPaidApiKey: $("yahooPaidApiKey").value,
        yahooPaidApiHost: $("yahooPaidApiHost").value,
        strategies: [...document.querySelectorAll("input[name=strategy]:checked")].map(el => el.value),
      };
    }

    function applySettings(settings) {
      [
        "tickers", "timeframe", "risk", "intervalMinutes", "anchorBars", "startTime", "endTime",
        "telegramToken", "telegramChatId", "externalApiToken", "fundrepSource", "fmpApiKey", "alphaVantageApiKey",
        "polygonApiKey", "finnhubApiKey", "twelveDataApiKey", "yahooPaidApiKey", "yahooPaidApiHost"
      ].forEach(id => {
        if ($(id) && settings[id] !== undefined && settings[id] !== null) $(id).value = settings[id];
      });
      if (Array.isArray(settings.strategies)) {
        document.querySelectorAll("input[name=strategy]").forEach(el => {
          el.checked = settings.strategies.includes(el.value);
        });
      }
    }

    async function loadSettings() {
      const settings = await fetch("/api/config").then(r => r.json());
      applySettings(settings || {});
    }

    async function post(path, payload = {}) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Ошибка запроса");
      return data;
    }

    function setBusy(busy) {
      ["analyzeBtn", "testTelegramBtn", "saveSettingsBtn", "startBtn", "stopBtn", "clearLogsBtn"].forEach(id => $(id).disabled = busy);
    }

    function renderStatus(state) {
      $("running").textContent = state.running
        ? (state.telegram_listening ? "Работает · Telegram слушает" : "Работает")
        : "Остановлен";
      $("lastRun").textContent = state.last_run || "-";
      $("nextRun").textContent = state.next_run || "-";
      renderLogs(state.request_logs || []);
    }

    function renderLogs(logs) {
      $("logCount").textContent = `${logs.length} записей`;
      $("requestLogs").innerHTML = logs.length ? logs.map(log => `
        <div class="log-row">
          <span>${esc(log.time || "-")}</span>
          <div>
            <strong>${esc(log.action || "-")} · ${esc(log.status || "-")}</strong><br>
            <span>Откуда: ${esc(log.origin || "-")}</span><br>
            <span>Тикеры: ${esc(log.tickers || "-")}</span>
            ${log.detail ? `<br><span>Детали: ${esc(log.detail)}</span>` : ""}
          </div>
        </div>
      `).join("") : `<div class="empty">Пока запросов нет</div>`;
    }

    function renderResult(result) {
      const rows = result.rows || [];
      $("summary").textContent = `${rows.length} тикеров · ${result.timeframe}`;
      $("rows").innerHTML = rows.length ? rows.map(row => {
        const directionIcon = row.direction === "up" ? "🟢⬆️" : row.direction === "down" ? "🔴⬇️" : "⚪➡️";
        const change = Number(row.change || 0);
        const changePercent = Number(row.change_percent || 0);
        const changeText = `${change > 0 ? "+" : ""}${change.toFixed(2)} (${changePercent > 0 ? "+" : ""}${changePercent.toFixed(2)}%)`;
        const signalText = row.signals.length
          ? row.signals.map(s => `<span class="${s.side === "long" ? "long" : "short"}">${esc(s.side).toUpperCase()} · ${esc(s.strategy)}</span>`).join("<br>")
          : `<span class="none">нет</span>`;
        return `<tr>
          <td class="ticker">${esc(row.ticker)}</td>
          <td>${directionIcon} ${esc(row.price ?? "-")}<br><span class="none">${esc(changeText)}</span></td>
          <td>${esc(row.ema200 ?? "-")}</td>
          <td>${esc(row.avwap ?? "-")}</td>
          <td>${esc(row.atr14 ?? "-")}</td>
          <td>${esc(row.mma150 ?? "-")}<br><span class="none">${esc(formatSignedPercent(row.mma150_distance_percent))}</span></td>
          <td>${esc(row.poc ?? "-")}</td>
          <td>${esc(row.rsi14 ?? "-")}</td>
          <td>${esc(row.roc20 ?? "-")}%<br><span class="none">${esc(row.last_checked || "")}</span></td>
          <td>${signalText}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="10" class="empty">Нет данных</td></tr>`;

      const errors = result.errors || [];
      $("toast").textContent = errors.length ? errors.map(e => `${e.ticker}: ${e.error}`).join(" · ") : "";
    }

    async function refreshStatus() {
      try {
        const state = await fetch("/api/status").then(r => r.json());
        renderStatus(state);
        if (state.last_result) renderResult(state.last_result);
      } catch (error) {
        $("toast").textContent = error.message;
      }
    }

    $("analyzeBtn").addEventListener("click", async () => {
      setBusy(true);
      $("toast").textContent = "Идёт анализ...";
      try {
        const result = await post("/api/analyze", config());
        renderResult(result);
        await refreshStatus();
      } catch (error) {
        $("toast").textContent = error.message;
      } finally {
        setBusy(false);
      }
    });

    $("testTelegramBtn").addEventListener("click", async () => {
      setBusy(true);
      $("toast").textContent = "Отправляю тестовое сообщение...";
      try {
        const result = await post("/api/test-telegram", config());
        $("toast").textContent = result.message;
      } catch (error) {
        $("toast").textContent = error.message;
      } finally {
        setBusy(false);
      }
    });

    $("saveSettingsBtn").addEventListener("click", async () => {
      setBusy(true);
      $("toast").textContent = "Сохраняю настройки...";
      try {
        await post("/api/save-settings", config());
        $("toast").textContent = "Настройки и ключи сохранены локально";
        await refreshStatus();
      } catch (error) {
        $("toast").textContent = error.message;
      } finally {
        setBusy(false);
      }
    });

    $("startBtn").addEventListener("click", async () => {
      setBusy(true);
      try {
        renderStatus(await post("/api/start", config()));
      } catch (error) {
        $("toast").textContent = error.message;
      } finally {
        setBusy(false);
      }
    });

    $("stopBtn").addEventListener("click", async () => {
      setBusy(true);
      try {
        renderStatus(await post("/api/stop", {}));
      } catch (error) {
        $("toast").textContent = error.message;
      } finally {
        setBusy(false);
      }
    });

    $("clearLogsBtn").addEventListener("click", async () => {
      setBusy(true);
      try {
        renderStatus(await post("/api/clear-logs", {}));
        $("toast").textContent = "Логи очищены";
      } catch (error) {
        $("toast").textContent = error.message;
      } finally {
        setBusy(false);
      }
    });

    loadSettings().finally(refreshStatus);
    setInterval(refreshStatus, 5000);
  </script>
</body>
</html>
"""


class AppHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        if self.path == "/" or self.path.startswith("/?"):
            body = HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/api/status":
            send_json(self, scheduler_state)
            return
        if self.path == "/api/config":
            send_json(self, load_app_config())
            return
        send_json(self, {"error": "not found"}, 404)

    def do_POST(self) -> None:
        try:
            payload = read_json(self)
            if self.path == "/api/analyze":
                payload["requestOrigin"] = f"web ip={request_ip(self)}"
                persist_active_config(payload)
                send_json(self, run_analysis(payload, notify=True))
                return
            if self.path == "/api/test-telegram":
                persist_active_config(payload)
                send_json(self, test_telegram(payload))
                return
            if self.path == "/api/save-settings":
                saved = persist_active_config(payload)
                add_request_log("web/manual", "Save settings", parse_tickers(payload.get("tickers", "")), "ok")
                send_json(self, {"ok": True, "settings": saved})
                return
            if self.path == "/api/clear-logs":
                clear_request_logs()
                send_json(self, scheduler_state)
                return
            if self.path in {"/api/external/analyze", "/api/webhook/analyze"}:
                origin = f"external ip={request_ip(self)}"
                token = request_auth_token(self, payload)
                send_json(self, run_external_analysis(payload, origin, token))
                return
            if self.path == "/api/start":
                payload["requestOrigin"] = f"web ip={request_ip(self)}"
                send_json(self, start_scheduler(payload))
                return
            if self.path == "/api/stop":
                send_json(self, stop_scheduler())
                return
            send_json(self, {"error": "not found"}, 404)
        except PermissionError as exc:
            send_json(self, {"error": str(exc)}, 403)
        except Exception as exc:
            send_json(self, {"error": str(exc)}, 400)


def main() -> None:
    global active_bot_config
    active_bot_config = load_app_config()
    init_request_db()
    refresh_request_logs()
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"Stock Signal Scanner: http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        stop_scheduler()
        server.server_close()


if __name__ == "__main__":
    main()
