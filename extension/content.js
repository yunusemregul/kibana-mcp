// content.js — Runs in ISOLATED world
// Relays messages between background service worker and inject.js (MAIN world).
// Guard against duplicate injection
if (window.__kibanaLogBridgeContentLoaded) {
  console.log("%c[Kibana Log Bridge] %cContent script already loaded, skipping", "color:#6366f1;font-weight:bold", "color:#64748b");
} else {
  window.__kibanaLogBridgeContentLoaded = true;
  console.log("%c[Kibana Log Bridge] %cContent script loaded", "color:#6366f1;font-weight:bold", "color:#94a3b8");

  // Background -> Content -> Inject (via postMessage)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "EXECUTE_SEARCH") {
      console.log(`%c[Kibana Log Bridge] %c➡️  Relaying search to page context: "${message.query}"`, "color:#6366f1;font-weight:bold", "color:#f59e0b");
      window.postMessage({
        source: "kibana-log-bridge-content",
        type: "EXECUTE_SEARCH",
        requestId: message.requestId,
        query: message.query,
        timeRangeMinutes: message.timeRangeMinutes,
        timeFrom: message.timeFrom,
        timeTo: message.timeTo,
        size: message.size,
        searchType: message.searchType,
        timestampMatch: message.timestampMatch,
        excludeFilters: message.excludeFilters,
        includeFilters: message.includeFilters,
        aggregateFields: message.aggregateFields,
        topN: message.topN,
        mode: message.mode,
        queryDsl: message.queryDsl,
        queryFields: message.queryFields,
        stratifyField: message.stratifyField,
        indexPattern: message.indexPattern,
      }, "*");
      sendResponse({ ok: true });
    }
  });

  // Inject (via postMessage) -> Content -> Background
  window.addEventListener("message", (event) => {
    if (event.data?.source !== "kibana-log-bridge-inject") return;

    if (event.data.type === "SEARCH_RESULT") {
      chrome.runtime.sendMessage({
        type: "SEARCH_RESULT",
        requestId: event.data.requestId,
        data: event.data.data,
        error: event.data.error
      });
    }
  });
}
