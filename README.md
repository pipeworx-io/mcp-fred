# FRED — Federal Reserve Economic Data

The St. Louis Fed's data warehouse: 800,000+ economic time series spanning interest rates, inflation, employment, GDP, money supply, exchange rates, and metro-level indicators. The most authoritative, continuously updated source for US macro and monetary data — used by economists, policymakers, and journalists.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Why this matters for AI agents

Most "what is the current X" macro questions resolve to a FRED series. An agent that knows the series ID can answer with the actual current value, not a training-data snapshot. Common ones:

- 30-year mortgage rate → `MORTGAGE30US`
- Federal funds rate → `DFF`
- CPI (all items) → `CPIAUCSL`
- Unemployment rate → `UNRATE`
- 10-year treasury yield → `DGS10`
- Housing starts → `HOUST`
- Case-Shiller home price index → `CSUSHPISA`

If your agent is answering a question about US macroeconomic state, the right pattern is `fred_search` (find the right series) → `fred_series_info` (confirm units and frequency) → `fred_get_series` (get the values).

## Auth

FRED requires an API key. It's free at https://fred.stlouisfed.org/docs/api/api_key.html — takes 30 seconds, no payment, no rate-limit terror.

Pass via `_apiKey` per call:

```js
fred_get_series({
  series_id: "MORTGAGE30US",
  _apiKey: "your-fred-api-key"
})
```

Or subscribe to the [Housing Vertical](/docs/concepts/verticals) which manages the key for you.

## Update cadence

| Series class | Update frequency |
|---|---|
| Daily series (rates, exchange rates) | Daily, ~1 business day lag |
| Weekly (mortgage rates) | Weekly, Thursday |
| Monthly (CPI, unemployment, retail sales) | Monthly, ~2-3 weeks after month end |
| Quarterly (GDP) | Quarterly, ~1 month after quarter end |

Pipeworx caches FRED responses with TTLs matching these cadences — see [caching and freshness](/docs/concepts/caching-and-freshness).

## Citable URI

Embed in your output for stable citations:

```
pipeworx://fred/series/{series_id}
pipeworx://fred/series/{series_id}/observations
```

Other agents (and `resources/read`) can resolve these to the current value of the series.

## Common pitfalls

- **Vintages**: FRED preserves historical "vintages" (data as it was reported at time T). Default tool calls get the latest revised series. Pass `realtime_start` and `realtime_end` for as-of queries.
- **Frequency aggregation**: `frequency` parameter coerces to a different cadence (e.g., daily → monthly average). Default is the series' native frequency.
- **Units transformation**: `units` parameter computes derived series at request time (`pch` for percent change, `pca` for compound annual rate, etc.). Don't compute these client-side; let FRED do it.
- **Series renamed**: occasionally the Fed deprecates a series and creates a successor. Old IDs return errors. `fred_search` is the recovery path.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "fred": {
      "url": "https://gateway.pipeworx.io/fred/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Fred data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
