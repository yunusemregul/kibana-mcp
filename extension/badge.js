// badge.js: Runs in ISOLATED world on configured dashboards.
// Shows a small status pill in the dashboard header so you can see at a
// glance whether this tab is reachable by the AI.
if (!window.__kibanaLogBridgeBadgeLoaded) {
  window.__kibanaLogBridgeBadgeLoaded = true;

  const STYLE = `
    .klb-badge {
      display: inline-flex; align-items: center; gap: 6px;
      align-self: center; height: 22px; box-sizing: border-box;
      margin-left: 12px; padding: 0 10px; border-radius: 999px;
      font: 600 11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #e2e8f0; background: #1e293b; border: 1px solid #334155;
      white-space: nowrap; cursor: default; position: relative;
    }
    .klb-badge.fixed { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; margin: 0; }
    .klb-badge .klb-dot { width: 7px; height: 7px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 5px #ef444488; }
    .klb-badge.ok .klb-dot { background: #22c55e; box-shadow: 0 0 5px #22c55e88; }
    .klb-badge .klb-state { color: #94a3b8; font-weight: 500; }
    .klb-badge.ok .klb-state { color: #22c55e; }
    .klb-badge.busy .klb-state { color: #f59e0b; }
    .klb-badge.busy .klb-dot { background: #f59e0b; box-shadow: 0 0 5px #f59e0b88; animation: klb-pulse 1s ease-in-out infinite; }
    .klb-badge.err .klb-state { color: #ef4444; }
    .klb-badge { max-width: 480px; }
    .klb-badge .klb-state { overflow: hidden; text-overflow: ellipsis; }
    @keyframes klb-pulse { 50% { opacity: 0.3; } }

    /* Hover panel, styled after EUI popovers (light, bordered, subtle shadow) */
    .klb-pop {
      position: fixed; z-index: 2147483647; width: 1100px; max-width: calc(100vw - 24px); max-height: calc(100vh - 80px); overflow-y: auto;
      background: #fff; color: #343741; border: 1px solid #d3dae6; border-radius: 6px;
      box-shadow: 0 6px 12px -1px rgba(152,162,179,.2), 0 4px 4px -1px rgba(152,162,179,.2), 0 2px 2px 0 rgba(152,162,179,.2);
      font: 400 13px/1.5 "Inter UI", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      white-space: normal; display: none; pointer-events: auto;
    }
    .klb-pop.open { display: block; }
    .klb-pop::before {
      content: ""; position: absolute; top: -7px; left: 24px; width: 12px; height: 12px;
      background: #fff; border-left: 1px solid #d3dae6; border-top: 1px solid #d3dae6; transform: rotate(45deg);
    }
    .klb-pop-head { padding: 14px 18px; border-bottom: 1px solid #d3dae6; display: flex; align-items: center; gap: 8px; }
    .klb-pop-head .klb-title { font-weight: 600; font-size: 14px; color: #1a1c21; }
    .klb-pop-head .klb-when { margin-left: auto; color: #69707d; font-size: 12px; }
    .klb-pop-body { padding: 14px 18px; }
    .klb-bar, .klb-filterbar { user-select: none; -webkit-user-select: none; cursor: default; }
    .klb-bar { display: flex; gap: 8px; align-items: stretch; }
    .klb-search, .klb-time {
      display: flex; align-items: center; gap: 8px; height: 44px; box-sizing: border-box;
      background: #fbfcfd; border: 1px solid #d3dae6; border-radius: 6px; padding: 0 10px;
      box-shadow: inset 0 1px 1px rgba(0,0,0,.04);
    }
    .klb-search { flex: 1 1 auto; min-width: 0; }
    .klb-time { flex: 0 1 auto; color: #343741; font-size: 13px; white-space: nowrap; }
    .klb-ico { display: inline-flex; color: #017d73; }
    .klb-ico-muted { color: #69707d; }
    .klb-search-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; color: #343741; }
    .klb-placeholder { color: #69707d; }
    .klb-lang { color: #017d73; font-size: 13px; font-weight: 500; padding-left: 8px; border-left: 1px solid #d3dae6; }
    .klb-arrow { color: #69707d; margin: 0 4px; }
    .klb-filterbar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 10px 2px 2px; }
    .klb-addfilter { display: inline-flex; align-items: center; gap: 4px; color: #017d73; font-size: 13px; }
    .klb-index { margin-left: auto; color: #69707d; font-size: 12px; font-family: "Roboto Mono", Menlo, monospace; }
    .klb-pill {
      display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 4px; font-size: 12px;
      background: #fff; color: #343741; border: 1px solid #d3dae6; box-shadow: 0 1px 2px rgba(0,0,0,.05);
    }
    .klb-pill b { font-weight: 600; margin-right: 3px; }
    .klb-pill.neg { border-color: #bd271e; color: #bd271e; }
    .klb-pill.klb-dsl { font-family: "Roboto Mono", Menlo, monospace; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .klb-count { text-align: center; font-size: 16px; color: #343741; margin-top: 10px; }
    .klb-count b { font-weight: 700; }
    .klb-spin { display: inline-block; width: 10px; height: 10px; border: 2px solid #d3dae6; border-top-color: #017d73; border-radius: 50%; vertical-align: middle; animation: klb-rot .8s linear infinite; }
    @keyframes klb-rot { to { transform: rotate(360deg); } }
    .klb-error { margin-top: 8px; padding: 8px 10px; background: #f8e9e9; color: #bd271e; border-radius: 4px; font-size: 12px; }
    .klb-hist { display: flex; align-items: flex-end; gap: 2px; height: 110px; margin: 6px 0 2px; border-bottom: 1px solid #d3dae6; padding-bottom: 2px; }
    .klb-hist span { flex: 1; background: #54b399; min-height: 1px; border-radius: 1px 1px 0 0; }
    .klb-hist-axis { display: flex; justify-content: space-between; color: #69707d; font-size: 10px; margin-bottom: 8px; }
    .klb-samples { border-top: 1px solid #d3dae6; margin-top: 6px; }
    .klb-sample { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid #eef2f7; font-family: "Roboto Mono", Menlo, monospace; font-size: 12px; }
    .klb-sample .klb-ts { flex: 0 0 96px; color: #69707d; }
    .klb-sample .klb-lv { flex: 0 0 44px; font-weight: 600; }
    .klb-sample .klb-lv.ERROR, .klb-sample .klb-lv.FATAL { color: #bd271e; }
    .klb-sample .klb-lv.WARN, .klb-sample .klb-lv.WARNING { color: #b17f00; }
    .klb-sample .klb-tx { flex: 1; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; color: #343741; }
    .klb-hist-list { border-top: 1px solid #d3dae6; margin-top: 10px; padding-top: 8px; }
    .klb-section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #69707d; margin-bottom: 4px; }
    .klb-hist-item { display: flex; gap: 8px; font-size: 12px; color: #69707d; padding: 2px 0; }
    .klb-hist-item .klb-hq { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: Menlo, monospace; color: #343741; }
    .klb-empty { color: #69707d; font-style: italic; }
  `;

  const ICON_SEARCH = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l4 4" stroke-linecap="round"/></svg>`;
  const ICON_CAL = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="12" rx="1.5"/><path d="M1.5 6h13M5 1v3M11 1v3"/></svg>`;
  const ICON_FILTER = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 2.5h13l-5 6v5l-3-1.5v-3.5z" stroke-linejoin="round"/></svg>`;
  const ICON_PLUS = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.5"/><path d="M8 5v6M5 8h6" stroke-linecap="round"/></svg>`;

  let badge = null;
  let pop = null;
  let lastStatus = null;
  let hideTimer = null;

  const msg = (key, ...subs) => {
    try { return chrome.i18n.getMessage(key, subs.map(String)) || key; } catch (e) { return key; }
  };
  const hitsText = (n, bold) => {
    const num = Number(n).toLocaleString();
    return msg(Number(n) === 1 ? "hitsOne" : "hitsMany", bold ? `<b>${num}</b>` : num);
  };
  const lastMinutes = (m) => Number(m) === 1 ? msg("lastMinutesOne") : msg("lastMinutesMany", m);

  function doneKey(s) {
    if (s?.tool === "inspect_log") return "aiDidInspect";
    if (s?.tool === "get_log_context") return "aiDidContext";
    if (s?.mode === "summarize") return "aiDidSummarize";
    if (s?.mode === "fields") return "aiDidFields";
    return "aiDidSearch";
  }

  function busyKey(s) {
    if (s?.tool === "inspect_log") return "aiBusyInspect";
    if (s?.tool === "get_log_context") return "aiBusyContext";
    if (s?.mode === "summarize") return "aiBusySummarize";
    return "aiBusySearch";
  }

  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleTimeString(); };
  const fmtRange = (s) => s.timeFrom && s.timeTo
    ? `${new Date(s.timeFrom).toLocaleString()} → ${new Date(s.timeTo).toLocaleString()}`
    : lastMinutes(s.timeRangeMinutes);

  function ensurePop() {
    if (pop && pop.isConnected) return pop;
    pop = document.createElement("div");
    pop.className = "klb-pop";
    pop.lang = msg("@@ui_locale").replace("_", "-");
    pop.addEventListener("mouseenter", () => { hovering = true; clearTimeout(hideTimer); clearTimeout(autoTimer); });
    pop.addEventListener("mouseleave", () => { hovering = false; scheduleHide(); });
    document.body.appendChild(pop);
    return pop;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!badge?.classList.contains("busy") && !autoTimer) pop?.classList.remove("open"); }, 150);
  }

  function showPop() {
    clearTimeout(hideTimer);
    const el = ensurePop();
    renderPop();
    const r = badge.getBoundingClientRect();
    el.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - 1112))}px`;
    el.style.top = `${r.bottom + 10}px`;
    el.classList.add("open");
  }

  function renderPop() {
    if (!pop || !lastStatus) return;
    const env = (lastStatus.environments || []).find(e => e.dashboardPattern === `${location.origin}/*`);
    const mine = (s) => s && (!s.environment || s.environment.toLowerCase() === env?.name.toLowerCase());
    const history = (lastStatus.searchHistory || []).filter(mine);
    const s = history[0];
    if (!s) {
      pop.innerHTML = `<div class="klb-pop-head"><span class="klb-title">${esc(msg("extName"))}</span></div>
        <div class="klb-pop-body"><span class="klb-empty">${esc(msg("popNoSearches"))}</span></div>`;
      return;
    }
    const state = s.status === "searching" ? `<span class="klb-spin"></span> ${esc(msg("searching"))}` : s.status === "error" ? esc(msg("popSearchFailed")) : hitsText(s.hits, true);
    const filters = [
      ...(s.timestampMatch ? [`<span class="klb-pill"><b>@timestamp:</b> ${esc(s.timestampMatch)}</span>`] : []),
      ...(s.queryDsl ? [`<span class="klb-pill klb-dsl" title="${esc(JSON.stringify(s.queryDsl, null, 2))}"><b>query DSL:</b> ${esc(JSON.stringify(s.queryDsl).slice(0, 80))}</span>`] : []),
      ...(s.includeFilters || []).map(f => `<span class="klb-pill"><b>${esc(f.field)}:</b> ${esc(f.value)}</span>`),
      ...(s.excludeFilters || []).map(f => `<span class="klb-pill neg"><b>NOT ${esc(f.field)}:</b> ${esc(f.value)}</span>`),
    ].join("");
    const max = Math.max(1, ...(s.histogram || []).map(b => b.count));
    const hist = (s.histogram || []).length >= 3
      ? `<div class="klb-hist">${s.histogram.map(b => `<span style="height:${Math.max(2, Math.round(b.count / max * 108))}px" title="${fmtTime(b.key)}: ${b.count}"></span>`).join("")}</div>
         <div class="klb-hist-axis"><span>${fmtTime(s.histogram[0].key)}</span><span>${fmtTime(s.histogram[s.histogram.length - 1].key)}</span></div>`
      : "";
    const samples = (s.samples || []).length
      ? `<div class="klb-samples">${s.samples.map(h => `<div class="klb-sample"><span class="klb-ts">${h.ts ? fmtTime(h.ts) : ""}</span><span class="klb-lv ${esc(h.level || "")}">${esc(h.level || "")}</span><span class="klb-tx" title="${esc(h.text)}">${esc(h.text)}</span></div>`).join("")}</div>`
      : "";
    const older = history.slice(1, 5);
    const histList = older.length
      ? `<div class="klb-hist-list"><div class="klb-section-title">${esc(msg("popPrevious"))}</div>${older.map(h => `<div class="klb-hist-item"><span>${esc(h.time)}</span><span class="klb-hq">${esc(h.query || msg("popAll"))}</span><span>${esc(h.status === "done" ? hitsText(h.hits) : h.status === "searching" ? msg("historySearching") : h.status === "error" ? msg("historyError") : h.status)}</span></div>`).join("")}</div>`
      : "";
    const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
    const fmtAbs = (iso, dateOnlyIfNeeded) => {
      const d = new Date(iso);
      if (isNaN(d)) return String(iso);
      const t = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      return dateOnlyIfNeeded ? t : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${t}`;
    };
    const timeText = s.timeFrom && s.timeTo
      ? `<span>${esc(fmtAbs(s.timeFrom))}</span><span class="klb-arrow">→</span><span>${esc(fmtAbs(s.timeTo, sameDay(s.timeFrom, s.timeTo)))}</span>`
      : `<span>${esc(lastMinutes(s.timeRangeMinutes))}</span>`;
    pop.innerHTML = `
      <div class="klb-pop-head"><span class="klb-title">${esc(msg(doneKey(s), s.query ? `"${s.query}"` : msg("allLogs")))}</span><span class="klb-when">${esc(s.time)}</span></div>
      <div class="klb-pop-body">
        <div class="klb-bar">
          <div class="klb-search">
            <span class="klb-ico">${ICON_SEARCH}</span>
            <span class="klb-search-text">${esc(s.query || "*")}</span>
            <span class="klb-lang">Lucene</span>
          </div>
          <div class="klb-time">
            <span class="klb-ico">${ICON_CAL}</span>
            ${timeText}
          </div>
        </div>
        <div class="klb-filterbar">
          <span class="klb-ico klb-ico-muted">${ICON_FILTER}</span>
          ${filters || `<span class="klb-addfilter">${ICON_PLUS} ${esc(msg("popAddFilter"))}</span>`}
          ${s.indexPattern ? `<span class="klb-index">${esc(s.indexPattern)}</span>` : ""}
        </div>
        ${s.status === "error" ? `<div class="klb-error">${esc(s.error)}</div>` : ""}
        <div class="klb-count">${state}</div>
        ${hist}${samples}${histList}
      </div>`;
  }

  function headerSlot() {
    return document.querySelector('[data-test-subj="logo"]')?.closest(".euiHeaderSectionItem") || null;
  }

  function ensureBadge() {
    if (badge && badge.isConnected) {
      // The header mounts after page load, so move out of the corner once it exists
      const slot = badge.classList.contains("fixed") && headerSlot();
      if (slot) { badge.classList.remove("fixed"); slot.insertAdjacentElement("afterend", badge); }
      return badge;
    }
    if (!document.getElementById("klb-style")) {
      const style = document.createElement("style");
      style.id = "klb-style";
      style.textContent = STYLE;
      document.documentElement.appendChild(style);
    }
    badge = document.createElement("span");
    badge.className = "klb-badge";
    badge.innerHTML = `<span class="klb-dot"></span><span class="klb-state"></span>`;
    badge.addEventListener("mouseenter", () => { hovering = true; showPop(); });
    badge.addEventListener("mouseleave", () => { hovering = false; scheduleHide(); });
    const logoItem = headerSlot();
    if (logoItem) {
      logoItem.insertAdjacentElement("afterend", badge);
    } else {
      badge.classList.add("fixed");
      document.body.appendChild(badge);
    }
    return badge;
  }

  // Auto-open the panel while the AI is searching; keep it up 5s after the
  // result lands (longer if the mouse is over it).
  let hovering = false;
  let autoTimer = null;
  function autoShow(searching) {
    clearTimeout(autoTimer); autoTimer = null;
    if (searching) { showPop(); return; }
    autoTimer = setTimeout(() => { autoTimer = null; if (!hovering && !badge?.classList.contains("busy")) pop?.classList.remove("open"); }, 5000);
  }

  function render(status) {
    if (!status) return;
    lastStatus = status;
    if (pop?.classList.contains("open")) renderPop();
    const env = (status.environments || []).find(e => e.dashboardPattern === `${location.origin}/*`);
    if (!env) return;
    const el = ensureBadge();
    el.classList.toggle("ok", !!status.wsConnected);
    const stateEl = el.querySelector(".klb-state");
    const s = status.lastSearch;
    const mine = s && (!s.environment || s.environment.toLowerCase() === env.name.toLowerCase());
    const q = s?.query ? `"${s.query.length > 40 ? s.query.slice(0, 40) + "…" : s.query}"` : msg("allLogs");
    const busy = !!(mine && s.status === "searching");
    const wasBusy = el.classList.contains("busy");
    el.classList.toggle("busy", busy);
    if (busy && !wasBusy) autoShow(true);
    else if (!busy && wasBusy) autoShow(false);
    el.classList.toggle("err", !!(mine && s.status === "error"));
    if (!status.wsConnected) {
      stateEl.textContent = msg("badgeNoServer");
      el.dataset.title = msg("badgeNoServerTitle");
    } else if (mine && s.status === "searching") {
      stateEl.textContent = msg(busyKey(s), q);
      el.dataset.title = msg("badgeSearchingTitle", q, s.time);
    } else if (mine && s.status === "done") {
      stateEl.textContent = `${msg(doneKey(s), q)} · ${hitsText(s.hits)}`;
      el.dataset.title = msg("badgeDoneTitle", q, s.time, hitsText(s.hits));
    } else if (mine && s.status === "error") {
      stateEl.textContent = msg("badgeFailed", q);
      el.dataset.title = msg("badgeFailedTitle", q, s.time, s.error);
    } else {
      stateEl.textContent = msg("badgeConnected");
      el.dataset.title = msg("badgeConnectedTitle", env.name);
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "BADGE_STATUS") render(message.status);
  });

  function poll() {
    try {
      chrome.runtime.sendMessage({ type: "GET_STATUS", light: true }, (status) => {
        if (chrome.runtime.lastError) return;
        render(status);
      });
    } catch (e) { /* extension reloaded, so leave the badge as is */ }
  }

  poll();
  setInterval(poll, 3000);
}
