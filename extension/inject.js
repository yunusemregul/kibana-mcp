// inject.js — Runs in MAIN world (page context)
// Has access to the page's cookies/session, so fetch() calls are authenticated.
// Guard against duplicate injection
if (window.__kibanaLogBridgeInjectLoaded) {
  console.log("%c[Kibana Log Bridge] %cPage bridge already loaded, skipping", "color:#6366f1;font-weight:bold", "color:#64748b");
} else {
  window.__kibanaLogBridgeInjectLoaded = true;
  console.log("%c[Kibana Log Bridge] %cPage bridge loaded (MAIN world)", "color:#6366f1;font-weight:bold", "color:#94a3b8");

  // Track in-flight requests to prevent duplicate fetches
  const pendingRequests = new Set();

  // Kibana serves its internal API under an optional base path; everything
  // before /app/ in the current URL is that base path (empty when none).
  const basePath = location.pathname.includes('/app/')
    ? location.pathname.split('/app/')[0]
    : '';

  // OpenSearch Dashboards and Kibana expose different internal search routes
  // with different XSRF headers. Probe in order on the first search and cache
  // whichever one answers.
  const SEARCH_ENDPOINTS = [
    { path: '/internal/search/opensearch-with-long-numerals', headers: { 'osd-xsrf': 'osd-fetch' } },
    { path: '/internal/search/ese', headers: { 'kbn-xsrf': 'true', 'x-elastic-internal-origin': 'Kibana' } },
    { path: '/internal/search/es', headers: { 'kbn-xsrf': 'true', 'x-elastic-internal-origin': 'Kibana' } },
  ];
  let detectedEndpoint = null;

  // Field-caps routes differ per flavor/version the same way search does.
  const FIELD_CAPS_ENDPOINTS = [
    { path: '/api/index_patterns/_fields_for_wildcard', headers: { 'osd-xsrf': 'osd-fetch' } },
    { path: '/internal/data_views/_fields_for_wildcard', headers: { 'kbn-xsrf': 'true', 'x-elastic-internal-origin': 'Kibana' } },
    { path: '/api/index_patterns/_fields_for_wildcard', headers: { 'kbn-xsrf': 'true' } },
  ];
  let detectedFieldCapsEndpoint = null;
  const FIELD_CAPS_TTL_MS = 10 * 60000;
  const fieldCapsCache = new Map();

  async function getFieldCaps(indexPattern) {
    const cached = fieldCapsCache.get(indexPattern);
    if (cached && Date.now() - cached.at < FIELD_CAPS_TTL_MS) return cached.fields;
    const fields = await fetchFieldCaps(indexPattern);
    if (fields) fieldCapsCache.set(indexPattern, { at: Date.now(), fields });
    return fields;
  }

  // Fetch the full typed schema for the index pattern. Best-effort: returns
  // null when no route answers (the server then falls back to doc sampling).
  async function fetchFieldCaps(indexPattern) {
    const candidates = detectedFieldCapsEndpoint ? [detectedFieldCapsEndpoint] : FIELD_CAPS_ENDPOINTS;
    for (const endpoint of candidates) {
      try {
        const response = await fetch(`${basePath}${endpoint.path}?pattern=${encodeURIComponent(indexPattern)}`, {
          headers: endpoint.headers,
        });
        if (!response.ok) continue;
        const data = await response.json();
        if (!Array.isArray(data.fields)) continue;
        if (!detectedFieldCapsEndpoint) {
          detectedFieldCapsEndpoint = endpoint;
          console.log(`%c[Kibana Log Bridge] %cUsing field caps endpoint ${endpoint.path}`, "color:#6366f1;font-weight:bold", "color:#94a3b8");
        }
        return data.fields;
      } catch (e) {
        // try next route
      }
    }
    console.log("%c[Kibana Log Bridge] %c⚠️  Field caps unavailable, falling back to doc sampling only", "color:#6366f1;font-weight:bold", "color:#f59e0b");
    return null;
  }

  window.addEventListener("message", async (event) => {
    if (event.data?.source !== "kibana-log-bridge-content") return;
    if (event.data.type !== "EXECUTE_SEARCH") return;

    const { requestId, query, timeRangeMinutes, timeFrom, timeTo, size, searchType, timestampMatch, excludeFilters, includeFilters, aggregateFields, topN, mode, queryDsl, indexPattern, queryFields, stratifyField } = event.data;

    // Deduplicate: skip if we already have this requestId in flight
    if (pendingRequests.has(requestId)) return;
    pendingRequests.add(requestId);

    try {
      const timeDesc = timeFrom && timeTo ? `${timeFrom} → ${timeTo}` : `last ${timeRangeMinutes} min`;
      const modeDesc = mode === 'summarize' ? '📊 summarize' : '🔍 search';
      console.log(`%c[Kibana Log Bridge] %c${modeDesc}: "${query}" (${timeDesc})`, "color:#6366f1;font-weight:bold", "color:#f59e0b");
      const result = await performSearch(query, { timeRangeMinutes, timeFrom, timeTo, size, searchType, timestampMatch, excludeFilters, includeFilters, aggregateFields, topN, mode, queryDsl, indexPattern, queryFields, stratifyField });

      if ((mode === 'fields' || mode === 'summarize') && result && typeof result === 'object') {
        const caps = await getFieldCaps(indexPattern || 'logs-*');
        if (caps) result.fieldCaps = caps;
      }

      const raw = result.rawResponse || result;
      const total = raw.hits?.total;
      const count = typeof total === 'object' ? total.value : total;
      console.log(`%c[Kibana Log Bridge] %c✅ Got ${count ?? '?'} hits`, "color:#6366f1;font-weight:bold", "color:#22c55e");

      window.postMessage({
        source: "kibana-log-bridge-inject",
        type: "SEARCH_RESULT",
        requestId,
        data: result
      }, "*");
    } catch (err) {
      console.error(`%c[Kibana Log Bridge] %c❌ Search failed: ${err.message}`, "color:#6366f1;font-weight:bold", "color:#ef4444");
      window.postMessage({
        source: "kibana-log-bridge-inject",
        type: "SEARCH_RESULT",
        requestId,
        error: err.message
      }, "*");
    } finally {
      pendingRequests.delete(requestId);
    }
  });

  async function fetchSearch(payload) {
    const candidates = detectedEndpoint ? [detectedEndpoint] : SEARCH_ENDPOINTS;
    let lastError = null;
    for (const endpoint of candidates) {
      const response = await fetch(basePath + endpoint.path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...endpoint.headers,
          // Intentionally omit osd-version/kbn-version: the server only
          // validates them when present and 400s on a mismatch (e.g. after a
          // dashboard upgrade). The XSRF header alone satisfies the guard.
        },
        body: JSON.stringify(payload)
      });
      if (response.status === 404) {
        lastError = new Error(`HTTP Error: 404 at ${endpoint.path}`);
        continue; // wrong flavor — try the next route
      }
      if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status} ${response.statusText} at ${endpoint.path}`);
      }
      if (!detectedEndpoint) {
        detectedEndpoint = endpoint;
        console.log(`%c[Kibana Log Bridge] %cUsing search endpoint ${endpoint.path}`, "color:#6366f1;font-weight:bold", "color:#94a3b8");
      }
      return await response.json();
    }
    throw lastError || new Error('No search endpoint responded');
  }

  async function performSearch(queryText, opts = {}) {
    const {
      timeRangeMinutes = 15,
      timeFrom = null,
      timeTo = null,
      size = 500,
      searchType = 'phrase',
      timestampMatch = null,
      excludeFilters = [],
      includeFilters = [],
      aggregateFields = [],
      topN = 10,
      mode = 'search',
      queryDsl = null,
      indexPattern = 'logs-*',
      queryFields = null,
      stratifyField = null,
    } = opts;

    // Time range: absolute if provided, otherwise relative
    let start, end;
    if (timeFrom && timeTo) {
      start = new Date(timeFrom);
      end = new Date(timeTo);
    } else {
      end = new Date();
      start = new Date(end.getTime() - timeRangeMinutes * 60000);
    }

    // Calculate a reasonable histogram interval based on time span
    const spanMs = end.getTime() - start.getTime();
    let histogramInterval;
    if (spanMs <= 30 * 60000) histogramInterval = '1m';       // ≤30min → 1m buckets
    else if (spanMs <= 3 * 3600000) histogramInterval = '5m';  // ≤3h → 5m buckets
    else if (spanMs <= 24 * 3600000) histogramInterval = '30m'; // ≤24h → 30m buckets
    else histogramInterval = '3h';                              // >24h → 3h buckets

    // Empty/missing query is valid — caller is searching purely by time and
    // filters (used by the context tool, or "show all errors in this window").
    const trimmedQuery = (queryText || '').trim();
    let queryFilters;
    if (!trimmedQuery || trimmedQuery === '*') {
      queryFilters = [];
    } else {
      const terms = trimmedQuery.split(/\s+AND\s+/i).map(t => t.trim()).filter(Boolean);
      const fieldList = Array.isArray(queryFields) ? queryFields.filter(Boolean) : [];
      queryFilters = terms.map(term => ({
        multi_match: {
          type: searchType,
          query: term,
          lenient: true,
          ...(fieldList.length ? { fields: fieldList } : {})
        }
      }));
    }

    const filters = [
      ...queryFilters,
      {
        range: {
          "@timestamp": {
            gte: start.toISOString(),
            lte: end.toISOString(),
            format: "strict_date_optional_time"
          }
        }
      }
    ];

    // Caller-supplied raw query DSL clause, AND-ed in with everything else
    if (queryDsl && typeof queryDsl === 'object' && !Array.isArray(queryDsl)) {
      filters.push(queryDsl);
    }

    // Optional: pin to a specific timestamp
    if (timestampMatch) {
      filters.push({
        match_phrase: {
          "@timestamp": timestampMatch
        }
      });
    }

    const isValidFilter = (f) => f && f.field && f.value !== undefined && f.value !== null;
    const filterClause = (f) => f.match === 'wildcard'
      ? { wildcard: { [f.field]: { value: f.value, case_insensitive: true } } }
      : { match_phrase: { [f.field]: f.value } };

    for (const f of includeFilters || []) {
      if (isValidFilter(f)) filters.push(filterClause(f));
    }

    const mustNot = [];
    for (const f of excludeFilters || []) {
      if (isValidFilter(f)) mustNot.push(filterClause(f));
    }

    const isSummarize = mode === 'summarize';
    const isFields = mode === 'fields';
    const stratify = isFields && typeof stratifyField === 'string' && stratifyField ? stratifyField : null;
    const FIELDS_SAMPLE = stratify ? 10 : 30;
    let effectiveSize;
    if (isFields) effectiveSize = FIELDS_SAMPLE;
    else if (isSummarize) effectiveSize = 0;
    else effectiveSize = size;

    const aggs = {};
    if (stratify) {
      aggs.strata = {
        terms: { field: stratify.endsWith('.keyword') ? stratify : `${stratify}.keyword`, size: 10 },
        aggs: { sample: { top_hits: { size: 5, sort: [{ "@timestamp": "desc" }] } } }
      };
    }
    if (!isFields) {
      aggs["2"] = {
        date_histogram: {
          field: "@timestamp",
          fixed_interval: histogramInterval,
          time_zone: 'UTC',
          min_doc_count: 1
        }
      };
      for (const field of aggregateFields || []) {
        if (!field) continue;
        // Use .keyword subfield for terms aggs unless caller already specified one.
        const aggField = field.endsWith('.keyword') ? field : `${field}.keyword`;
        const aggKey = `terms_${field.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        aggs[aggKey] = { terms: { field: aggField, size: topN || 10 }, meta: { source_field: field } };
      }
    }

    const body = {
      sort: [
        { "@timestamp": { order: "desc", unmapped_type: "boolean" } },
        { "time": { order: "desc", unmapped_type: "date" } }
      ],
      size: effectiveSize,
      version: true,
      aggs,
      stored_fields: ["*"],
      script_fields: {},
      docvalue_fields: [
        { field: "@timestamp", format: "date_time" }
      ],
      _source: { excludes: [] },
      query: {
        bool: {
          must: [],
          filter: filters,
          should: [],
          must_not: mustNot
        }
      }
    };

    // Highlights are useless when size=0 and waste bytes when we have display_fields.
    if (!isSummarize) {
      body.highlight = {
        pre_tags: ["@opensearch-dashboards-highlighted-field@"],
        post_tags: ["@/opensearch-dashboards-highlighted-field@"],
        fields: { "*": {} },
        fragment_size: 2147483647
      };
    }

    const payload = {
      params: {
        index: indexPattern,
        body,
        preference: Date.now()
      }
    };

    const result = await fetchSearch(payload);
    if (stratify && result && typeof result === 'object') {
      const raw = result.rawResponse || result;
      const buckets = raw.aggregations?.strata?.buckets || [];
      if (!raw.hits) raw.hits = { hits: [] };
      if (!Array.isArray(raw.hits.hits)) raw.hits.hits = [];
      const seen = new Set(raw.hits.hits.map(h => h._id));
      for (const b of buckets) {
        for (const h of b.sample?.hits?.hits || []) {
          if (seen.has(h._id)) continue;
          seen.add(h._id);
          raw.hits.hits.push(h);
        }
      }
      result.strata = buckets.map(b => ({ key: b.key, doc_count: b.doc_count }));
    }
    return result;
  }
}
