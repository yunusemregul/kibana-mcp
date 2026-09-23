// popup.js
let settingsHydrated = false;
let lastStatus = null;
let activeTab = null;

function envRow(env = {}) {
  const card = document.createElement("div");
  card.className = "env-card";
  card.innerHTML = `
    <div class="env-card-head">
      <span class="env-num"></span>
      <button class="remove-btn">remove</button>
    </div>
    <div class="field">
      <label>Name</label>
      <input type="text" class="env-name" placeholder="prod" spellcheck="false">
    </div>
    <div class="field">
      <label>Dashboard URL</label>
      <input type="text" class="env-url" placeholder="https://logs.example.com" spellcheck="false">
    </div>
    <div class="field">
      <label>Index pattern</label>
      <input type="text" class="env-index" placeholder="logs-*" spellcheck="false">
    </div>
  `;
  card.querySelector(".env-name").value = env.name || "";
  card.querySelector(".env-url").value = (env.dashboardPattern || "").replace(/\/\*$/, "");
  card.querySelector(".env-index").value = env.indexPattern || "";
  card.querySelector(".remove-btn").addEventListener("click", () => {
    card.remove();
    renumberEnvCards();
  });
  return card;
}

function renumberEnvCards() {
  document.querySelectorAll("#env-list .env-card .env-num").forEach((el, i) => {
    el.textContent = `Environment ${i + 1}${i === 0 ? " (default)" : ""}`;
  });
}

function addEnvCard(env) {
  document.getElementById("env-list").appendChild(envRow(env));
  renumberEnvCards();
}

function rehydrateSettings(environments, wsPort) {
  document.getElementById("env-list").innerHTML = "";
  for (const env of environments || []) addEnvCard(env);
  document.getElementById("ws-port").value = wsPort || 47821;
}

function render(status) {
  if (!status) return;
  lastStatus = status;

  // Active tab logo (from customLogo) shown under the title
  const activeTabName = document.getElementById("active-tab-name");
  const envWithLogo = status.environments?.find(e => e.logoUrl || e.logoName);
  if (envWithLogo?.logoUrl) {
    activeTabName.innerHTML = "";
    const img = document.createElement("img");
    img.src = envWithLogo.logoUrl;
    img.alt = envWithLogo.logoName || "";
    img.className = "logo-img";
    activeTabName.appendChild(img);
  } else {
    activeTabName.textContent = envWithLogo?.logoName || "";
  }

  // WebSocket status + actionable hint when the server is down
  const wsDot = document.getElementById("ws-dot");
  const wsStatus = document.getElementById("ws-status");
  wsDot.classList.remove("green", "red");
  wsStatus.classList.remove("ok", "err");
  if (status.wsConnected) {
    wsDot.classList.add("green");
    wsStatus.textContent = "Connected";
    wsStatus.classList.add("ok");
  } else {
    wsDot.classList.add("red");
    wsStatus.textContent = "Not running";
    wsStatus.classList.add("err");
  }
  document.getElementById("ws-hint").hidden = status.wsConnected;

  // Per-environment tab status with an Open button when no tab is up
  const envRows = document.getElementById("env-status-rows");
  envRows.innerHTML = "";
  if (!status.environments || status.environments.length === 0) {
    envRows.innerHTML = `
      <div class="status-row">
        <span class="dot red"></span>
        <span class="status-label">Environments</span>
        <span class="status-value err">None yet</span>
      </div>
    `;
  } else {
    for (const env of status.environments) {
      const row = document.createElement("div");
      row.className = "status-row";
      const ok = env.tabCount > 0;
      const dot = document.createElement("span");
      dot.className = `dot ${ok ? "green" : "red"}`;
      const label = document.createElement("span");
      label.className = "status-label";
      label.textContent = env.name;
      row.appendChild(dot);
      row.appendChild(label);
      const btn = document.createElement("button");
      btn.className = `open-btn ${ok ? "ok" : ""}`;
      btn.textContent = ok ? `${env.tabCount} tab${env.tabCount > 1 ? "s" : ""} · Go` : "Open";
      btn.title = ok ? "Switch to the dashboard tab" : "Open the dashboard in a new tab";
      btn.addEventListener("click", () => openEnvironment(env));
      row.appendChild(btn);
      const del = document.createElement("button");
      del.className = "trash-btn";
      del.title = `Remove "${env.name}"`;
      const armed = confirmRemove === env.dashboardPattern;
      del.textContent = armed ? "delete?" : "✕";
      del.classList.toggle("armed", armed);
      del.addEventListener("click", () => {
        if (confirmRemove === env.dashboardPattern) {
          confirmRemove = null;
          removeEnvironment(env);
        } else {
          confirmRemove = env.dashboardPattern;
          render(lastStatus);
        }
      });
      row.appendChild(del);
      envRows.appendChild(row);
    }
  }

  updateAddSiteButton();

  // Hydrate settings inputs once (don't clobber while the user types)
  if (!settingsHydrated) {
    settingsHydrated = true;
    rehydrateSettings(status.environments, status.wsPort);
    // First run: nothing configured yet → open settings so the user sees how
    if (!status.environments || status.environments.length === 0) {
      document.getElementById("settings-section").hidden = false;
    }
  }

  // Last search
  if (status.lastSearch) {
    const s = status.lastSearch;
    const container = document.getElementById("last-search-container");

    let resultHtml = "";
    if (s.status === "searching") {
      resultHtml = `<span class="status-value warn">Searching...</span>`;
    } else if (s.status === "error") {
      resultHtml = `<span class="status-value err">Error: ${s.error}</span>`;
    } else if (s.status === "done") {
      resultHtml = `<span class="status-value ok">${s.hits} hits</span>`;
    }

    container.innerHTML = `
      <div class="last-search">
        <div class="query">"${s.query}"</div>
        <div class="meta">${s.environment ? `${s.environment} · ` : ""}${s.time}</div>
        <div class="result">${resultHtml}</div>
      </div>
    `;
  }
}

async function openEnvironment(env) {
  const [tab] = await chrome.tabs.query({ url: env.dashboardPattern });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: env.dashboardPattern.replace(/\*$/, "") });
  }
}

let confirmRemove = null;

async function removeEnvironment(env) {
  const environments = (lastStatus?.environments || [])
    .filter(e => e.dashboardPattern !== env.dashboardPattern)
    .map(({ name, dashboardPattern, indexPattern }) => ({ name, dashboardPattern, indexPattern }));
  await chrome.storage.sync.set({ environments });
  chrome.permissions.remove({ origins: [env.dashboardPattern] }).catch(() => {});
  settingsHydrated = false;
  showSaveMsg(`Removed ${env.name}`, true);
  poll();
}

// --- One-click "Add this dashboard" from the active tab ---

function updateAddSiteButton() {
  const btn = document.getElementById("add-site-btn");
  const hint = document.getElementById("add-site-hint");
  if (!activeTab?.url || !/^https?:/.test(activeTab.url)) {
    btn.hidden = hint.hidden = true;
    return;
  }
  let origin;
  try {
    origin = new URL(activeTab.url).origin;
  } catch (e) {
    btn.hidden = hint.hidden = true;
    return;
  }
  const alreadyConfigured = (lastStatus?.environments || []).some(e => e.dashboardPattern === `${origin}/*`);
  // Wait for the page-name peek so the label doesn't flip from host to name
  btn.hidden = alreadyConfigured || peekedName === undefined || !peekedDashboard;
  hint.hidden = btn.hidden;
  if (!btn.hidden && !btn.dataset.busy) {
    btn.textContent = `➕ Add this dashboard (${peekedName || new URL(origin).hostname})`;
    btn.disabled = false;
  }
}

// activeTab lets us read the page name as soon as the popup opens, before
// the user has granted persistent access to the site.
// undefined = still peeking, null = no name found (fall back to hostname).
let peekedName = undefined;
let peekedDashboard = false;
function peekActiveSite() {
  if (!activeTab?.id) { peekedName = null; updateAddSiteButton(); return; }
  chrome.runtime.sendMessage({ type: "PEEK_SITE", tabId: activeTab.id }, (res) => {
    const ok = !chrome.runtime.lastError && res;
    peekedDashboard = !!(ok && res.isDashboard);
    peekedName = (ok && res.name) || null;
    updateAddSiteButton();
  });
}

async function addCurrentSite() {
  const btn = document.getElementById("add-site-btn");
  const origin = new URL(activeTab.url).origin;
  const pattern = `${origin}/*`;

  btn.dataset.busy = "1";
  btn.disabled = true;

  const already = await chrome.permissions.contains({ origins: [pattern] });
  if (!already) {
    // Chrome's permission prompt may close this popup, so the background
    // finishes the add on permissions.onAdded. We only kick it off here.
    await chrome.runtime.sendMessage({ type: "PREPARE_ADD_SITE", tabId: activeTab.id, origin });
    btn.textContent = "Allow site access in the Chrome prompt…";
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) {
      await chrome.runtime.sendMessage({ type: "CANCEL_ADD_SITE", origin });
      delete btn.dataset.busy;
      updateAddSiteButton();
      showSaveMsg("Site access denied", false);
      return;
    }
  }

  btn.textContent = "Detecting environment…";
  const res = await chrome.runtime.sendMessage({ type: "ADD_SITE", tabId: activeTab.id, origin });
  delete btn.dataset.busy;
  settingsHydrated = false;
  if (res?.error) {
    updateAddSiteButton();
    showSaveMsg(res.error, false);
    return;
  }
  showSaveMsg(`Added ${res.name} (${res.indexPattern})`, true);
  poll();
}

// --- Manual settings editor ---

function showSaveMsg(text, ok) {
  const el = document.getElementById("save-msg");
  el.textContent = text;
  el.classList.remove("ok", "err");
  el.classList.add(ok ? "ok" : "err");
}

async function saveSettings() {
  const wsPort = parseInt(document.getElementById("ws-port").value, 10) || 47821;

  const environments = [];
  const seenNames = new Set();
  for (const card of document.querySelectorAll("#env-list .env-card")) {
    const name = card.querySelector(".env-name").value.trim();
    const urlInput = card.querySelector(".env-url").value.trim();
    const indexPattern = card.querySelector(".env-index").value.trim() || "logs-*";
    if (!name && !urlInput) continue; // skip fully empty rows
    if (!name || !urlInput) {
      showSaveMsg("Each environment needs a name and URL", false);
      return;
    }
    if (seenNames.has(name.toLowerCase())) {
      showSaveMsg(`Duplicate environment name "${name}"`, false);
      return;
    }
    seenNames.add(name.toLowerCase());

    let origin;
    try {
      origin = new URL(urlInput.includes("://") ? urlInput : `https://${urlInput}`).origin;
    } catch (e) {
      showSaveMsg(`Invalid URL for "${name}"`, false);
      return;
    }
    environments.push({ name, dashboardPattern: `${origin}/*`, indexPattern });
  }

  if (environments.length > 0) {
    const granted = await chrome.permissions.request({
      origins: environments.map(e => e.dashboardPattern),
    });
    if (!granted) {
      showSaveMsg("Site access denied", false);
      return;
    }
  }

  await chrome.storage.sync.set({ environments, wsPort });
  showSaveMsg("Saved ✓", true);
}

document.getElementById("save-btn").addEventListener("click", () => {
  saveSettings().catch(e => showSaveMsg(e.message, false));
});
document.getElementById("add-env-btn").addEventListener("click", () => addEnvCard());
document.getElementById("add-site-btn").addEventListener("click", () => {
  addCurrentSite().catch(e => {
    delete document.getElementById("add-site-btn").dataset.busy;
    updateAddSiteButton();
    showSaveMsg(e.message, false);
  });
});
document.getElementById("gear-btn").addEventListener("click", () => {
  const section = document.getElementById("settings-section");
  section.hidden = !section.hidden;
});

function poll() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, render);
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  activeTab = tabs?.[0] || null;
  updateAddSiteButton();
  peekActiveSite();
});

poll();
const pollTimer = setInterval(poll, 1000);
window.addEventListener("unload", () => clearInterval(pollTimer));
