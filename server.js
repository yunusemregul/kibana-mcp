#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import http from 'http';
import { randomUUID } from 'crypto';
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from 'ws';
import { stringify as yamlStringify } from 'yaml';
import { readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';

if (process.argv[2] === 'install-extension') {
  await (await import('./install-extension.js')).default(process.argv.slice(3));
  process.exit(0);
}

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const BUILD = Math.floor(statSync(fileURLToPath(import.meta.url)).mtimeMs);
// Serve MCP over stdio when spawned by a client (no TTY) or asked explicitly.
const STDIO = process.argv.includes('--stdio') || !process.stdin.isTTY;

const WS_PORT = parseInt(process.env.WS_PORT || '47821', 10);
const MCP_PORT = parseInt(process.env.MCP_PORT || '47822', 10);
const HOST = process.env.HOST || '127.0.0.1';

// Fallback chain used to render each hit's message when the caller doesn't
// pass display_fields. Override with DISPLAY_FIELDS=comma,separated,paths.
const DEFAULT_DISPLAY_FIELDS = (process.env.DISPLAY_FIELDS || 'message,logs.message,msg,log,logs.request,logs.requestFirstLine')
  .split(',').map(s => s.trim()).filter(Boolean);

// Default dimensions bucketed by summarize_logs. Override with SUMMARY_FIELDS.
const DEFAULT_SUMMARY_FIELDS = (process.env.SUMMARY_FIELDS || 'logs.level,logs.loggerName,logs.thrown.name,kubernetes.pod_name')
  .split(',').map(s => s.trim()).filter(Boolean);

const DEFAULT_QUERY_FIELDS = (process.env.QUERY_FIELDS ?? 'message,logs.message,msg,log,logs.loggerName,logs.thread,logs.thrown.name,logs.thrown.message,logs.request,logs.requestFirstLine')
  .split(',').map(s => s.trim()).filter(Boolean);

const LEVEL_FIELD = process.env.LEVEL_FIELD || 'logs.level';
const TRACE_ID_FIELD = process.env.TRACE_ID_FIELD || 'logs.contextMap.traceId';
const FIELDS_STRATIFY_FIELD = process.env.FIELDS_STRATIFY_FIELD || 'kubernetes.container_name';

const SOURCE_TAG_FIELDS = (process.env.SOURCE_TAG_FIELDS || 'kubernetes.labels.ccv2_cx_sap_com_platform-aspect,kubernetes.container_name')
  .split(',').map(s => s.trim()).filter(Boolean);

// 1. Setup WebSocket Server to talk to the Browser.
// Browser pages always send an http(s) Origin header — reject those so a
// malicious website can't connect to the local bridge. Extension workers
// (chrome-extension://) and non-browser clients (no Origin) are allowed.
let wss = null;
let activeBrowserConnection = null;

// Environment names the extension reports on connect (from its popup settings).
// Surfaced in tool schemas so the AI knows what it can pass as `environment`.
let knownEnvironments = [];
let extensionVersion = null;

function startWebSocketServer() {
  return new Promise((resolve, reject) => {
    wss = new WebSocketServer({
      host: HOST,
      port: WS_PORT,
      verifyClient: ({ origin }) => {
        if (!origin) return true;
        if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) return true;
        console.error(`[MCP Server] 🚫 Rejected WebSocket connection from origin: ${origin}`);
        return false;
      },
    });
    wss.once('listening', () => {
      wss.on('error', (err) => console.error(`[MCP Server] ❌ WebSocket server error:`, err.message));
      resolve();
    });
    wss.once('error', reject);
    wss.on('connection', handleBrowserConnection);
  });
}

function handleBrowserConnection(ws) {
  console.error("[MCP Server] ✅ Browser extension connected via WebSocket");
  activeBrowserConnection = ws;
  extensionVersion = null;

  ws.on('close', () => {
    console.error("[MCP Server] ❌ Browser extension disconnected");
    activeBrowserConnection = null;
  });

  ws.on('message', (message) => {
    const msg = JSON.parse(message);
    if (msg.type === 'PING') {
      ws.send(JSON.stringify({ type: 'PONG' }));
      return;
    }
    if (msg.type === 'HELLO') {
      knownEnvironments = Array.isArray(msg.environments)
        ? msg.environments.filter(e => typeof e === 'string' && e)
        : [];
      console.error(`[MCP Server] 🌍 Environments: ${knownEnvironments.join(', ') || '(none configured)'}`);
      extensionVersion = typeof msg.version === 'string' ? msg.version : null;
      if (extensionVersion !== VERSION) console.error(`[MCP Server] ⚠️  Extension version ${extensionVersion || 'unknown'} does not match server ${VERSION}`);
      return;
    }
    if (msg.type === 'SEARCH_RESULT') {
      const status = msg.error ? '⚠️  Error' : `✅ ${JSON.stringify(msg.data?.hits?.total || 0)} hits`;
      console.error(`[MCP Server] 📨 Search result received (${msg.requestId}): ${status}`);
    }
  });
}

function withVersionNote(handler) {
  return async (request) => {
    const result = await handler(request);
    if (activeBrowserConnection && extensionVersion !== VERSION) {
      result.content?.push({ type: "text", text: `⚠️ The Kibana Log Bridge extension is outdated (extension ${extensionVersion || 'unknown version'}, server ${VERSION}). Tell the user to run \`npx -y kibana-bridge-mcp@latest install-extension\` and click reload on the extension in their browser's extensions page (chrome://extensions, brave://extensions, edge://extensions, …).` });
    }
    return result;
  };
}

// Wait for browser extension to connect (up to waitMs)
function waitForBrowser(waitMs = 10000) {
  if (activeBrowserConnection) return Promise.resolve();
  console.error(`[MCP Server] ⏳ No browser connected, waiting up to ${waitMs / 1000}s...`);
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (activeBrowserConnection) {
        clearInterval(check);
        clearTimeout(timeout);
        console.error("[MCP Server] ✅ Browser reconnected!");
        resolve();
      }
    }, 500);
    const timeout = setTimeout(() => {
      clearInterval(check);
      reject(new Error("No active browser extension connected. Please open Chrome with the Kibana Log Bridge extension and make sure it shows 'ON'."));
    }, waitMs);
  });
}

// Helper to send request to browser and await response
async function executeBrowserSearch(searchParams) {
  await waitForBrowser();

  return new Promise((resolve, reject) => {
    const requestId = Date.now().toString();
    let settled = false;

    const listener = (data) => {
      const msg = JSON.parse(data);
      if (msg.type === 'SEARCH_RESULT' && msg.requestId === requestId) {
        settled = true;
        activeBrowserConnection?.off('message', listener);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.data);
      }
    };

    activeBrowserConnection.on('message', listener);

    activeBrowserConnection.send(JSON.stringify({
      type: 'EXECUTE_SEARCH',
      requestId,
      ...searchParams
    }));

    // Timeout after 30s
    setTimeout(() => {
      if (!settled) {
        activeBrowserConnection?.off('message', listener);
        reject(new Error("Browser request timed out after 30s"));
      }
    }, 30000);
  });
}

// Walk a dot-separated path into a nested object/array. Returns undefined if missing.
function getNestedField(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((cur, key) => {
    if (cur === undefined || cur === null) return undefined;
    return cur[key];
  }, obj);
}

function formatTimestamp(iso) {
  if (!iso || typeof iso !== 'string') return iso || '';
  let s = iso.trim();
  if (/[+-]\d{2}:?\d{2}$/.test(s) && !/[+-]00:?00$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) s = d.toISOString();
  }
  const [datePart, timePart] = s.split('T');
  if (!timePart) return iso;
  return `${datePart} ${timePart.replace(/(Z|[+-]00:?00)$/, '').trim()}Z`;
}

function toIsoOrThrow(value, name) {
  const d = new Date(value);
  if (value === '' || value === null || isNaN(d.getTime())) {
    throw new Error(`invalid \`${name}\`: ${JSON.stringify(value)} — use an ISO 8601 timestamp, e.g. '2026-09-23T10:28:00Z'`);
  }
  return d.toISOString();
}

function resolveTimeWindow({ time_from, time_to, minutes_lookback } = {}, defaultLookback = 15) {
  const lookback = (typeof minutes_lookback === 'number' && minutes_lookback > 0) ? minutes_lookback : defaultLookback;
  const hasFrom = time_from !== undefined && time_from !== null && time_from !== '';
  const hasTo = time_to !== undefined && time_to !== null && time_to !== '';
  if (hasFrom && hasTo) {
    return { timeFrom: toIsoOrThrow(time_from, 'time_from'), timeTo: toIsoOrThrow(time_to, 'time_to'), lookbackMin: null };
  }
  if (hasFrom) {
    return { timeFrom: toIsoOrThrow(time_from, 'time_from'), timeTo: new Date().toISOString(), lookbackMin: null };
  }
  const timeTo = hasTo ? toIsoOrThrow(time_to, 'time_to') : new Date().toISOString();
  const timeFrom = new Date(new Date(timeTo).getTime() - lookback * 60000).toISOString();
  return { timeFrom, timeTo, lookbackMin: lookback };
}

function describeTime(window) {
  if (!window) return '';
  return `${window.timeFrom} → ${window.timeTo}${window.lookbackMin ? ` (last ${window.lookbackMin} min)` : ''}`;
}

function normalizeLevels(level) {
  const list = Array.isArray(level) ? level : (level === undefined || level === null ? [] : [level]);
  return list.flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean);
}

// Build the param object passed to the browser, keyed in camelCase as the
// extension expects. Shared by both search and summarize tools.
function buildBrowserParams(args, mode, tool = null, window = null) {
  const {
    query,
    size,
    search_type,
    timestamp_match,
    exclude_filters,
    include_filters,
    aggregate_fields,
    top_n,
    environment,
    query_dsl,
    level,
  } = args;
  const win = window || resolveTimeWindow(args);
  let queryDsl = (query_dsl && typeof query_dsl === 'object' && !Array.isArray(query_dsl)) ? query_dsl : null;
  const includeFilters = Array.isArray(include_filters) ? [...include_filters] : [];
  const levels = normalizeLevels(level);
  if (levels.length === 1) {
    includeFilters.push({ field: LEVEL_FIELD, value: levels[0] });
  } else if (levels.length > 1) {
    const levelClause = {
      bool: {
        should: levels.map(v => ({ match_phrase: { [LEVEL_FIELD]: v } })),
        minimum_should_match: 1,
      },
    };
    queryDsl = queryDsl ? { bool: { filter: [queryDsl, levelClause] } } : levelClause;
  }
  return {
    query,
    environment: environment || null,
    queryDsl,
    queryFields: DEFAULT_QUERY_FIELDS,
    timeRangeMinutes: win.lookbackMin || Math.max(1, Math.round((new Date(win.timeTo) - new Date(win.timeFrom)) / 60000)),
    timeFrom: win.timeFrom,
    timeTo: win.timeTo,
    size: size || 500,
    searchType: search_type || 'phrase',
    timestampMatch: timestamp_match || null,
    excludeFilters: Array.isArray(exclude_filters) ? exclude_filters : [],
    includeFilters,
    aggregateFields: Array.isArray(aggregate_fields) ? aggregate_fields : [],
    topN: top_n || 10,
    stratifyField: mode === 'fields' ? FIELDS_STRATIFY_FIELD : null,
    mode,
    tool,
  };
}

function describeFilterBadges(includeFilters, excludeFilters, level) {
  const parts = [];
  const badge = (sign, f) => `${sign}${f.field}${f.match === 'wildcard' ? '~' : '='}${f.value}`;
  const levels = normalizeLevels(level);
  if (levels.length) parts.push(`level=${levels.join(',')}`);
  for (const f of includeFilters || []) {
    if (f?.field) parts.push(badge('+', f));
  }
  for (const f of excludeFilters || []) {
    if (f?.field) parts.push(badge('-', f));
  }
  return parts.length ? ` [${parts.join(', ')}]` : '';
}

// Recursively collect every leaf field path from a doc's _source. Arrays
// don't contribute their index to the path — `arr.0.foo` collapses to `arr.foo`.
function collectLeafPaths(obj, prefix, out) {
  if (obj === null || obj === undefined) {
    if (prefix) out.add(prefix);
    return;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      if (prefix) out.add(prefix);
      return;
    }
    for (const item of obj) collectLeafPaths(item, prefix, out);
    return;
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      if (prefix) out.add(prefix);
      return;
    }
    for (const key of keys) {
      const next = prefix ? `${prefix}.${key}` : key;
      collectLeafPaths(obj[key], next, out);
    }
    return;
  }
  if (prefix) out.add(prefix);
}

// Paths that hold identifiers/metadata, never log text — skip during
// display-field auto-detection.
const AUTO_FIELD_SKIP = /(^|\.)(@?timestamp|time|date|written_at|level|version|host(name)?|port|pid|uid|id|uuid|hash|ip|image|tags?)$|_id$|Id$/;

// When the display-field chain renders nothing for most hits, score every
// leaf path in the sampled docs and pick the one that most looks like the
// log message: a reasonably long string present in most docs.
function detectDisplayField(hits, excludeChain) {
  const excluded = new Set(excludeChain);
  const paths = new Set();
  for (const h of hits) {
    if (h._source) collectLeafPaths(h._source, '', paths);
  }
  let best = null;
  let bestScore = 0;
  for (const path of paths) {
    if (excluded.has(path) || AUTO_FIELD_SKIP.test(path)) continue;
    let count = 0;
    let totalLen = 0;
    for (const h of hits) {
      const v = getNestedField(h._source || {}, path);
      if (typeof v === 'string' && v.trim().length >= 10) {
        count++;
        totalLen += v.length;
      }
    }
    if (count < hits.length / 2) continue;
    const score = count * 1000 + Math.min(totalLen / hits.length, 500);
    if (score > bestScore) {
      bestScore = score;
      best = path;
    }
  }
  return best;
}

// Runtime/cluster crud that's never useful for log investigation.
const FIELD_NOISE = [
  /^kubernetes\.docker_id$/,
  /^kubernetes\.container_hash$/,
  /^kubernetes\.container_image$/,
  /^kubernetes\.pod_id$/,
  /^kubernetes\.pod_ip$/,
];

function renderAvailableFields(hits, totalHits, fieldCaps, strata) {
  if (!hits || hits.length === 0) return null;
  const all = new Set();
  for (const h of hits) {
    if (h._source) collectLeafPaths(h._source, '', all);
  }
  let paths = Array.from(all)
    .filter(p => !FIELD_NOISE.some(rx => rx.test(p)))
    .sort();

  // Collapse kubernetes.annotations.* — almost always cluster runtime noise.
  const annotations = paths.filter(p => p.startsWith('kubernetes.annotations.'));
  if (annotations.length > 0) {
    paths = paths.filter(p => !p.startsWith('kubernetes.annotations.'));
    paths.push(`kubernetes.annotations.* _(${annotations.length} fields, expand explicitly if needed)_`);
    paths.sort();
  }

  // Field caps (from the dashboard's _fields_for_wildcard API) give us types
  // and aggregatability for the sampled paths — when the fetch succeeded.
  const capsByName = new Map();
  if (Array.isArray(fieldCaps)) {
    for (const f of fieldCaps) {
      if (f && f.name) capsByName.set(f.name, f);
    }
  }
  const renderPath = (p) => {
    const cap = capsByName.get(p);
    const kw = capsByName.get(`${p}.keyword`);
    if (!cap && !kw) return `- \`${p}\``;
    const type = cap?.type || 'object';
    const agg = cap?.aggregatable ? 'aggregatable'
              : kw?.aggregatable ? 'aggregatable via .keyword'
              : null;
    return `- \`${p}\` — ${type}${agg ? `, ${agg}` : ''}`;
  };

  const md = [];
  const capsNote = capsByName.size > 0 ? ', typed via field caps; aggregatable fields work in aggregate_fields' : '';
  const strataNote = Array.isArray(strata) && strata.length > 0
    ? `, stratified across ${strata.length} \`${FIELDS_STRATIFY_FIELD}\` values`
    : '';
  md.push(`## Available fields _(sampled from ${hits.length} of ${totalHits} hits${strataNote}${capsNote})_`);
  for (const p of paths) md.push(renderPath(p));
  return md.join('\n');
}

function describeStrata(strata, sampled) {
  if (!Array.isArray(strata) || strata.length === 0) return null;
  const label = FIELDS_STRATIFY_FIELD === 'kubernetes.container_name' ? 'container types' : `\`${FIELDS_STRATIFY_FIELD}\` values`;
  const parts = strata.map(s => `${s?.key} (${s?.doc_count ?? 0})`);
  return `Sampled ${sampled} docs across ${label}: ${parts.join(', ')}`;
}

function topValuesFromDocs(hits, field, n = 5) {
  const counts = new Map();
  const add = (v) => {
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) { v.forEach(add); return; }
    const key = typeof v === 'object' ? JSON.stringify(v) : String(v);
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (const h of hits || []) add(getNestedField(h._source || {}, field));
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, doc_count]) => ({ key, doc_count }));
}

function renderHistogramBuckets(buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) return '_(no histogram data)_';
  const max = Math.max(...buckets.map(b => b.doc_count || 0)) || 1;
  const lines = [];
  for (const b of buckets) {
    const count = b.doc_count || 0;
    const barLen = Math.round((count / max) * 20);
    const bar = '▇'.repeat(Math.max(barLen, count > 0 ? 1 : 0));
    const ts = b.key_as_string ? `${formatTimestamp(b.key_as_string).split('.')[0].replace(/Z$/, '')}Z` : b.key;
    lines.push(`- ${ts}  ${bar} ${count}`);
  }
  return lines.join('\n');
}

function describeEmptyBuckets(sourceField, fieldCaps, totalCount) {
  const base = sourceField.replace(/\.keyword$/, '');
  const caps = Array.isArray(fieldCaps) && fieldCaps.length > 0 ? fieldCaps : null;
  const cap = caps?.find(f => f?.name === base);
  const kw = caps?.find(f => f?.name === `${base}.keyword`);
  if (caps && !cap && !kw) return `_(field \`${base}\` does not exist in the index mapping — check available_log_fields)_`;
  if (totalCount === 0) return '_(no docs matched the query in this window)_';
  if (caps && !cap?.aggregatable && !kw?.aggregatable) return `_(field \`${base}\` exists but is not aggregatable and has no .keyword subfield)_`;
  if (caps) return `_(no values for \`${base}\` in the matching docs)_`;
  return `_(no buckets — \`${base}\` may not exist in the mapping, no docs matched, or it is not aggregatable and has no .keyword subfield; check available_log_fields)_`;
}

function renderSummary({ query, timeDesc, filterDesc, totalCount, raw, browserParams, fieldCaps }) {
  const md = [];
  md.push(`# Summary: \`${query}\` (${totalCount} hits, ${timeDesc})${filterDesc}`);
  md.push('');

  const aggs = raw.aggregations || {};
  const hits = raw.hits?.hits || [];

  // Histogram (key "2" matches inject.js).
  if (aggs["2"]?.buckets?.length) {
    md.push('## Time histogram');
    md.push(renderHistogramBuckets(aggs["2"].buckets));
    md.push('');
  }

  // Terms aggs — keys named `terms_<sanitised field>`, with meta.source_field for the original.
  for (const aggKey of Object.keys(aggs)) {
    if (!aggKey.startsWith('terms_')) continue;
    const agg = aggs[aggKey];
    const sourceField = agg.meta?.source_field || aggKey.replace(/^terms_/, '').replace(/_/g, '.');
    const buckets = agg.buckets || [];
    md.push(`## Top \`${sourceField}\``);
    if (buckets.length === 0) {
      md.push(describeEmptyBuckets(sourceField, fieldCaps, totalCount));
    } else {
      for (const b of buckets) {
        md.push(`- ${b.doc_count}  ${b.key}`);
      }
      const other = (agg.sum_other_doc_count || 0);
      if (other > 0) md.push(`- ${other}  _(other)_`);
    }
    md.push('');
  }

  md.push('---');
  md.push('Use `search_logs` with `exclude_filters` for the noisy rows above, or `include_filters` to scope to one of these values. If you don\'t know which fields exist, call `available_log_fields` first.');
  return md.join('\n');
}

function abbreviateLogger(name) {
  if (typeof name !== 'string' || !name) return '';
  const parts = name.split('.');
  if (parts.length <= 2) return name;
  return parts.map((p, i) => (i < parts.length - 2 && p ? p[0] : p)).join('.');
}

function computeSourceTag(src) {
  let source = '';
  for (const path of SOURCE_TAG_FIELDS) {
    const v = getNestedField(src, path);
    if (v !== undefined && v !== null && String(v).trim()) { source = String(v).trim(); break; }
  }
  const logger = [src?.logs?.loggerName, src?.logger, src?.logger_name]
    .find(v => typeof v === 'string' && v.trim());
  const parts = [];
  if (source) parts.push(`[${source}]`);
  if (logger) parts.push(abbreviateLogger(logger.trim()));
  return parts.join(' ');
}

function maskMessageTemplate(msg) {
  if (typeof msg !== 'string') return msg;
  return msg
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '#')
    .replace(/\d{4}-\d{2}-\d{2} [\d:.,]+/g, '#')
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '#')
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, m => ((m.match(/\d/g) || []).length >= 3 && /[A-Za-z]/.test(m)) ? '#' : m)
    .replace(/[0-9a-fA-F]{16,}/g, m => (/\d/.test(m) ? '#' : m))
    .replace(/\d{5,}/g, '#');
}

const INSPECT_MAX_FRAMES = 5;
const INSPECT_MAX_STRING = 4000;

function truncateInspectDoc(src) {
  const doc = structuredClone(src);
  if (doc.logs && typeof doc.logs === 'object' && !Array.isArray(doc.logs)
      && Object.keys(doc.logs).length > 0 && typeof doc.log === 'string') {
    delete doc.log;
  }
  const ann = doc.kubernetes?.annotations;
  if (ann && typeof ann === 'object') {
    doc.kubernetes.annotations = `(${Object.keys(ann).length} annotations collapsed — pass full: true)`;
  }
  const walk = (node) => {
    if (typeof node === 'string') {
      return node.length > INSPECT_MAX_STRING
        ? `${node.slice(0, INSPECT_MAX_STRING)}…(${node.length - INSPECT_MAX_STRING} more chars)`
        : node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        const v = node[key];
        if (key === 'extendedStackTrace' && Array.isArray(v) && v.length > INSPECT_MAX_FRAMES) {
          node[key] = [...v.slice(0, INSPECT_MAX_FRAMES).map(walk), `(${v.length - INSPECT_MAX_FRAMES} more frames)`];
        } else {
          node[key] = walk(v);
        }
      }
    }
    return node;
  };
  return walk(doc);
}

// 2. Factory to create a new MCP Server instance per connection
function createMcpServer() {
  const server = new Server(
    {
      name: "kibana-bridge-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const filterItemSchema = {
    type: "object",
    properties: {
      field: { type: "string", description: "Dotted field name, e.g. 'logs.loggerName' or 'kubernetes.labels.app_kubernetes_io_component'." },
      value: { type: "string", description: "Value to match. Default semantics are match_phrase (analyzed phrase match); see `match`." },
      match: {
        type: "string",
        enum: ["phrase", "wildcard"],
        description: "'phrase' (default) = match_phrase. 'wildcard' = case-insensitive wildcard on the keyword value; `*` matches any run of characters and `?` a single character, e.g. {field: 'logs.contextMap.CronJob', value: '*wIndex*', match: 'wildcard'}.",
      },
    },
    required: ["field", "value"],
    additionalProperties: false,
  };

  const queryDslSchema = {
    type: "object",
    additionalProperties: true,
    description: "Raw OpenSearch/Elasticsearch query DSL clause, AND-ed into the bool filter alongside `query` and the time range. Use for anything the plain text query can't express: numeric ranges ({range: {status: {gte: 500}}}), wildcards ({wildcard: {'url.keyword': '/api/*'}}), OR logic ({bool: {should: [...], minimum_should_match: 1}}), exists checks, etc.",
  };

  const queryFieldsNote = DEFAULT_QUERY_FIELDS.length > 0
    ? `The text is matched against these fields: ${DEFAULT_QUERY_FIELDS.join(', ')} (override with the QUERY_FIELDS env var).`
    : "The text is matched against the index's default query fields (QUERY_FIELDS env var is empty).";

  const queryParam = (lead) => ({
    type: "string",
    description: `${lead} An empty string or '*' matches all documents. ${queryFieldsNote}`,
  });

  const levelParam = {
    type: ["string", "array"],
    items: { type: "string" },
    description: `Filter on the level field (LEVEL_FIELD env, default logs.level; currently \`${LEVEL_FIELD}\`), e.g. 'ERROR' or ['ERROR','WARN']. Prefer this over putting ERROR in query, which also matches INFO messages containing the word error.`,
  };

  const timeParams = (defaultLookback) => ({
    minutes_lookback: {
      type: "number",
      description: `Window length in minutes. Default ${defaultLookback}. With neither time_from nor time_to it means the last N minutes up to now; with only time_to it means the N minutes ending at time_to; ignored when time_from is given. The response header always shows the resolved absolute UTC window.`,
    },
    time_from: { type: "string", description: "Absolute start time, ISO 8601 (e.g. '2026-09-23T10:28:00Z'). Without time_to, the window runs from here to now." },
    time_to: { type: "string", description: "Absolute end time, ISO 8601. Without time_from, the window starts minutes_lookback before this." },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const environmentParam = {
      type: "string",
      description: knownEnvironments.length > 0
        ? `Which dashboard environment to search, as configured in the extension popup. Available: ${knownEnvironments.join(', ')}. Default: ${knownEnvironments[0]}.`
        : "Which dashboard environment to search, as configured in the extension popup. The extension has not reported any environments yet — omit this unless the user names one.",
    };
    return {
      tools: [
        {
          name: "search_logs",
          description: [
            "Searches logs in Kibana / OpenSearch Dashboards via the active browser tab and returns hits.",
            "",
            "Workflow — investigate the same way a human does in Discover:",
            "1. Start with `summarize_logs` over a wide window (e.g. 7 days) to see total hit count, time histogram, and the top values for noisy dimensions (logger, component, pod, level).",
            "2. Identify noise dimensions — loggers that dominate the result set with irrelevant chatter, pod tiers that don't match the service you're investigating (e.g. frontend when chasing a backend bug), etc.",
            "3. Call `search_logs` with `exclude_filters` listing those noisy {field, value} pairs to narrow the result set.",
            "4. Iterate: if the remaining hits render empty messages, the docs likely keep their text under a different field — call `available_log_fields` and pass a matching `display_fields` fallback chain.",
            "5. Add more excludes or change `display_fields` until results are signal, not noise. Pin a specific row with `timestamp_match`.",
            "",
            "Boolean AND in `query`: 'term1 AND term2' requires both terms.",
            "",
            "IMPORTANT: This tool relies on a Chrome extension bridge — do NOT attempt to open browser tabs, navigate to URLs, or use any browser automation tools if this fails. If it errors, just report the error to the user."
          ].join('\n'),
          inputSchema: {
            type: "object",
            properties: {
              query: queryParam("The text to search for. Single term (e.g. 'OrderConfirmationJob') or multiple terms with AND (e.g. 'ORD-12345 AND payment')."),
              ...timeParams(15),
              size: { type: "number", description: "Max hits to return (must be ≥ 1). Default 500. For counts only, use summarize_logs." },
              level: levelParam,
              search_type: {
                type: "string",
                enum: ["phrase", "best_fields"],
                description: "'phrase' (default) for exact phrase, 'best_fields' for fuzzy.",
              },
              timestamp_match: {
                type: "string",
                description: "Pin results to a specific @timestamp (e.g. '2026-02-14T14:58:02.793Z').",
              },
              exclude_filters: {
                type: "array",
                items: filterItemSchema,
                description: "Drop hits that match any of these {field, value} pairs (must_not + match_phrase). Use to silence noisy loggers, components, pods, etc. Example: [{field: 'logger', value: 'com.example.cache.CacheUtil'}, {field: 'kubernetes.labels.app', value: 'frontend'}].",
              },
              include_filters: {
                type: "array",
                items: filterItemSchema,
                description: "Require hits to match all of these {field, value} pairs (OpenSearch filter + match_phrase). Use to scope to a specific service, pod, or status code.",
              },
              display_fields: {
                type: "array",
                items: { type: "string" },
                description: `Fallback chain of dotted field paths used to render each hit's message. The first non-empty value wins per hit. Default ${JSON.stringify(DEFAULT_DISPLAY_FIELDS)}. Use available_log_fields to discover which paths exist in your data.`,
              },
              full_message: {
                type: "boolean",
                description: "If true, messages are shown in full without truncation/compacting. Use when you need complete response bodies.",
              },
              query_dsl: queryDslSchema,
              environment: environmentParam,
            },
            required: ["query"],
          },
        },
        {
          name: "get_log_context",
          description: [
            "Returns the log entries within a time window around a specific timestamp. Use this when you've found a suspicious entry (an error, a state change, etc.) and need to see what happened immediately before and after — the human equivalent of clicking 'view surrounding documents' in Kibana/Discover.",
            "",
            "Default window is ±60 seconds (so 120s total). Narrow it with `window_seconds` for noisy services, widen for sparse logs.",
            "",
            `Use \`trace_id\` (filters on \`${TRACE_ID_FIELD}\`, TRACE_ID_FIELD env) or \`include_filters\` to scope to the same trace, pod, or service — otherwise you'll see ALL traffic in the window, which is often too much.`,
            "",
            "Pass `query` only if you also want to constrain by a search term in the window; usually leave it empty."
          ].join('\n'),
          inputSchema: {
            type: "object",
            properties: {
              timestamp: {
                type: "string",
                description: "The pivot ISO 8601 timestamp (e.g. '2026-05-06T06:49:57.647Z'). Take this from a previous search hit's @timestamp.",
              },
              window_seconds: {
                type: "number",
                description: "Half-window size in seconds. Default 60 (so total span = ±60s = 120s).",
              },
              query: queryParam("Optional text search applied within the window. Leave empty to see ALL logs around the timestamp (most common usage)."),
              trace_id: {
                type: "string",
                description: `Scope the window to one trace: adds an include filter on \`${TRACE_ID_FIELD}\` (override the field with the TRACE_ID_FIELD env var).`,
              },
              level: levelParam,
              include_filters: { type: "array", items: filterItemSchema, description: "Highly recommended — scope by traceId, pod_name, or service to avoid drowning in unrelated traffic." },
              exclude_filters: { type: "array", items: filterItemSchema },
              display_fields: {
                type: "array", items: { type: "string" },
                description: "Same fallback chain as search_logs.",
              },
              size: { type: "number", description: "Max hits in window (must be ≥ 1). Default 200." },
              full_message: { type: "boolean" },
              query_dsl: queryDslSchema,
              environment: environmentParam,
            },
            required: ["timestamp"],
          },
        },
        {
          name: "inspect_log",
          description: [
            "Returns the `_source` of one log entry as YAML. Use this when search shows a tantalizing single message and you need the full metadata: traceId, kubernetes labels, exception stack, request body, etc.",
            "",
            "By default the output is trimmed to stay readable: the raw `log` string is dropped when its parsed `logs.*` object is present, every `extendedStackTrace` keeps its first 5 frames, `kubernetes.annotations` is collapsed to a count, and strings over 4000 chars are cut. Pass `full: true` to get the untouched `_source`.",
            "",
            "Identifies the doc by `timestamp` (ISO with millisecond precision is usually unique). If multiple docs share the timestamp, pass `include_filters` (e.g. pod_name) to disambiguate — only the first match is returned."
          ].join('\n'),
          inputSchema: {
            type: "object",
            properties: {
              timestamp: {
                type: "string",
                description: "Exact ISO 8601 timestamp to match (e.g. '2026-05-06T06:49:57.647250Z').",
              },
              include_filters: {
                type: "array", items: filterItemSchema,
                description: "Optional disambiguation if multiple docs share the timestamp.",
              },
              full: {
                type: "boolean",
                description: "If true, return the complete `_source` with no truncation (stack traces, annotations, duplicate raw `log`). Default false.",
              },
              environment: environmentParam,
            },
            required: ["timestamp"],
          },
        },
        {
          name: "available_log_fields",
          description: [
            `Returns every populated field path (dotted) found in a sample of matching log docs, annotated with each field's type and aggregatability from the dashboard's field-caps API when available. Call this ONCE at the start of a fresh investigation to learn the schema — what \`aggregate_fields\` and \`display_fields\` paths are valid in this data. The tool samples hits stratified across \`${FIELDS_STRATIFY_FIELD}\` values (FIELDS_STRATIFY_FIELD env) so rare container types still contribute their fields, walks each doc's \`_source\`, and returns a deduplicated list grouped to keep \`kubernetes.annotations.*\` collapsed.`,
            "",
            "Use the result to decide which fields to summarize, exclude, include, or display. Subsequent investigation turns rarely need to re-call this — the schema is stable across queries.",
            "",
            "Tip: pair it on the very first turn with a `summarize_logs` call (in parallel) so you get distributions and schema in one shot."
          ].join('\n'),
          inputSchema: {
            type: "object",
            properties: {
              query: queryParam("Same as search_logs — picks docs to sample."),
              ...timeParams(60),
              search_type: { type: "string", enum: ["phrase", "best_fields"] },
              level: levelParam,
              include_filters: { type: "array", items: filterItemSchema },
              exclude_filters: { type: "array", items: filterItemSchema },
              query_dsl: queryDslSchema,
              environment: environmentParam,
            },
            required: ["query"],
          },
        },
        {
          name: "summarize_logs",
          description: [
            "Returns a cheap summary of a log query: total hits, time histogram, and top-N values for chosen dimensions. Use this BEFORE `search_logs` to see the shape of the data and decide which `exclude_filters` to apply. No hits are returned (size=0), so this is very cheap on tokens even over 7-day windows.",
            "",
            "Typical first call for an investigation: `summarize_logs(query, minutes_lookback: 10080)` — gives you total hits per day and the noisy dimensions to exclude in the follow-up search."
          ].join('\n'),
          inputSchema: {
            type: "object",
            properties: {
              query: queryParam("Same as search_logs."),
              ...timeParams(15),
              search_type: { type: "string", enum: ["phrase", "best_fields"] },
              level: levelParam,
              exclude_filters: {
                type: "array",
                items: filterItemSchema,
                description: "Same as search_logs — apply prior excludes so the summary reflects the narrowed set.",
              },
              include_filters: { type: "array", items: filterItemSchema },
              aggregate_fields: {
                type: "array",
                items: { type: "string" },
                description: `Dotted field paths to bucket by. Default ${JSON.stringify(DEFAULT_SUMMARY_FIELDS)}. The server appends '.keyword' automatically when needed. Discover valid paths with available_log_fields.`,
              },
              top_n: { type: "number", description: "Top values per field. Default 10." },
              query_dsl: queryDslSchema,
              environment: environmentParam,
            },
            required: ["query"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, withVersionNote(async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};

    if ((toolName === "search_logs" || toolName === "get_log_context")
        && args.size !== undefined && args.size !== null
        && !(typeof args.size === 'number' && args.size >= 1)) {
      return { content: [{ type: "text", text: "**Error:** `size` must be ≥ 1. For a count-only view use `summarize_logs`." }], isError: true };
    }

    // get_log_context: derive a time window around `timestamp`, then route into search.
    if (toolName === "get_log_context") {
      const { timestamp, window_seconds, query: ctxQuery, exclude_filters, display_fields, size, full_message, trace_id } = args;
      const include_filters = [
        ...(Array.isArray(args.include_filters) ? args.include_filters : []),
        ...(trace_id ? [{ field: TRACE_ID_FIELD, value: String(trace_id) }] : []),
      ];
      if (!timestamp) {
        return { content: [{ type: "text", text: "**Error:** `timestamp` is required" }], isError: true };
      }
      const win = (typeof window_seconds === 'number' && window_seconds > 0) ? window_seconds : 60;
      const pivot = new Date(timestamp);
      if (isNaN(pivot.getTime())) {
        return { content: [{ type: "text", text: `**Error:** invalid timestamp: ${timestamp}` }], isError: true };
      }
      const time_from = new Date(pivot.getTime() - win * 1000).toISOString();
      const time_to = new Date(pivot.getTime() + win * 1000).toISOString();
      // Re-dispatch into the regular search path with derived params.
      const rewrittenArgs = {
        query: ctxQuery || '',
        time_from,
        time_to,
        size: size || 200,
        include_filters,
        exclude_filters,
        display_fields,
        full_message,
      };
      // Recurse via the same handler. We reuse the search code path below by
      // setting toolName variables manually — easier than calling the handler.
      args.query = rewrittenArgs.query;
      args.time_from = rewrittenArgs.time_from;
      args.time_to = rewrittenArgs.time_to;
      args.size = rewrittenArgs.size;
      args.include_filters = rewrittenArgs.include_filters;
      args.exclude_filters = rewrittenArgs.exclude_filters;
      args.display_fields = rewrittenArgs.display_fields;
      args.full_message = rewrittenArgs.full_message;
      // fall through to the search branch via a synthesised toolName
    }

    // inspect_log: pin to one doc by timestamp, render full _source as YAML.
    if (toolName === "inspect_log") {
      const { timestamp, include_filters, environment, full } = args;
      if (!timestamp) {
        return { content: [{ type: "text", text: "**Error:** `timestamp` is required" }], isError: true };
      }
      try {
        const browserParams = buildBrowserParams({
          query: '',
          time_from: new Date(new Date(timestamp).getTime() - 5000).toISOString(),
          time_to: new Date(new Date(timestamp).getTime() + 5000).toISOString(),
          size: 5,
          timestamp_match: timestamp,
          include_filters,
          environment,
        }, 'search', 'inspect_log');
        console.error(`[MCP Server] 🔬 inspect: ${timestamp}`);
        const rawResult = await executeBrowserSearch(browserParams);
        const raw = rawResult.rawResponse || rawResult;
        const hits = raw.hits?.hits || [];
        if (hits.length === 0) {
          return { content: [{ type: "text", text: `# Inspect: \`${timestamp}\`\n\n_(no doc matched — verify timestamp precision or pass include_filters to disambiguate)_` }] };
        }
        const md = [`# Inspect: \`${timestamp}\``, ''];
        if (hits.length > 1) md.push(`_(${hits.length} docs matched, showing the first — pass include_filters to disambiguate)_`, '');
        const src = full ? (hits[0]._source || {}) : truncateInspectDoc(hits[0]._source || {});
        md.push('```yaml');
        md.push(yamlStringify(src, { lineWidth: 0 }).trim());
        md.push('```');
        if (!full) md.push('', '_(truncation applied: duplicate `log`, stack frames beyond 5, annotations, long strings — pass `full: true` to disable)_');
        return { content: [{ type: "text", text: md.join('\n') }] };
      } catch (error) {
        return { content: [{ type: "text", text: `**Error:** ${error.message}` }], isError: true };
      }
    }

    const isContextTool = toolName === "get_log_context";
    if (toolName === "search_logs" || toolName === "summarize_logs" || toolName === "available_log_fields" || isContextTool) {
      const { query, full_message, display_fields, exclude_filters, include_filters, level } = args;
      const mode = toolName === "summarize_logs" ? "summarize"
                 : toolName === "available_log_fields" ? "fields"
                 : "search";

      try {
        const timeWindow = resolveTimeWindow(args, mode === 'fields' ? 60 : 15);
        const timeDesc = describeTime(timeWindow);
        const filterDesc = describeFilterBadges(include_filters, exclude_filters, level);
        const icon = mode === 'summarize' ? '📊' : mode === 'fields' ? '🗂️ ' : '🔍';
        console.error(`[MCP Server] ${icon} ${mode}: "${query}" (${timeDesc})${filterDesc}`);

        const browserParams = buildBrowserParams(args, mode, toolName, timeWindow);
        if (mode === 'summarize' && browserParams.aggregateFields.length === 0) {
          browserParams.aggregateFields = DEFAULT_SUMMARY_FIELDS;
        }

        const rawResult = await executeBrowserSearch(browserParams);

        // Unwrap rawResponse envelope from OpenSearch Dashboards
        const raw = rawResult.rawResponse || rawResult;

        const hits = raw.hits?.hits || [];
        const totalCount = typeof raw.hits?.total === 'object' ? raw.hits.total.value : raw.hits?.total || 0;

        if (mode === 'summarize') {
          const aggKeys = Object.keys(raw.aggregations || {});
          console.error(`[MCP Server] ✅ Summary: ${totalCount} hits, sent agg fields=[${browserParams.aggregateFields.join(',')}], received agg keys=[${aggKeys.join(',')}]`);
          return {
            content: [{ type: "text", text: renderSummary({ query, timeDesc, filterDesc, totalCount, raw, browserParams, fieldCaps: rawResult.fieldCaps }) }],
          };
        }

        if (mode === 'fields') {
          console.error(`[MCP Server] ✅ Fields: ${totalCount} matched, sampled ${hits.length}`);
          const md = [];
          md.push(`# Available fields: \`${query}\` (${totalCount} hits, ${timeDesc})${filterDesc}`);
          md.push('');
          if (hits.length === 0) {
            md.push('_(no hits — cannot enumerate fields. Try a wider time range or different query.)_');
          } else {
            const strataLine = describeStrata(rawResult.strata, hits.length);
            if (strataLine) md.push(strataLine, '');
            const block = renderAvailableFields(hits, totalCount, rawResult.fieldCaps, rawResult.strata);
            if (block) md.push(block);
          }
          return { content: [{ type: "text", text: md.join('\n') }] };
        }

        console.error(`[MCP Server] ✅ Returning ${totalCount} total hits (${hits.length} shown)`);

        const stripHighlight = (str) => typeof str === 'string'
          ? str.replace(/@opensearch-dashboards-highlighted-field@/g, '').replace(/@\/opensearch-dashboards-highlighted-field@/g, '')
          : str;

        const MAX_KEYS = 25;
        const MAX_VAL = 60;

        function jsonToYaml(o) {
          const yamlStr = yamlStringify(o, { lineWidth: 0 });
          return yamlStr.replace(/\n/g, '\n  ');
        }

        function xmlToCompact(xml) {
          const pairs = [];
          const itemBlocks = xml.split(/<item\s*\/?>|<\/item>/).filter(Boolean);
          const simpleTag = /<([\w]+)>([^<]*)<\/\1>/g;
          if (itemBlocks.length > 1) {
            const maxItems = 12;
            for (let i = 0; i < Math.min(itemBlocks.length, maxItems); i++) {
              const block = itemBlocks[i];
              const part = [];
              let m;
              const re = new RegExp('<([\\w]+)>([^<]*)</\\1>', 'g');
              while ((m = re.exec(block)) !== null) part.push(`${m[1]}=${m[2]}`);
              if (part.length) pairs.push(part.join(' '));
            }
            if (itemBlocks.length > maxItems) pairs.push('..+' + (itemBlocks.length - maxItems));
            return pairs.join(' | ');
          }
          let m;
          while ((m = simpleTag.exec(xml)) !== null) {
            if (pairs.length >= MAX_KEYS) break;
            const val = m[2].length <= MAX_VAL ? m[2] : m[2].slice(0, MAX_VAL - 2) + '..';
            pairs.push(`${m[1]}=${val}`);
          }
          return pairs.join(' ');
        }

        function tryAccessLog(o) {
          const line = o.requestFirstLine || (o.contextMap && o.contextMap.requestLine) || '';
          if (!line) return null;
          const parts = line.match(/^(\S+)\s+(\S+)/);
          if (!parts) return null;
          const method = parts[1];
          const fullPath = parts[2];
          const path = fullPath.split('?')[0];
          const status = o.status || (o.contextMap && o.contextMap.statusCode) || '';
          const ms = o.responseTime || (o.contextMap && o.contextMap.processMillis) || '';
          return `${method} ${path} ${status} ${ms}ms`;
        }

        function simplifyMessage(msg, noCut) {
          if (!msg || typeof msg !== 'string') return msg;
          const s = msg.trim();
          if (noCut) return s;

          const jsonIdx = s.indexOf('{');
          if (jsonIdx !== -1) {
            const prefix = s.slice(0, jsonIdx).trim();
            const jsonStr = s.slice(jsonIdx);
            try {
              const o = JSON.parse(jsonStr);
              const al = tryAccessLog(o);
              if (al) return al;
              const yaml = jsonToYaml(o);
              return prefix ? prefix + '\n  ' + yaml : '  ' + yaml;
            } catch (_) {}
          }

          const xmlIdx = s.search(/<\/?[\w:]+[\s>]/);
          if (xmlIdx !== -1) {
            const prefix = s.slice(0, xmlIdx).trim();
            const xmlPart = s.slice(xmlIdx);
            const compact = xmlToCompact(xmlPart);
            if (compact) return prefix ? prefix + ' ' + compact : compact;
          }

          if (s.length > 200) return s.slice(0, 197) + '..';
          return s;
        }

        const md = [];
        md.push(`# Search Results: \`${query}\` (${totalCount} hits, ${timeDesc})${filterDesc}`);
        md.push('');

        const fieldChain = (Array.isArray(display_fields) && display_fields.length > 0)
          ? display_fields
          : DEFAULT_DISPLAY_FIELDS;

        const valueToString = (v) => {
          if (v === undefined || v === null) return '';
          if (typeof v === 'string') return v;
          if (typeof v === 'number' || typeof v === 'boolean') return String(v);
          try { return JSON.stringify(v); } catch (_) { return String(v); }
        };

        const events = [];
        for (const h of hits) {
          const src = h._source || {};
          const level = src.logs?.level || src.level || getNestedField(src, 'log.level') || 'INFO';
          const time = src["@timestamp"];

          // Walk display_fields fallback chain, first non-empty wins.
          let message = '';
          let usedField = null;
          for (const path of fieldChain) {
            const raw = valueToString(getNestedField(src, path)).replace(/\s+/g, ' ').trim();
            if (raw) { message = raw; usedField = path; break; }
          }
          // Last-resort fallback: a non-contextMap highlight (preserves prior behaviour).
          if (!message && h.highlight) {
            const key = Object.keys(h.highlight).find(k => !k.includes('contextMap')) || Object.keys(h.highlight)[0];
            if (key) message = stripHighlight(h.highlight[key][0]).replace(/\s+/g, ' ').trim();
          }

          message = simplifyMessage(message, full_message);
          events.push({ time, level, message, usedField, tag: computeSourceTag(src) });
        }

        // Auto-detect a display field when the configured chain misses most
        // hits — the log text lives under a schema-specific path. Uses the
        // already-fetched _source docs, so this costs no extra round trip.
        let autoField = null;
        if (events.length > 0 && events.filter(e => !e.message).length > events.length / 2) {
          autoField = detectDisplayField(hits, fieldChain);
          if (autoField) {
            for (let i = 0; i < events.length; i++) {
              if (events[i].message) continue;
              const raw = valueToString(getNestedField(hits[i]._source || {}, autoField)).replace(/\s+/g, ' ').trim();
              if (raw) {
                events[i].message = simplifyMessage(raw, full_message);
                events[i].usedField = autoField;
              }
            }
          }
        }

        const groups = [];
        for (const ev of events) {
          const key = `${ev.level}\0${ev.tag}\0${maskMessageTemplate(ev.message)}`;
          const last = groups[groups.length - 1];
          if (last && last.key === key) {
            last.count++;
            last.endTime = ev.time;
            if (ev.message !== last.message) last.pattern = true;
          } else {
            groups.push({ key, level: ev.level, tag: ev.tag, message: ev.message, count: 1, startTime: ev.time, endTime: ev.time, pattern: false });
          }
        }

        groups.forEach(g => {
          const icon = g.level === 'ERROR' ? '🔴' : g.level === 'WARN' ? '🟡' : '🟢';
          const timeStr = g.startTime === g.endTime
            ? formatTimestamp(g.startTime)
            : `${formatTimestamp(g.startTime)} → ${formatTimestamp(g.endTime)}`;
          const countPrefix = g.count > 1 ? `x${g.count} ` : '';
          const tagStr = g.tag ? `${g.tag} ` : '';
          const patternStr = g.pattern ? ' _(pattern)_' : '';
          md.push(`- ${countPrefix}${timeStr} ${icon} ${tagStr}${g.message}${patternStr}`);
        });

        if (autoField) {
          md.push('');
          md.push(`_(some messages auto-rendered from \`${autoField}\` because the default display fields were empty — pass \`display_fields\` to override)_`);
        }

        // 0-hit helper: re-run the same query+time without filters and show
        // what fields exist, so the AI can spot wrong filter paths or rethink scope.
        if (totalCount === 0) {
          md.push('');
          md.push('---');
          md.push('## 0 hits — debug helper');
          md.push(`Window: ${timeDesc}`);
          md.push('');
          try {
            const helperParams = {
              ...browserParams,
              mode: 'fields',
              includeFilters: [],
              excludeFilters: [],
              aggregateFields: [],
              queryDsl: null,
              stratifyField: FIELDS_STRATIFY_FIELD,
            };
            const helperRaw = await executeBrowserSearch(helperParams);
            const helper = helperRaw.rawResponse || helperRaw;
            const helperHits = helper.hits?.hits || [];
            const helperTotal = typeof helper.hits?.total === 'object' ? helper.hits.total.value : helper.hits?.total || 0;
            if (helperHits.length > 0) {
              md.push(`Without filters, this query + time range matches **${helperTotal}** hits. Your filter paths may not match populated fields.`);
              const filteredFields = Array.from(new Set([
                ...browserParams.includeFilters,
                ...browserParams.excludeFilters,
              ].map(f => f?.field).filter(Boolean).concat(normalizeLevels(level).length > 1 ? [LEVEL_FIELD] : [])));
              if (filteredFields.length > 0) {
                let aggs = {};
                try {
                  const valuesRaw = await executeBrowserSearch({
                    ...browserParams,
                    mode: 'summarize',
                    includeFilters: [],
                    excludeFilters: [],
                    queryDsl: null,
                    stratifyField: null,
                    aggregateFields: filteredFields,
                    topN: 5,
                  });
                  aggs = (valuesRaw.rawResponse || valuesRaw).aggregations || {};
                } catch (_) {}
                const bucketsByField = new Map();
                for (const [aggKey, agg] of Object.entries(aggs)) {
                  if (!aggKey.startsWith('terms_')) continue;
                  const src = (agg.meta?.source_field || aggKey.replace(/^terms_/, '').replace(/_/g, '.')).replace(/\.keyword$/, '');
                  bucketsByField.set(src, agg.buckets || []);
                }
                md.push('');
                for (const field of filteredFields) {
                  let buckets = bucketsByField.get(field) || [];
                  let sampled = false;
                  if (buckets.length === 0) {
                    buckets = topValuesFromDocs(helperHits, field, 5);
                    sampled = buckets.length > 0;
                  }
                  if (buckets.length === 0) {
                    md.push(`Top values for \`${field}\`: _(none — field is absent from these docs)_`);
                  } else {
                    const vals = buckets.slice(0, 5).map(b => `\`${b.key}\` (${b.doc_count})`).join(', ');
                    md.push(`Top values for \`${field}\`${sampled ? ` _(from ${helperHits.length} sampled docs)_` : ''}: ${vals}`);
                  }
                }
                md.push('');
                md.push('Filter values use match_phrase semantics (analyzed phrase match, not substring). For partial values pass `match: "wildcard"` with `*`/`?`, e.g. `{field, value: "*wIndex*", match: "wildcard"}`.');
              }
              md.push('');
              md.push('Available fields in the unfiltered hits:');
              md.push('');
              const block = renderAvailableFields(helperHits, helperTotal, helperRaw.fieldCaps, helperRaw.strata);
              if (block) md.push(block);
            } else {
              md.push(`Even without filters, this query + time range has 0 hits. Likely the query string is too narrow or the time range has no data. Try widening the time range or different search terms.`);
            }
          } catch (e) {
            md.push(`_(could not fetch field hint: ${e.message})_`);
          }
        }

        return {
          content: [{ type: "text", text: md.join('\n') }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `**Error:** ${error.message}` }],
          isError: true,
        };
      }
    }
    throw new Error("Tool not found");
  }));

  return server;
}

// 3. Setup HTTP server for MCP transports (supports multiple clients).
// Streamable HTTP at /mcp (current spec), legacy SSE at /sse.
const sessions = new Map(); // sessionId -> { server, transport }
const streamableSessions = new Map(); // sessionId -> transport

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${MCP_PORT}`);
  const pathname = url.pathname;

  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      name: 'kibana-bridge-mcp', version: VERSION, build: BUILD, stdio: STDIO,
      extension: { connected: !!activeBrowserConnection, version: extensionVersion, environments: knownEnvironments },
    }));
    return;
  }

  if (pathname === '/handoff' && req.method === 'POST') {
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      res.writeHead(403);
      res.end('loopback only');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let peer = null;
    try { peer = JSON.parse(body); } catch (e) { /* invalid */ }
    if (!peer || !isNewerBuild(peer, { version: VERSION, build: BUILD })) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not newer', version: VERSION, build: BUILD }));
      return;
    }
    if (!STDIO || handoffInProgress) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: STDIO ? 'handoff in progress' : 'primary is not stdio-managed; restart it yourself', version: VERSION, build: BUILD }));
      return;
    }
    handoffInProgress = true;
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    setImmediate(() => demoteToProxy(peer));
    return;
  }

  if (pathname === '/mcp') {
    const sessionId = req.headers['mcp-session-id'];
    let transport = sessionId ? streamableSessions.get(sessionId) : undefined;

    if (!transport) {
      if (req.method !== 'POST') {
        res.writeHead(400);
        res.end('Unknown session');
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          streamableSessions.set(id, transport);
          console.error(`[MCP Server] 🔗 MCP client connected via Streamable HTTP (session: ${id}, total: ${streamableSessions.size})`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          streamableSessions.delete(transport.sessionId);
          console.error(`[MCP Server] 🔌 Streamable HTTP client disconnected (session: ${transport.sessionId}, remaining: ${streamableSessions.size})`);
        }
      };
      const server = createMcpServer();
      await server.connect(transport);
    }

    await transport.handleRequest(req, res);
    return;
  }

  if (pathname === '/sse' && req.method === 'GET') {
    const transport = new SSEServerTransport('/messages', res);
    const server = createMcpServer();
    const sessionId = transport.sessionId;

    sessions.set(sessionId, { server, transport });
    console.error(`[MCP Server] 🔗 MCP client connected via SSE (session: ${sessionId}, total: ${sessions.size})`);

    // Clean up when client disconnects
    res.on('close', () => {
      sessions.delete(sessionId);
      server.close();
      console.error(`[MCP Server] 🔌 MCP client disconnected (session: ${sessionId}, remaining: ${sessions.size})`);
    });

    await server.connect(transport);
    return;
  }

  if (pathname === '/messages' && req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    const session = sessions.get(sessionId);
    if (session) {
      await session.transport.handlePostMessage(req, res);
    } else {
      res.writeHead(400);
      res.end('Unknown session');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function startHttpServer() {
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(MCP_PORT, HOST, () => {
      httpServer.on('error', (err) => console.error(`[MCP Server] ❌ HTTP server error:`, err.message));
      resolve();
    });
  });
}

// Is a healthy kibana-bridge-mcp already listening on MCP_PORT?
async function checkRunningPeer() {
  try {
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.name === 'kibana-bridge-mcp' ? body : null;
  } catch (e) {
    return null;
  }
}

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function isNewerBuild(candidate, current) {
  const byVersion = compareVersions(candidate?.version, current?.version);
  if (byVersion !== 0) return byVersion > 0;
  return (Number(candidate?.build) || 0) > (Number(current?.build) || 0);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForPeer({ build = null, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const peer = await checkRunningPeer();
    if (peer && (build === null || peer.build === build)) return peer;
    await sleep(300);
  }
  return null;
}

let stdioServer = null;
let handoffInProgress = false;

function proxyClient() {
  return new Client({ name: 'kibana-bridge-mcp-proxy', version: VERSION }, { capabilities: {} });
}

async function connectProxyClient() {
  const client = proxyClient();
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`)));
  return client;
}

// Point a stdio-facing Server at a Client connected to the primary, and
// keep it pointed there across primary restarts (handoffs).
function bindProxyHandlers(server, client) {
  let current = client;
  let reconnecting = null;
  const reconnect = () => {
    if (!reconnecting) {
      console.error('[MCP Server] 🔁 Primary went away, waiting for a new one...');
      const stale = current;
      stale.onclose = null;
      reconnecting = (async () => {
        try { await stale.close(); } catch (e) { /* already closed */ }
        const peer = await waitForPeer({ timeoutMs: 30000 });
        if (!peer) {
          console.error('[MCP Server] ❌ No primary came back within 30s, exiting');
          process.exit(1);
        }
        current = await connectProxyClient();
        watch(current);
        console.error(`[MCP Server] 🔁 Reattached to the new primary (v${peer.version})`);
        return current;
      })().finally(() => { reconnecting = null; });
    }
    return reconnecting;
  };
  const lostPrimary = (e) => e?.code === 400 || e?.code === 404
    || /Unknown session|Session not found|Server not initialized|Bad Request|ECONNREFUSED|fetch failed/.test(String(e?.message || e));
  const call = async (fn) => {
    const c = await (reconnecting || Promise.resolve(current));
    try {
      return await fn(c);
    } catch (e) {
      if (!lostPrimary(e)) throw e;
      return fn(await reconnect());
    }
  };
  server.setRequestHandler(ListToolsRequestSchema, () => call(c => c.listTools()));
  server.setRequestHandler(CallToolRequestSchema, (req) => call(c => c.callTool(req.params, undefined, { timeout: 120000 })));
  const watch = (c) => {
    c.onclose = () => { if (current === c && !reconnecting) reconnect().catch(() => process.exit(1)); };
  };
  watch(client);
}

// Serve MCP over stdio backed by this process's own tool handlers.
async function attachStdioPrimary() {
  stdioServer = createMcpServer();
  stdioServer.onclose = () => console.error('[MCP Server] 🔌 stdio client disconnected (HTTP/WS still running)');
  await stdioServer.connect(new StdioServerTransport());
  console.error('[MCP Server] 🔗 MCP stdio transport attached');
}

// A newer instance asked to take over: release the ports, wait for it to
// bind, then keep serving our own stdio client by forwarding to it.
async function demoteToProxy(peer) {
  console.error(`[MCP Server] 🔄 Newer instance (v${peer.version}) is taking over, handing off the browser bridge...`);
  try { activeBrowserConnection?.close(); } catch (e) { /* already gone */ }
  for (const ws of wss?.clients || []) { try { ws.terminate(); } catch (e) { /* ignore */ } }
  await new Promise(r => wss.close(() => r()));
  for (const t of streamableSessions.values()) { try { await t.close(); } catch (e) { /* ignore */ } }
  for (const { server } of sessions.values()) { try { await server.close(); } catch (e) { /* ignore */ } }
  httpServer.closeAllConnections?.();
  await new Promise(r => httpServer.close(() => r()));
  activeBrowserConnection = null;

  const next = await waitForPeer({ build: peer.build, timeoutMs: 20000 });
  if (!next) {
    console.error('[MCP Server] ❌ The new instance never came up, exiting');
    process.exit(1);
  }
  if (stdioServer) {
    const client = await connectProxyClient();
    bindProxyHandlers(stdioServer, client);
    stdioServer.onclose = () => process.exit(0);
  }
  handoffInProgress = false;
  console.error(`[MCP Server] 🔁 Now proxying stdio to the new primary (v${next.version})`);
}

// We are newer than the running primary: ask it to step down, then take the
// ports ourselves. Returns true when we became the primary.
async function takeOverFrom(peer) {
  try {
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: VERSION, build: BUILD }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.status !== 202) {
      const body = await res.json().catch(() => ({}));
      console.error(`[MCP Server] ℹ️  Primary (v${peer.version}) declined handoff: ${body.error || res.status}`);
      return false;
    }
  } catch (e) {
    console.error(`[MCP Server] ℹ️  Handoff request failed: ${e.message}`);
    return false;
  }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(300);
    try {
      await startWebSocketServer();
      await startHttpServer();
      console.error(`[MCP Server] ✅ Took over the browser bridge from v${peer.version}`);
      return true;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      try { wss?.close(); } catch (e) { /* not bound */ }
    }
  }
  console.error('[MCP Server] ❌ Primary did not release the ports in time');
  return false;
}

// Another instance owns the browser bridge — serve stdio by forwarding every
// request to it over Streamable HTTP, so multiple MCP clients can each spawn
// `npx kibana-bridge-mcp` and transparently share one bridge.
async function runStdioProxy(peer) {
  const live = await waitForPeer({ timeoutMs: 30000 }) || peer;
  const client = await connectProxyClient();
  const server = new Server({ name: 'kibana-bridge-mcp', version: VERSION }, { capabilities: { tools: {} } });
  bindProxyHandlers(server, client);
  server.onclose = () => process.exit(0);
  await server.connect(new StdioServerTransport());
  console.error(`[MCP Server] 🔁 Proxying stdio to the running instance (v${live.version}) at http://127.0.0.1:${MCP_PORT}/mcp`);
}

// Serve stdio with every tool returning the startup failure, so the AI can
// relay it to the user instead of the MCP server silently dying.
async function attachStdioBroken(message) {
  const server = new Server({ name: 'kibana-bridge-mcp', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{
      name: 'kibana_bridge_status',
      description: 'The Kibana Bridge MCP server could not start. Call this to get the error and the fix to relay to the user.',
      inputSchema: { type: 'object', properties: {} },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: 'text', text: `**Error:** ${message}` }], isError: true }));
  server.onclose = () => process.exit(1);
  await server.connect(new StdioServerTransport());
}

function portInUseMessage(port, role) {
  const freeCmd = process.platform === 'win32'
    ? `netstat -ano | findstr :${port}, then taskkill /PID <pid> /F`
    : `lsof -ti:${port} | xargs kill`;
  const envVar = role === 'WebSocket' ? 'WS_PORT' : 'MCP_PORT';
  const extra = role === 'WebSocket' ? ' and set the same port in the extension popup' : '';
  return `Port ${port} (${role}) is in use by another program. Free it (${freeCmd}) or set ${envVar} in the MCP server config${extra}, then reconnect the MCP server.`;
}

async function main() {
  let failedPort = null;
  try {
    await startWebSocketServer().catch(err => { failedPort = { port: WS_PORT, role: 'WebSocket' }; throw err; });
    await startHttpServer().catch(err => { failedPort = { port: MCP_PORT, role: 'HTTP' }; throw err; });
  } catch (err) {
    if (err.code !== 'EADDRINUSE') {
      console.error(`[MCP Server] ❌ Failed to start:`, err.message);
      process.exit(1);
    }
    try { wss?.close(); } catch (e) { /* may not have bound */ }

    const peer = await checkRunningPeer();
    if (!peer) {
      const message = portInUseMessage(failedPort.port, failedPort.role);
      console.error(`[MCP Server] ❌ ${message}`);
      if (!STDIO) process.exit(1);
      await attachStdioBroken(message);
      return;
    }
    const tookOver = isNewerBuild({ version: VERSION, build: BUILD }, peer) && await takeOverFrom(peer);
    if (!tookOver) {
      if (STDIO) {
        await runStdioProxy(peer);
        return;
      }
      console.error(`[MCP Server] ✅ Already running (v${peer.version}) at http://127.0.0.1:${MCP_PORT}/mcp — nothing to do.`);
      process.exit(0);
    }
  }

  console.error("[MCP Server] 🚀 Kibana Bridge MCP Server running");
  console.error(`[MCP Server] 🔗 MCP endpoint (Streamable HTTP): http://localhost:${MCP_PORT}/mcp`);
  console.error(`[MCP Server] 🔗 MCP endpoint (legacy SSE): http://localhost:${MCP_PORT}/sse`);
  console.error(`[MCP Server] 🔌 Browser WebSocket: ws://localhost:${WS_PORT}`);
  console.error("[MCP Server] ⏳ Waiting for connections...");

  if (STDIO) await attachStdioPrimary();
}

main().catch((err) => {
  console.error(`[MCP Server] ❌ Fatal:`, err);
  process.exit(1);
});
