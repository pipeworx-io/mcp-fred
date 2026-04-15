interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * FRED MCP — Federal Reserve Economic Data (St. Louis Fed)
 *
 * BYO key: requires a FRED API key from https://fred.stlouisfed.org/docs/api/api_key.html
 * Passed via _apiKey parameter.
 *
 * Tools:
 * - fred_get_series: get observations for a data series (e.g., MORTGAGE30US, HOUST, CSUSHPISA)
 * - fred_search: search for series by keyword
 * - fred_series_info: get metadata about a series
 * - fred_category: browse FRED categories
 * - fred_releases: get latest data releases
 */


const BASE = 'https://api.stlouisfed.org/fred';

function extractKey(args: Record<string, unknown>): string {
  const key = args._apiKey as string;
  delete args._apiKey;
  if (!key) throw new Error('FRED API key required. Get one at https://fred.stlouisfed.org/docs/api/api_key.html and pass via _apiKey.');
  return key;
}

async function fredFetch(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FRED API error (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Tool definitions ────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'fred_get_series',
    description:
      'Get observations (data points) for a FRED series. Key housing series: MORTGAGE30US (30-year mortgage rate), HOUST (housing starts), CSUSHPISA (Case-Shiller home price index), MSPUS (median home sale price), PERMIT (building permits), RRVRUSQ156N (rental vacancy rate).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        series_id: { type: 'string', description: 'FRED series ID (e.g., "MORTGAGE30US", "HOUST", "CSUSHPISA")' },
        observation_start: { type: 'string', description: 'Start date in YYYY-MM-DD format (optional)' },
        observation_end: { type: 'string', description: 'End date in YYYY-MM-DD format (optional)' },
        frequency: { type: 'string', description: 'Frequency aggregation: d, w, bw, m, q, sa, a (optional)' },
        units: { type: 'string', description: 'Data transformation: lin (levels), chg (change), ch1 (change from year ago), pch (% change), pc1 (% change from year ago), pca (compounded annual rate of change), cch (continuously compounded rate of change), cca (continuously compounded annual rate of change), log (natural log). Default: lin' },
        _apiKey: { type: 'string', description: 'FRED API key' },
      },
      required: ['series_id', '_apiKey'],
    },
  },
  {
    name: 'fred_search',
    description:
      'Search for FRED series by keyword. Useful for discovering series IDs for housing, employment, inflation, and other economic data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search_text: { type: 'string', description: 'Keywords to search for (e.g., "mortgage rate", "housing starts")' },
        limit: { type: 'number', description: 'Max results to return (1-1000, default 20)' },
        order_by: { type: 'string', description: 'Order results by: search_rank, series_id, title, units, frequency, seasonal_adjustment, realtime_start, realtime_end, last_updated, observation_start, observation_end, popularity, group_popularity. Default: search_rank' },
        sort_order: { type: 'string', description: 'Sort direction: asc or desc. Default: asc for search_rank' },
        _apiKey: { type: 'string', description: 'FRED API key' },
      },
      required: ['search_text', '_apiKey'],
    },
  },
  {
    name: 'fred_series_info',
    description:
      'Get metadata about a FRED series: title, units, frequency, seasonal adjustment, notes, and date range.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        series_id: { type: 'string', description: 'FRED series ID (e.g., "MORTGAGE30US")' },
        _apiKey: { type: 'string', description: 'FRED API key' },
      },
      required: ['series_id', '_apiKey'],
    },
  },
  {
    name: 'fred_category',
    description:
      'Browse FRED categories. Use category_id=0 for the root. Useful for exploring available data by topic (housing = 97, money/banking/finance = 32991, population/employment/labor = 10).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category_id: { type: 'number', description: 'Category ID to browse children of (default: 0 for root)' },
        _apiKey: { type: 'string', description: 'FRED API key' },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'fred_releases',
    description:
      'Get the latest FRED data releases. Shows upcoming and recent releases of economic data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max results (1-1000, default 20)' },
        offset: { type: 'number', description: 'Result offset for pagination (default 0)' },
        _apiKey: { type: 'string', description: 'FRED API key' },
      },
      required: ['_apiKey'],
    },
  },
];

// ── callTool dispatcher ─────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const key = extractKey(args);

  switch (name) {
    case 'fred_get_series':
      return getSeries(key, args);
    case 'fred_search':
      return searchSeries(key, args);
    case 'fred_series_info':
      return seriesInfo(key, args.series_id as string);
    case 'fred_category':
      return getCategory(key, args.category_id as number | undefined);
    case 'fred_releases':
      return getReleases(key, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Tool implementations ────────────────────────────────────────────────

async function getSeries(key: string, args: Record<string, unknown>) {
  const params = new URLSearchParams({
    series_id: args.series_id as string,
    api_key: key,
    file_type: 'json',
  });
  if (args.observation_start) params.set('observation_start', args.observation_start as string);
  if (args.observation_end) params.set('observation_end', args.observation_end as string);
  if (args.frequency) params.set('frequency', args.frequency as string);
  if (args.units) params.set('units', args.units as string);

  const data = (await fredFetch(`${BASE}/series/observations?${params}`)) as {
    realtime_start: string;
    realtime_end: string;
    observation_start: string;
    observation_end: string;
    count: number;
    observations: { date: string; value: string }[];
  };

  return {
    series_id: args.series_id,
    count: data.count,
    observation_start: data.observation_start,
    observation_end: data.observation_end,
    observations: data.observations.map((o) => ({
      date: o.date,
      value: o.value === '.' ? null : o.value,
    })),
  };
}

async function searchSeries(key: string, args: Record<string, unknown>) {
  const params = new URLSearchParams({
    search_text: args.search_text as string,
    api_key: key,
    file_type: 'json',
  });
  const limit = Math.min(1000, Math.max(1, (args.limit as number) ?? 20));
  params.set('limit', String(limit));
  if (args.order_by) params.set('order_by', args.order_by as string);
  if (args.sort_order) params.set('sort_order', args.sort_order as string);

  const data = (await fredFetch(`${BASE}/series/search?${params}`)) as {
    count: number;
    seriess: {
      id: string;
      title: string;
      units: string;
      frequency: string;
      seasonal_adjustment: string;
      observation_start: string;
      observation_end: string;
      popularity: number;
      notes?: string;
    }[];
  };

  return {
    total_matches: data.count,
    series: data.seriess.map((s) => ({
      series_id: s.id,
      title: s.title,
      units: s.units,
      frequency: s.frequency,
      seasonal_adjustment: s.seasonal_adjustment,
      observation_start: s.observation_start,
      observation_end: s.observation_end,
      popularity: s.popularity,
      notes: s.notes ?? null,
    })),
  };
}

async function seriesInfo(key: string, seriesId: string) {
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: key,
    file_type: 'json',
  });

  const data = (await fredFetch(`${BASE}/series?${params}`)) as {
    seriess: {
      id: string;
      title: string;
      units: string;
      units_short: string;
      frequency: string;
      frequency_short: string;
      seasonal_adjustment: string;
      seasonal_adjustment_short: string;
      observation_start: string;
      observation_end: string;
      last_updated: string;
      popularity: number;
      notes?: string;
    }[];
  };

  const s = data.seriess[0];
  if (!s) throw new Error(`Series not found: ${seriesId}`);

  return {
    series_id: s.id,
    title: s.title,
    units: s.units,
    units_short: s.units_short,
    frequency: s.frequency,
    frequency_short: s.frequency_short,
    seasonal_adjustment: s.seasonal_adjustment,
    seasonal_adjustment_short: s.seasonal_adjustment_short,
    observation_start: s.observation_start,
    observation_end: s.observation_end,
    last_updated: s.last_updated,
    popularity: s.popularity,
    notes: s.notes ?? null,
  };
}

async function getCategory(key: string, categoryId?: number) {
  const id = categoryId ?? 0;
  const params = new URLSearchParams({
    category_id: String(id),
    api_key: key,
    file_type: 'json',
  });

  const data = (await fredFetch(`${BASE}/category/children?${params}`)) as {
    categories: { id: number; name: string; parent_id: number }[];
  };

  return {
    parent_category_id: id,
    categories: data.categories.map((c) => ({
      id: c.id,
      name: c.name,
      parent_id: c.parent_id,
    })),
  };
}

async function getReleases(key: string, args: Record<string, unknown>) {
  const params = new URLSearchParams({
    api_key: key,
    file_type: 'json',
  });
  const limit = Math.min(1000, Math.max(1, (args.limit as number) ?? 20));
  params.set('limit', String(limit));
  if (args.offset) params.set('offset', String(args.offset as number));

  const data = (await fredFetch(`${BASE}/releases?${params}`)) as {
    count: number;
    releases: {
      id: number;
      name: string;
      press_release: boolean;
      link?: string;
      notes?: string;
    }[];
  };

  return {
    total_releases: data.count,
    releases: data.releases.map((r) => ({
      id: r.id,
      name: r.name,
      press_release: r.press_release,
      link: r.link ?? null,
      notes: r.notes ?? null,
    })),
  };
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
