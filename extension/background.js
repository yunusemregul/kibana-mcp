// background.js: Service worker (not subject to page CSP)
// Handles WebSocket connection to the MCP server.
const DEFAULT_SETTINGS = {
  // Each environment: { name, dashboardPattern ("https://host/*"), indexPattern }
  environments: [],
  wsPort: 47821,
};

let settings = { ...DEFAULT_SETTINGS };
let settingsLoaded = loadSettings();
let ws = null;
let wsConnected = false;
let lastSearch = null;
let searchHistory = [];

const MESSAGE_FIELDS = ["message", "logs.message", "msg", "log", "logs.request", "logs.requestFirstLine"];
function dig(obj, path) {
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}
function summarizeHit(hit) {
  const src = hit?._source || {};
  let text = null;
  for (const f of MESSAGE_FIELDS) {
    const v = dig(src, f);
    if (v != null && v !== "") { text = typeof v === "string" ? v : JSON.stringify(v); break; }
  }
  if (text == null) text = JSON.stringify(src);
  const level = dig(src, "logs.level") || dig(src, "level") || dig(src, "log.level") || null;
  return { ts: src["@timestamp"] || null, level, text: String(text).slice(0, 220) };
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get({
    ...DEFAULT_SETTINGS,
    // Legacy single-environment keys (pre-multi-env versions)
    dashboardPattern: "",
    indexPattern: "",
  });
  let environments = Array.isArray(stored.environments) ? stored.environments : [];
  if (environments.length === 0 && stored.dashboardPattern) {
    environments = [{
      name: "default",
      dashboardPattern: stored.dashboardPattern,
      indexPattern: stored.indexPattern || "logs-*",
    }];
    await chrome.storage.sync.set({ environments });
    await chrome.storage.sync.remove(["dashboardPattern", "indexPattern"]);
  }
  let wsPort = stored.wsPort || 47821;
  if (wsPort === 3000) {
    wsPort = 47821;
    await chrome.storage.sync.set({ wsPort });
  }
  settings = { environments, wsPort };
}

function sendHello() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "HELLO",
      environments: (settings.environments || []).map(e => e.name),
      version: chrome.runtime.getManifest().version,
    }));
  }
}

// Inject the header status badge into every configured dashboard (only
// origins the user granted; unconfigured sites are never touched).
async function syncBadgeScripts() {
  await settingsLoaded;
  const matches = (settings.environments || []).map(e => e.dashboardPattern);
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ["klb-badge"] });
  } catch (e) { /* not registered yet */ }
  if (matches.length === 0) return;
  try {
    const granted = await chrome.permissions.contains({ origins: matches });
    if (!granted) return;
    await chrome.scripting.registerContentScripts([{
      id: "klb-badge",
      matches,
      js: ["badge.js"],
      runAt: "document_idle",
    }]);
    for (const tab of await chrome.tabs.query({ url: matches })) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["badge.js"] }).catch(() => {});
    }
  } catch (e) {
    console.log("[Kibana Log Bridge] badge registration failed:", e.message);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  const oldPort = settings.wsPort;
  if (changes.environments?.newValue !== undefined) {
    settings.environments = changes.environments.newValue;
    syncBadgeScripts();
  }
  if (changes.wsPort?.newValue !== undefined) settings.wsPort = changes.wsPort.newValue;
  sendHello();
  if (settings.wsPort !== oldPort && ws) {
    ws.close(); // onclose handler reconnects with the new port
  }
});

// --- Keep service worker alive ---
// MV3 service workers die after ~30s of inactivity, killing our WebSocket.
// Use chrome.alarms (minimum 30s) + periodic pings to stay alive.
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 }); // ~24s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    // Ping the WebSocket to keep both SW and connection alive
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "PING" }));
    } else if (!ws) {
      connect();
    }
  }
});

function lightStatus() {
  return { wsConnected, environments: settings.environments || [], lastSearch, searchHistory };
}

// Push the current status to the header pills of every configured tab so
// search progress shows up immediately instead of on the next poll.
function notifyBadges() {
  const matches = (settings.environments || []).map(e => e.dashboardPattern);
  if (matches.length === 0) return;
  chrome.tabs.query({ url: matches }, (tabs) => {
    if (chrome.runtime.lastError) return;
    const status = lightStatus();
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "BADGE_STATUS", status }, () => void chrome.runtime.lastError);
    }
  });
}

function updateBadge() {
  const color = wsConnected ? "#22c55e" : "#ef4444";
  const text = wsConnected ? "ON" : "OFF";
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

async function connect() {
  await settingsLoaded;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return; // Already connected or connecting
  }

  ws = new WebSocket(`ws://localhost:${settings.wsPort}`);

  ws.onopen = () => {
    wsConnected = true;
    updateBadge();
    notifyBadges();
    console.log("%c[Kibana Log Bridge] %c✅ Connected to MCP Server", "color:#6366f1;font-weight:bold", "color:#22c55e");
    sendHello();
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "PONG") return; // Ignore keepalive responses

    if (msg.type === "EXECUTE_SEARCH") {
      const timeDesc = msg.timeFrom && msg.timeTo
        ? `${msg.timeFrom} → ${msg.timeTo}`
        : `last ${msg.timeRangeMinutes} min`;
      console.log(`%c[Kibana Log Bridge] %c🔍 Search: "${msg.query}" (${timeDesc})`, "color:#6366f1;font-weight:bold", "color:#f59e0b");

      lastSearch = {
        query: msg.query,
        environment: msg.environment || null,
        time: new Date().toLocaleTimeString(),
        requestId: msg.requestId,
        status: "searching",
        hits: null,
        mode: msg.mode || "search",
        tool: msg.tool || null,
        timestampMatch: msg.timestampMatch || null,
        queryDsl: msg.queryDsl || null,
        timeFrom: msg.timeFrom || null,
        timeTo: msg.timeTo || null,
        timeRangeMinutes: msg.timeRangeMinutes || 15,
        includeFilters: msg.includeFilters || [],
        excludeFilters: msg.excludeFilters || [],
        indexPattern: null,
        histogram: [],
        samples: [],
      };
      searchHistory.unshift(lastSearch);
      if (searchHistory.length > 8) searchHistory.length = 8;

      notifyBadges();
      findDashboardTab(msg);
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    ws = null;
    updateBadge();
    notifyBadges();
    console.log("%c[Kibana Log Bridge] %c❌ Disconnected. Retrying in 3s...", "color:#6366f1;font-weight:bold", "color:#ef4444");
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    console.log("%c[Kibana Log Bridge] %c⚠️  WebSocket error. Is the server running?", "color:#6366f1;font-weight:bold", "color:#ef4444");
  };
}

// Pick the environment a search should run against. No name → first configured.
function resolveEnvironment(name) {
  const envs = settings.environments || [];
  if (envs.length === 0) {
    return { error: "No environments configured. Click the Kibana Log Bridge extension icon and add your Kibana / OpenSearch Dashboards URL." };
  }
  if (!name) return { env: envs[0] };
  const env = envs.find(e => e.name.toLowerCase() === String(name).toLowerCase());
  if (!env) {
    return { error: `Unknown environment "${name}". Configured environments: ${envs.map(e => e.name).join(', ')}.` };
  }
  return { env };
}

// --- Find the dashboard tab for the requested environment and send search ---
function findDashboardTab(msg) {
  const { env, error } = resolveEnvironment(msg.environment);
  if (error) {
    lastSearch.status = "error";
    lastSearch.error = error;
    sendError(msg.requestId, error);
    return;
  }
  lastSearch.environment = env.name;
  lastSearch.indexPattern = env.indexPattern || "logs-*";

  chrome.tabs.query({ url: env.dashboardPattern }, (tabs) => {
    if (chrome.runtime.lastError) {
      sendError(msg.requestId, `Invalid dashboard URL pattern "${env.dashboardPattern}" for environment "${env.name}": ${chrome.runtime.lastError.message}`);
      return;
    }
    if (tabs.length > 0) {
      // Use only the first tab
      sendSearchToTab(tabs[0].id, msg, env, true);
      return;
    }

    console.log(`%c[Kibana Log Bridge] %c⚠️  No dashboard tab for "${env.name}", opening one...`, "color:#6366f1;font-weight:bold", "color:#f59e0b");
    openDashboardTab(msg, env);
  });
}

// Self-healing: no tab open for the environment → open one in the background,
// wait for it to load, and run the search there. If the dashboard bounces us
// to an SSO/login page (origin no longer matches), ask the user to log in.
function openDashboardTab(msg, env) {
  const dashboardUrl = env.dashboardPattern.replace(/\*$/, "");
  chrome.tabs.create({ url: dashboardUrl, active: false, pinned: true }, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      sendError(msg.requestId, `Could not open ${dashboardUrl}: ${chrome.runtime.lastError?.message || "unknown error"}`);
      return;
    }
    const tabId = tab.id;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError || !t) {
          sendError(msg.requestId, `The dashboard tab for "${env.name}" was closed before the search could run.`);
          return;
        }
        let sameOrigin = false;
        try {
          sameOrigin = new URL(t.url).origin === new URL(dashboardUrl).origin;
        } catch (e) { /* chrome://, about:blank, … */ }
        if (!sameOrigin) {
          chrome.tabs.update(tabId, { active: true });
          sendError(msg.requestId, `Opened ${dashboardUrl} but it redirected to a login page. Ask the user to log in to "${env.name}" in the tab that was just opened, then retry.`);
          return;
        }
        // Give the app a moment to finish booting, then search (retry injects scripts)
        setTimeout(() => sendSearchToTab(tabId, msg, env, true), 1000);
      });
    };

    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(finish, 15000);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sendSearchToTab(tabId, msg, env, allowRetry) {
  chrome.tabs.sendMessage(tabId, {
    type: "EXECUTE_SEARCH",
    requestId: msg.requestId,
    query: msg.query,
    timeRangeMinutes: msg.timeRangeMinutes,
    timeFrom: msg.timeFrom,
    timeTo: msg.timeTo,
    size: msg.size,
    searchType: msg.searchType,
    timestampMatch: msg.timestampMatch,
    excludeFilters: msg.excludeFilters,
    includeFilters: msg.includeFilters,
    aggregateFields: msg.aggregateFields,
    topN: msg.topN,
    mode: msg.mode,
    queryDsl: msg.queryDsl,
    queryFields: msg.queryFields,
    stratifyField: msg.stratifyField,
    indexPattern: env.indexPattern || "logs-*",
  }, () => {
    if (chrome.runtime.lastError && allowRetry) {
      console.log("%c[Kibana Log Bridge] %c⚠️  Content script not ready, injecting...", "color:#6366f1;font-weight:bold", "color:#f59e0b");
      injectAndRetry(tabId, msg, env);
    } else if (chrome.runtime.lastError) {
      sendError(msg.requestId, `Content script not responding: ${chrome.runtime.lastError.message}`);
    }
  });
}

function injectAndRetry(tabId, msg, env) {
  chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  }, () => {
    if (chrome.runtime.lastError) {
      sendError(msg.requestId, `Failed to inject content script: ${chrome.runtime.lastError.message}. Did you grant access to this site in the extension popup?`);
      return;
    }
    chrome.scripting.executeScript({
      target: { tabId },
      files: ["inject.js"],
      world: "MAIN"
    }, () => {
      if (chrome.runtime.lastError) {
        sendError(msg.requestId, `Failed to inject page script: ${chrome.runtime.lastError.message}`);
        return;
      }
      // Wait for scripts to initialize, then retry (no further retries)
      setTimeout(() => {
        console.log("%c[Kibana Log Bridge] %c🔄 Retrying search after injection", "color:#6366f1;font-weight:bold", "color:#f59e0b");
        sendSearchToTab(tabId, msg, env, false);
      }, 500);
    });
  });
}

function sendError(requestId, error) {
  if (lastSearch?.requestId === requestId) {
    lastSearch.status = "error";
    lastSearch.error = error;
    notifyBadges();
  }
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "SEARCH_RESULT", requestId, error }));
  }
}

// --- One-click "Add this dashboard" ---
// The popup may be closed by Chrome's permission prompt, so the whole add
// runs here: the popup registers a pending add, and permissions.onAdded (or
// an explicit ADD_SITE when the popup survived) completes it.
let pendingAdd = null;

// Runs in the page (MAIN world): index patterns + a human-readable name.
function discoverSite() {
  const base = location.pathname.includes("/app/") ? location.pathname.split("/app/")[0] : "";
  const generic = /^(home|discover|dashboards?|visualize|opensearch dashboards|kibana|elastic|menu|logs)$/i;
  const clean = (t) => (t || "")
    .replace(/\s*-\s*(OpenSearch Dashboards|Kibana|Elastic|SAP Cloud Logging)\s*$/i, "")
    .replace(/\s+logo$/i, "")
    .trim();
  const generic2 = /^(cloud logging|sap cloud logging)$/i;
  const logo = document.querySelector('img[data-test-subj="customLogo"]');
  const isDashboard = !!document.querySelector(
    'osd-injected-metadata, kbn-injected-metadata, meta[name="osd-injected-metadata"], meta[name="kbn-injected-metadata"], [data-test-subj="kibanaChrome"]'
  );
  if (!isDashboard) return { isDashboard: false };

  return (async () => {
    // Custom logos (e.g. SAP Cloud Logging) embed the instance name as SVG <text>
    let logoTexts = [];
    try {
      const src = logo?.getAttribute("data-test-image-url") || logo?.getAttribute("src");
      if (src) {
        const svg = await (await fetch(src)).text();
        logoTexts = [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
          .map(m => m[1].replace(/<[^>]+>/g, "").trim())
          .filter(t => t && !generic2.test(t));
      }
    } catch (e) { /* not an svg or not reachable */ }

    const candidates = [
      logoTexts[logoTexts.length - 1],
      logo?.getAttribute("alt"),
      document.querySelector('[data-test-subj="breadcrumb first"]')?.textContent,
      document.title,
    ].map(clean).filter(t => t && t.length <= 40 && !generic.test(t));
    const name = candidates[0] || null;

    let defaultId = null;
    for (const path of ["/api/opensearch-dashboards/settings", "/api/kibana/settings"]) {
      try {
        const r = await fetch(base + path);
        if (!r.ok) continue;
        defaultId = (await r.json()).settings?.defaultIndex?.userValue || null;
        if (defaultId) break;
      } catch (e) { /* try next */ }
    }
    let all = [], defaultTitle = null;
    try {
      const r = await fetch(`${base}/api/saved_objects/_find?type=index-pattern&per_page=100`);
      if (r.ok) {
        const objs = (await r.json()).saved_objects || [];
        all = objs.map(o => o.attributes?.title).filter(Boolean);
        defaultTitle = objs.find(o => o.id === defaultId)?.attributes?.title || null;
      }
    } catch (e) { /* fall back */ }
    return { isDashboard: true, name, all, defaultTitle };
  })();
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function uniqueEnvName(base, environments) {
  const taken = new Set(environments.map(e => e.name.toLowerCase()));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

let addQueue = Promise.resolve();
function addSite(req) {
  const run = addQueue.then(() => addSiteNow(req));
  addQueue = run.catch(() => {});
  return run;
}

async function addSiteNow({ tabId, origin }) {
  await settingsLoaded;
  const pattern = `${origin}/*`;
  const environments = (settings.environments || []).map(({ name, dashboardPattern, indexPattern }) => ({ name, dashboardPattern, indexPattern }));
  const existing = environments.find(e => e.dashboardPattern === pattern);
  if (existing) return { name: existing.name, indexPattern: existing.indexPattern };

  let discovered = null;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: discoverSite });
    discovered = res?.result || null;
  } catch (e) { /* page not scriptable, so use fallbacks */ }
  if (discovered?.isDashboard === false) throw new Error("This page isn't a Kibana / OpenSearch Dashboards page");

  const indexPattern = discovered?.defaultTitle || discovered?.all?.[0] || "logs-*";
  const base = slugify(discovered?.name || "") || new URL(origin).hostname.split(".")[0] || "default";
  const name = uniqueEnvName(base, environments);
  environments.push({ name, dashboardPattern: pattern, indexPattern });
  await chrome.storage.sync.set({ environments });
  console.log(`%c[Kibana Log Bridge] %c➕ Added environment "${name}" (${indexPattern})`, "color:#6366f1;font-weight:bold", "color:#22c55e");
  return { name, indexPattern };
}

chrome.permissions.onAdded.addListener((perm) => {
  const pending = pendingAdd;
  if (!pending || !(perm.origins || []).includes(`${pending.origin}/*`)) return;
  pendingAdd = null;
  addSite(pending).catch(e => console.log("[Kibana Log Bridge] add failed:", e.message));
});

// Listen for results from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Popup asking for status
  if (message.type === "GET_STATUS" && message.light) {
    settingsLoaded.then(() => sendResponse(lightStatus()));
    return true;
  }
  if (message.type === "GET_STATUS") {
    settingsLoaded.then(async () => {
      const environments = await Promise.all((settings.environments || []).map(async (env) => {
        let tabCount = 0;
        let logoName = null, logoUrl = null;
        try {
          const tabs = await chrome.tabs.query({ url: env.dashboardPattern });
          tabCount = tabs.length;
          if (tabs.length > 0) {
            const [res] = await chrome.scripting.executeScript({
              target: { tabId: tabs[0].id },
              func: () => {
                const img = document.querySelector('img[data-test-subj="customLogo"]');
                if (!img) return null;
                return {
                  name: (img.getAttribute('alt') || '').replace(/\s*logo$/i, '').trim() || null,
                  url: img.getAttribute('data-test-image-url') || img.getAttribute('src') || null
                };
              }
            });
            logoName = res?.result?.name ?? null;
            logoUrl = res?.result?.url ?? null;
          }
        } catch (e) {
          // invalid pattern or tab not scriptable: ignore
        }
        return { ...env, tabCount, logoName, logoUrl };
      }));
      sendResponse({
        wsConnected,
        environments,
        wsPort: settings.wsPort,
        lastSearch,
      });
    });
    return true;
  }

  if (message.type === "PEEK_SITE") {
    chrome.scripting.executeScript({ target: { tabId: message.tabId }, world: "MAIN", func: discoverSite })
      .then(([res]) => sendResponse(res?.result || null), () => sendResponse(null));
    return true;
  }
  if (message.type === "PREPARE_ADD_SITE") {
    pendingAdd = { tabId: message.tabId, origin: message.origin };
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "CANCEL_ADD_SITE") {
    if (pendingAdd?.origin === message.origin) pendingAdd = null;
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "ADD_SITE") {
    if (pendingAdd?.origin === message.origin) pendingAdd = null;
    addSite(message).then(sendResponse, e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.type === "SEARCH_RESULT" && ws?.readyState === WebSocket.OPEN) {
    if (message.error) {
      console.log(`%c[Kibana Log Bridge] %c⚠️  Search error (${message.requestId}): ${message.error}`, "color:#6366f1;font-weight:bold", "color:#ef4444");
      // Session expired → surface the tab so the user can just log in
      if (/HTTP Error: 40[13]/.test(message.error) && sender.tab?.id) {
        chrome.tabs.update(sender.tab.id, { active: true });
        message.error += ": the dashboard session has expired. The tab has been focused; ask the user to log in there, then retry.";
      }
      if (lastSearch?.requestId === message.requestId) {
        lastSearch.status = "error";
        lastSearch.error = message.error;
      }
    } else {
      const raw = message.data?.rawResponse || message.data;
      const total = raw?.hits?.total;
      const count = typeof total === 'object' ? total.value : total;
      console.log(`%c[Kibana Log Bridge] %c📨 Result (${message.requestId}): ${count ?? '?'} hits`, "color:#6366f1;font-weight:bold", "color:#22c55e");
      if (lastSearch?.requestId === message.requestId) {
        lastSearch.status = "done";
        lastSearch.hits = count ?? 0;
        lastSearch.histogram = (raw?.aggregations?.["2"]?.buckets || []).map(b => ({ key: b.key, count: b.doc_count }));
        lastSearch.samples = (raw?.hits?.hits || []).slice(0, 10).map(summarizeHit);
      }
    }
    ws.send(JSON.stringify({
      type: "SEARCH_RESULT",
      requestId: message.requestId,
      data: message.data,
      error: message.error
    }));
    notifyBadges();
  }
});

updateBadge();
connect();
syncBadgeScripts();
