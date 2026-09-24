# FRED — Federal Reserve Economic Data

The St. Louis Fed's data warehouse: 800,000+ economic time series spanning interest rates, inflation, employment, GDP, money supply, exchange rates, and metro-level indicators. The most authoritative, continuously updated source for US macro and monetary data — used by economists, policymakers, and journalists.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

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

## Reading a `fred_get_series` response

| Field | What it is |
|---|---|
| `count` | How many observations FRED holds for the requested window. |
| `returned` | How many are in `observations` — `limit` caps this at 20 by default. |
| `truncated` | True when `returned < count`; `note` says so in words. |
| `observation_order` | `newest_first` (default) or `oldest_first` (`sort_order: "asc"`). |
| `observation_start` / `observation_end` | The series' **real coverage**, from FRED's series metadata. |
| `requested_start` / `requested_end` | The window you asked for. Absent when you asked for none. |

The last two rows are the one to know about. FRED's observations endpoint echoes
`observation_start`/`observation_end` back as it received them, and substitutes
`1600-01-01` / `9999-12-31` when the caller sets neither — so this pack used to
report that US GDP ran from 1600 through 9999. Those names now carry the coverage
from the series metadata, matching what `fred_series_info` and `fred_search`
already mean by them.

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

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/fred/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/fred_get_series \
  -H 'Content-Type: application/json' \
  -d '{"series_id":"MORTGAGE30US"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/fred_get_series`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "fred": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-fred"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-fred
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Fred data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
