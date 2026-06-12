# Stock Signal Scanner Service Boundaries

This service receives one ticker or a list of tickers and, by default, runs the standard technical/signal analysis for each valid ticker.

## Default Mode

No command is required for ordinary ticker analysis.

```text
AAPL
```

Runs standard technical/signal analysis for `AAPL`.

```text
AAPL, MSFT, NVDA
```

Runs standard technical/signal analysis for each ticker: `AAPL`, `MSFT`, `NVDA`.

The same rule applies to HTTP payloads:

```json
{ "ticker": "AAPL" }
```

```json
{ "tickers": "AAPL, MSFT, NVDA" }
```

## Special Modes

A special command is needed only when the user wants a different analysis mode.

```text
FundRep AAPL
```

Runs fundamental analysis for `AAPL` instead of the standard signal analysis.

```text
FundRep AAPL, MSFT
```

Runs fundamental analysis separately for `AAPL` and `MSFT`.

```text
PromtRep AAPL
```

Runs the PromtRep prompt/report flow for `AAPL`, while this command remains enabled in the service.

## Developer Rule

Do not require a separate command for standard ticker analysis.

Raw valid tickers always mean ordinary technical/signal analysis. Commands such as `FundRep` and `PromtRep` are mode selectors and replace the ordinary analysis for that request.

## Response Contract

Every request receives a `requestId`. API clients should store it and use it when reporting bugs or reconciling Telegram delivery.

Canonical results are returned in `items[]`:

```text
ticker
status
analysisType
price
indicators
signals
fundamentalSummary
dataSources
errors
requestId
```

Allowed statuses:

```text
signal_found
no_signal
not_enough_data
invalid_ticker
data_provider_error
partial_result
```

Standard technical analysis is the fast path. Heavy flows such as `FundRep`, PDF generation, and deep fundamental enrichment run through an async-friendly path and should not block the Telegram webhook response.

Market candles and recent analysis results are cached by `ticker + timeframe + analysisType` with an initial 15 minute TTL. External provider calls use short retry for temporary failures.
