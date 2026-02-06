const POLL_INTERVAL_MS = 5000;

const state = {
  sessions: [],
  filteredSessions: [],
  currentSession: null,
  currentFormat: "unknown",
  offset: 0,
  limit: 200,
  contains: "",
  order: "desc",
  history: [],
  latestResponse: null,
  pollId: null,
  isLoading: false,
  logs: [],
  filteredLogs: [],
  currentLog: null,
  artifacts: [],
  artifactRoot: "data",
  conversationLoading: false,
  runtime: null,
  tokenRequired: false,
  logViewerToken: localStorage.getItem("logViewerToken") || "",
  sessionMetaCache: new Map(),
  sessionStatsCache: new Map(),
  toolCalls: [],
  toolCallsSession: null,
  toolCallsLimit: 200,
  toolCallsContains: "",
  toolCallsLoading: false,
  toolCallsLive: false,
  toolCallsPollId: null,
  reasoning: [],
  reasoningSession: null,
  reasoningLimit: 200,
  reasoningContains: "",
  reasoningLoading: false,
  reasoningLive: false,
  reasoningPollId: null,
};

const els = {
  rootPath: document.getElementById("root-path"),
  runtimeMeta: document.getElementById("runtime-meta"),
  sessionsRoot: document.getElementById("sessions-root"),
  navLinks: document.querySelectorAll(".nav-link"),
  panels: document.querySelectorAll(".panel"),
  // Codex elements
  sessionList: document.getElementById("session-list"),
  sessionFilter: document.getElementById("session-filter"),
  refreshSessions: document.getElementById("refresh-sessions"),
  sessionName: document.getElementById("session-name"),
  sessionMeta: document.getElementById("session-meta"),
  toolCallsFilter: document.getElementById("toolcalls-filter"),
  toolCallsLimit: document.getElementById("toolcalls-limit"),
  toolCallsLive: document.getElementById("toolcalls-live"),
  toolCallsRefresh: document.getElementById("toolcalls-refresh"),
  toolCallsMeta: document.getElementById("toolcalls-meta"),
  toolCallsList: document.getElementById("toolcalls-list"),
  reasoningFilter: document.getElementById("reasoning-filter"),
  reasoningLimit: document.getElementById("reasoning-limit"),
  reasoningLive: document.getElementById("reasoning-live"),
  reasoningRefresh: document.getElementById("reasoning-refresh"),
  reasoningMeta: document.getElementById("reasoning-meta"),
  reasoningList: document.getElementById("reasoning-list"),
  containsInput: document.getElementById("contains-input"),
  limitSelect: document.getElementById("limit-select"),
  applyFilter: document.getElementById("apply-filter"),
  prevPage: document.getElementById("prev-page"),
  nextPage: document.getElementById("next-page"),
  lastPage: document.getElementById("last-page"),
  liveMode: document.getElementById("live-mode"),
  pageMeta: document.getElementById("page-meta"),
  eventList: document.getElementById("event-list"),
  // Log panel
  logList: document.getElementById("log-list"),
  logFilter: document.getElementById("log-filter"),
  logName: document.getElementById("log-name"),
  logLines: document.getElementById("log-lines"),
  logRefresh: document.getElementById("log-refresh"),
  logContent: document.getElementById("log-content"),
  killSwitch: document.getElementById("kill-switch"),
  // Artifacts
  artifactRoot: document.getElementById("artifact-root"),
  artifactRefresh: document.getElementById("artifact-refresh"),
  artifactTable: document.getElementById("artifact-table"),
  conversationList: document.getElementById("conversation-list"),
  conversationSave: document.getElementById("conversation-save"),
  conversationDownload: document.getElementById("conversation-download"),
};

init();

function init() {
  initNav();
  loadStatus();
  loadSessions();

  els.refreshSessions.addEventListener("click", () => loadSessions());
  els.sessionsRoot.addEventListener("click", setSessionsRoot);
  els.killSwitch.addEventListener("click", handleKillSwitch);
  els.sessionFilter.addEventListener("input", handleSessionFilter);
  els.applyFilter.addEventListener("click", applyFilters);
  els.toolCallsLive.addEventListener("click", toggleToolCallsLive);
  els.toolCallsRefresh.addEventListener("click", () => loadToolCalls({ force: true }));
  els.toolCallsFilter.addEventListener("input", () => {
    state.toolCallsContains = els.toolCallsFilter.value.trim();
  });
  els.toolCallsLimit.addEventListener("change", () => {
    state.toolCallsLimit = Number(els.toolCallsLimit.value) || 200;
    loadToolCalls({ force: true });
  });
  els.reasoningLive.addEventListener("click", toggleReasoningLive);
  els.reasoningRefresh.addEventListener("click", () => loadReasoning({ force: true }));
  els.reasoningFilter.addEventListener("input", () => {
    state.reasoningContains = els.reasoningFilter.value.trim();
  });
  els.reasoningLimit.addEventListener("change", () => {
    state.reasoningLimit = Number(els.reasoningLimit.value) || 200;
    loadReasoning({ force: true });
  });
  els.limitSelect.addEventListener("change", () => {
    state.limit = Number(els.limitSelect.value);
    state.offset = 0;
    state.history = [];
    loadEvents();
  });
  els.prevPage.addEventListener("click", goPrev);
  els.nextPage.addEventListener("click", goNext);
  els.lastPage.addEventListener("click", goLast);
  els.liveMode.addEventListener("click", toggleLiveMode);

  els.logFilter.addEventListener("input", handleLogFilter);
  els.logRefresh.addEventListener("click", () => loadLogContent(true));
  els.logLines.addEventListener("change", () => {
    let value = Number(els.logLines.value);
    if (Number.isNaN(value)) value = 2000;
    value = Math.min(Math.max(value, 10), 20000);
    els.logLines.value = value;
  });

  els.artifactRoot.addEventListener("change", () => {
    state.artifactRoot = els.artifactRoot.value;
    loadArtifacts(true);
  });
  els.artifactRefresh.addEventListener("click", () => loadArtifacts(true));
  els.conversationSave.addEventListener("click", saveConversationToDisk);
  els.conversationDownload.addEventListener("click", downloadConversationFile);
}

function initNav() {
  els.navLinks.forEach((btn) => {
    btn.addEventListener("click", () => switchPanel(btn.dataset.panel));
  });
}

function switchPanel(panelName) {
  els.navLinks.forEach((btn) => btn.classList.toggle("active", btn.dataset.panel === panelName));
  els.panels.forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${panelName}`));

  if (panelName === "codex") {
    updatePolling();
  } else {
    stopPolling();
  }

  if (panelName === "logs" && state.logs.length === 0) {
    loadJvsLogs();
  }
  if (panelName === "artifacts" && state.artifacts.length === 0) {
    loadArtifacts();
  }
}

function getAuthHeaders() {
  if (!state.tokenRequired) return {};
  if (!state.logViewerToken) return {};
  return { "X-Log-Viewer-Token": state.logViewerToken };
}

async function ensureToken() {
  if (!state.tokenRequired) return true;
  if (state.logViewerToken) return true;
  const token = prompt("This server requires LOG_VIEWER_TOKEN for this action. Enter token:");
  if (!token) return false;
  state.logViewerToken = token.trim();
  localStorage.setItem("logViewerToken", state.logViewerToken);
  return Boolean(state.logViewerToken);
}

async function loadStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.runtime = data;
    state.tokenRequired = Boolean(data.token_required_for_mutations);

    const cfg = data.codex_config || {};
    const approval = cfg.approval_policy || "unknown";
    const sandbox = cfg.sandbox_mode || "unknown";
    const net = cfg["sandbox_workspace_write.network_access"] || cfg.network_access || "";
    const parts = [`approval=${approval}`, `sandbox=${sandbox}`];
    if (net) parts.push(`net=${net}`);
    els.runtimeMeta.textContent = parts.join(" • ");
    els.runtimeMeta.title = `PROJECT_ROOT=${data.project_root}\nSESSIONS=${data.sessions_root}\nCODEX_HOME=${(data.env || {}).CODEX_HOME || ""}`;
  } catch (err) {
    console.warn("Failed to load /api/status", err);
    els.runtimeMeta.textContent = "";
  }
}

async function setSessionsRoot() {
  const current = (state.runtime && state.runtime.sessions_root) || "";
  const suggested = current || "";
  const input = prompt(
    "Enter sessions directory (WSL path like /mnt/c/Projects/.../.codex/sessions or Windows path like C:\\\\Projects\\\\...\\\\.codex\\\\sessions):",
    suggested
  );
  if (!input) return;
  if (!(await ensureToken())) return;
  try {
    const res = await fetch("/api/settings/sessions-root", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ path: input }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(detail || `HTTP ${res.status}`);
    }
    await loadStatus();
    state.currentSession = null;
    state.offset = 0;
    state.history = [];
    state.sessionMetaCache.clear();
    state.sessionStatsCache.clear();
    state.toolCalls = [];
    state.toolCallsSession = null;
    state.reasoning = [];
    state.reasoningSession = null;
    await loadSessions();
    switchPanel("codex");
  } catch (err) {
    console.error(err);
    alert(`Failed to update sessions root.\n\n${err?.message || err}`);
  }
}

async function loadSessions() {
  try {
    const res = await fetch("/api/sessions");
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.sessions = data.sessions || [];
    state.filteredSessions = state.sessions;
    els.rootPath.textContent = data.root || "";
    renderSessionList();
  } catch (err) {
    console.error(err);
    alert("Failed to load sessions. Check server logs.");
  }
}

function handleSessionFilter() {
  const query = els.sessionFilter.value.trim().toLowerCase();
  state.filteredSessions = query
    ? state.sessions.filter((session) => session.id.toLowerCase().includes(query))
    : state.sessions;
  renderSessionList();
}

function renderSessionList() {
  els.sessionList.innerHTML = "";
  if (state.filteredSessions.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No sessions found.";
    li.style.cursor = "default";
    els.sessionList.appendChild(li);
    return;
  }
  state.filteredSessions.forEach((session) => {
    const li = document.createElement("li");
    li.dataset.sessionId = session.id;
    li.dataset.format = session.format || "unknown";
    const formatBadge = session.format ? `<span class="format-badge ${session.format}">${session.format}</span>` : "";
    li.innerHTML = `<div>${session.id}${formatBadge}</div><small>${session.size_human || ""} • ${session.modified_iso || ""}</small>`;
    if (session.id === state.currentSession) {
      li.classList.add("active");
    }
    li.addEventListener("click", () => {
      if (state.currentSession !== session.id) {
        state.currentSession = session.id;
        state.currentFormat = session.format || "unknown";
        state.offset = 0;
        state.history = [];
        els.containsInput.value = "";
        state.contains = "";
        loadEvents();
      }
      document.querySelectorAll("#session-list li").forEach((node) => node.classList.remove("active"));
      li.classList.add("active");
    });
    els.sessionList.appendChild(li);
  });
}

function applyFilters() {
  state.contains = els.containsInput.value.trim();
  state.offset = 0;
  state.history = [];
  loadEvents();
}

function encodePath(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function loadEvents(nextOffset = null, options = {}) {
  const { silent = false, keepHistory = false } = options;
  if (!state.currentSession) {
    els.sessionName.textContent = "Select a session to inspect";
    els.eventList.innerHTML = "";
    return;
  }

  if (state.isLoading && silent) {
    return;
  }

  if (nextOffset !== null && nextOffset !== state.offset) {
    if (!keepHistory) state.history.push(state.offset);
    state.offset = nextOffset;
  }

  els.sessionName.textContent = state.currentSession;
  if (!silent) {
    els.pageMeta.textContent = "Loading…";
    els.eventList.innerHTML = "";
  }

  state.isLoading = true;

  const params = new URLSearchParams({
    offset: state.offset,
    limit: state.limit,
    order: state.order,
  });
  if (state.contains) params.set("contains", state.contains);

  const sessionPath = encodePath(state.currentSession);
  try {
    const res = await fetch(`/api/session/${sessionPath}/events?${params.toString()}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.latestResponse = data;
    renderEvents(data);
    loadSessionMeta();
    loadToolCalls({ silent });
    loadReasoning({ silent });
    loadConversation(silent);
  } catch (err) {
    console.error(err);
    if (!silent) alert("Failed to load session data. See console for details.");
  } finally {
    state.isLoading = false;
    updatePolling();
  }
}

function renderEvents(data) {
  const totalLines = data.total_lines ?? 0;
  const matches = data.matching_events ?? 0;
  els.pageMeta.textContent = `Showing ${data.events.length} • Matches ${matches} • File lines ${totalLines} • Offset ${data.offset}`;

  els.prevPage.disabled = state.history.length === 0;
  els.nextPage.disabled = !data.next_offset || state.order === "desc";
  const hasLast = matches > data.limit && state.order === "asc";
  els.lastPage.disabled = !hasLast || data.offset === data.last_offset;
  els.liveMode.classList.toggle("active", state.order === "desc");

  const fragment = document.createDocumentFragment();
  if (data.events.length === 0) {
    const div = document.createElement("div");
    div.className = "event-card";
    div.textContent = "No events at this offset (try adjusting filters).";
    fragment.appendChild(div);
    els.eventList.innerHTML = "";
    els.eventList.appendChild(fragment);
    return;
  }

  data.events.forEach((event) => {
    const card = document.createElement("div");
    card.className = "event-card";

    const header = document.createElement("div");
    header.className = "event-header";
    const type = document.createElement("span");
    type.className = "event-type";
    type.textContent = event.type || "unknown";
    if (event.subtype) type.textContent += ` / ${event.subtype}`;
    const meta = document.createElement("span");
    meta.textContent = `${event.timestamp || ""} • line ${event.line || ""}`;
    header.appendChild(type);
    header.appendChild(meta);
    card.appendChild(header);

    if (event.summary) {
      const summaryEl = document.createElement(event.text_block ? "div" : "pre");
      summaryEl.className = "event-summary";
      summaryEl.textContent = (event.summary || "").trim();
      card.appendChild(summaryEl);
    }

    if (event.text_block) {
      const textPre = document.createElement("pre");
      textPre.className = "event-text";
      textPre.textContent = event.text_block;
      card.appendChild(textPre);
    }

    const jsonPre = document.createElement("pre");
    jsonPre.className = "event-json";
    jsonPre.textContent = JSON.stringify(event.data, null, 2);
    card.appendChild(jsonPre);

    fragment.appendChild(card);
  });

  els.eventList.innerHTML = "";
  els.eventList.appendChild(fragment);
}

async function loadConversation(silent = false) {
  if (!state.currentSession) {
    els.conversationList.textContent = "(select a session)";
    return;
  }
  if (state.conversationLoading && silent) {
    return;
  }
  state.conversationLoading = true;
  const sessionPath = encodePath(state.currentSession);
  try {
    const res = await fetch(`/api/session/${sessionPath}/conversation?limit=300`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    renderConversation(data.events || []);
  } catch (err) {
    if (!silent) {
      console.error(err);
      els.conversationList.textContent = "Failed to load conversation.";
    }
  } finally {
    state.conversationLoading = false;
  }
}

async function saveConversationToDisk() {
  if (!state.currentSession) return;
  if (!(await ensureToken())) return;
  try {
    const sessionPath = encodePath(state.currentSession);
    const res = await fetch(`/api/session/${sessionPath}/conversation/save?limit=1000`, {
      method: "POST",
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    alert(`Saved ${data.count} messages to ${data.saved_path}`);
  } catch (err) {
    console.error(err);
    alert("Failed to save conversation.");
  }
}

async function downloadConversationFile() {
  if (!state.currentSession) return;
  const sessionPath = encodePath(state.currentSession);
  window.open(`/api/session/${sessionPath}/conversation/download?limit=1000`, "_blank", "noopener");
}

function renderConversation(events) {
  const container = els.conversationList;
  container.innerHTML = "";
  if (!events.length) {
    container.textContent = "No conversation events yet.";
    return;
  }
  const fragment = document.createDocumentFragment();
  const ordered = [...events].reverse().filter((event) => (event.role || "assistant") !== "system");
  if (!ordered.length) {
    container.textContent = "No user/assistant messages yet.";
    return;
  }
  ordered.forEach((event) => {
    const item = document.createElement("div");
    item.className = "conversation-item";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span>${event.role || "assistant"}</span><span>${event.timestamp || ""}</span>`;
    const body = document.createElement("pre");
    body.textContent = event.text || "";
    item.appendChild(meta);
    item.appendChild(body);
    fragment.appendChild(item);
  });
  container.appendChild(fragment);
}

function goPrev() {
  if (!state.history.length) return;
  const previousOffset = state.history.pop();
  if (previousOffset === undefined) return;
  state.offset = previousOffset;
  loadEvents(null, { keepHistory: true });
}

function goNext() {
  if (!state.latestResponse || !state.latestResponse.next_offset) return;
  const next = state.latestResponse.next_offset;
  loadEvents(next);
}

function goLast() {
  if (!state.latestResponse) return;
  const lastOffset = state.latestResponse.last_offset;
  if (lastOffset === undefined || lastOffset === null) return;
  if (lastOffset === state.offset) return;
  state.history.push(state.offset);
  state.offset = lastOffset;
  loadEvents(null, { keepHistory: true });
}

function toggleLiveMode() {
  state.order = state.order === "desc" ? "asc" : "desc";
  state.offset = 0;
  state.history = [];
  loadEvents();
}

function updatePolling() {
  const shouldPoll = Boolean(state.currentSession) && state.order === "desc" && state.offset === 0;
  if (shouldPoll) {
    if (!state.pollId) {
      state.pollId = setInterval(() => {
        loadEvents(0, { silent: true, keepHistory: true });
      }, POLL_INTERVAL_MS);
    }
  } else {
    stopPolling();
  }

  updateToolCallsPolling();
  updateReasoningPolling();
}

function stopPolling() {
  if (state.pollId) {
    clearInterval(state.pollId);
    state.pollId = null;
  }
  if (state.toolCallsPollId) {
    clearInterval(state.toolCallsPollId);
    state.toolCallsPollId = null;
  }
  if (state.reasoningPollId) {
    clearInterval(state.reasoningPollId);
    state.reasoningPollId = null;
  }
}

window.addEventListener("beforeunload", () => {
  stopPolling();
});

async function loadJvsLogs() {
  try {
    const res = await fetch("/api/jvs-logs");
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.logs = data.logs || [];
    state.filteredLogs = state.logs;
    renderLogList();
  } catch (err) {
    console.error(err);
    alert("Failed to load JVS logs.");
  }
}

function renderLogList() {
  els.logList.innerHTML = "";
  if (!state.filteredLogs.length) {
    const li = document.createElement("li");
    li.textContent = "No logs found.";
    li.style.cursor = "default";
    els.logList.appendChild(li);
    return;
  }
  state.filteredLogs.forEach((log) => {
    const li = document.createElement("li");
    li.dataset.logId = log.id;
    li.innerHTML = `<div>${log.id}</div><small>${log.size_human || ""} • ${log.modified_iso || ""}</small>`;
    if (log.id === state.currentLog) li.classList.add("active");
    li.addEventListener("click", () => {
      state.currentLog = log.id;
      document.querySelectorAll("#log-list li").forEach((node) => node.classList.remove("active"));
      li.classList.add("active");
      loadLogContent();
    });
    els.logList.appendChild(li);
  });
}

function handleLogFilter() {
  const query = els.logFilter.value.trim().toLowerCase();
  state.filteredLogs = query ? state.logs.filter((log) => log.id.toLowerCase().includes(query)) : state.logs;
  renderLogList();
}

async function loadLogContent(force = false) {
  if (!state.currentLog) {
    els.logName.textContent = "Select a log file";
    els.logContent.textContent = "(no log selected)";
    return;
  }
  const lines = Number(els.logLines.value) || 2000;
  if (state.isLoading && !force) return;
  try {
    const encoded = encodePath(state.currentLog);
    const res = await fetch(`/api/jvs-log/${encoded}?lines=${lines}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    els.logName.textContent = data.path;
    els.logContent.textContent = data.content || "";
  } catch (err) {
    console.error(err);
    alert("Failed to load log content.");
  }
}

async function loadArtifacts(force = false) {
  if (state.isLoading && !force && state.artifacts.length) return;
  try {
    const res = await fetch(`/api/artifacts?root=${state.artifactRoot}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.artifacts = data.artifacts || [];
    renderArtifacts();
  } catch (err) {
    console.error(err);
    alert("Failed to load artifacts.");
  }
}

function renderArtifacts() {
  els.artifactTable.innerHTML = "";
  if (!state.artifacts.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = "No artifacts found.";
    row.appendChild(cell);
    els.artifactTable.appendChild(row);
    return;
  }
  state.artifacts.forEach((file) => {
    const row = document.createElement("tr");
    const encoded = encodePath(file.id);
    row.innerHTML = `
      <td>${file.id}</td>
      <td>${file.size_human || ""}</td>
      <td>${file.modified_iso || ""}</td>
      <td><a href="/api/artifact/${state.artifactRoot}/${encoded}" target="_blank" rel="noopener">Open</a></td>
    `;
    els.artifactTable.appendChild(row);
  });
}

async function loadSessionMeta() {
  if (!state.currentSession) return;
  if (state.sessionMetaCache.has(state.currentSession)) {
    renderSessionMeta(state.sessionMetaCache.get(state.currentSession));
    return;
  }
  const sessionPath = encodePath(state.currentSession);
  try {
    const res = await fetch(`/api/session/${sessionPath}/meta`);
    if (!res.ok) throw new Error(await res.text());
    const meta = await res.json();
    state.sessionMetaCache.set(state.currentSession, meta);
    renderSessionMeta(meta);
  } catch (err) {
    console.warn("Failed to load session meta", err);
    els.sessionMeta.classList.add("hidden");
    els.sessionMeta.textContent = "";
  }
}

async function loadSessionStats() {
  if (!state.currentSession) return;
  if (state.sessionStatsCache.has(state.currentSession)) {
    return state.sessionStatsCache.get(state.currentSession);
  }
  const sessionPath = encodePath(state.currentSession);
  const res = await fetch(`/api/session/${sessionPath}/stats`);
  if (!res.ok) throw new Error(await res.text());
  const stats = await res.json();
  state.sessionStatsCache.set(state.currentSession, stats);
  return stats;
}

function pill(label, value, kind = "") {
  const cls = kind ? `pill ${kind}` : "pill";
  return `<span class="${cls}"><strong>${label}</strong><code>${escapeHtml(value)}</code></span>`;
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderSessionMeta(meta) {
  if (!meta) return;
  const tc = meta.last_turn_context || {};
  const tok = meta.last_token_count || {};
  const counters = meta.counters || {};

  const approval = normalizeScalar(tc.approval_policy) || "unknown";
  const sandbox = normalizeEnum(tc.sandbox_policy) || "unknown";
  const model = normalizeScalar(tc.model) || "";
  const danger = String(sandbox).includes("danger");

  const tokenTotal = tok.total_tokens ?? tok.total ?? tok.total_usage_tokens ?? "";
  const tokenLast = tok.last_turn_tokens ?? tok.last_turn_total_tokens ?? "";

  const rows = [];
  const row1 = [
    pill("model", model || "unknown"),
    pill("approval", approval),
    pill("sandbox", sandbox, danger ? "danger" : ""),
  ];
  rows.push(`<div class="row">${row1.join("")}</div>`);

  const row2 = [
    pill("lines", counters.lines ?? ""),
    pill("items", `resp=${counters.response_items ?? 0}, ev=${counters.event_msgs ?? 0}, compact=${counters.compactions ?? 0}`),
  ];
  if (tokenTotal !== "" || tokenLast !== "") {
    row2.push(pill("tokens", `total=${tokenTotal || "?"}, last=${tokenLast || "?"}`));
  }
  rows.push(`<div class="row">${row2.join("")}</div>`);

  rows.push(`<details><summary>Storage drivers (sampled)</summary><div id="stats-body">(click to load)</div></details>`);
  els.sessionMeta.innerHTML = rows.join("");
  els.sessionMeta.classList.remove("hidden");

  const details = els.sessionMeta.querySelector("details");
  const statsBody = els.sessionMeta.querySelector("#stats-body");
  if (details && statsBody) {
    details.addEventListener(
      "toggle",
      async () => {
        if (!details.open) return;
        if (statsBody.dataset.loaded) return;
        statsBody.textContent = "Loading…";
        try {
          const stats = await loadSessionStats();
          const lines = [];
          const breakdown = stats.type_breakdown || [];
          lines.push("<div class='row'>");
          breakdown.slice(0, 8).forEach((entry) => {
            const mb = (entry.bytes / 1024 / 1024).toFixed(2);
            lines.push(pill(entry.type, `${mb}MB/${entry.count}`));
          });
          lines.push("</div>");

          const large = stats.largest_text_entries || [];
          if (large.length) {
            lines.push("<div style='margin-top:0.4rem'><strong>Largest text blobs</strong></div>");
            lines.push("<ol style='margin:0.25rem 0 0 1.2rem'>");
            large.slice(0, 5).forEach((e) => {
              lines.push(`<li><code>line ${e.line}</code> <code>${escapeHtml(e.kind)}</code> <code>${escapeHtml(e.field)}</code> <code>${e.chars} chars</code></li>`);
            });
            lines.push("</ol>");
          }
          statsBody.innerHTML = lines.join("");
          statsBody.dataset.loaded = "1";
        } catch (err) {
          console.warn(err);
          statsBody.textContent = "Failed to load stats.";
        }
      },
      { once: false }
    );
  }
}

function normalizeScalar(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function normalizeEnum(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    // Common serde enum shapes:
    // - { "type": "danger_full_access" }
    // - { "mode": "danger-full-access" }
    // - { "DangerFullAccess": {} }
    if (typeof value.type === "string") return value.type;
    if (typeof value.mode === "string") return value.mode;
    const keys = Object.keys(value);
    if (keys.length === 1) return keys[0];
    try {
      return JSON.stringify(value);
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

async function loadToolCalls(options = {}) {
  const { silent = false, force = false } = options;
  if (!state.currentSession) {
    els.toolCallsMeta.textContent = "";
    els.toolCallsList.textContent = "(select a session)";
    return;
  }
  if (state.toolCallsLoading && silent) return;
  if (!force && !state.toolCallsLive && state.toolCalls.length && state.currentSession === state.toolCallsSession) return;

  state.toolCallsLoading = true;
  state.toolCallsSession = state.currentSession;
  const sessionPath = encodePath(state.currentSession);
  const params = new URLSearchParams({ limit: String(state.toolCallsLimit || 200), order: "desc" });
  const contains = (state.toolCallsContains || "").trim();
  if (contains) params.set("contains", contains);

  if (!silent) {
    els.toolCallsMeta.textContent = "Loading…";
    els.toolCallsList.textContent = "";
  }
  try {
    const res = await fetch(`/api/session/${sessionPath}/tool-calls?${params.toString()}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    const data = await res.json();
    state.toolCalls = data.items || [];
    renderToolCalls(data);
  } catch (err) {
    console.warn(err);
    if (!silent) {
      const msg = err?.message || String(err || "");
      els.toolCallsMeta.textContent = msg.includes("Not Found") || msg.includes("404") ? msg : "Failed to load tool calls.";
      els.toolCallsList.textContent =
        "Failed to load tool calls. If you just updated the code, restart the server (or run with --reload).";
    }
  } finally {
    state.toolCallsLoading = false;
  }
}

function toggleToolCallsLive() {
  state.toolCallsLive = !state.toolCallsLive;
  els.toolCallsLive.classList.toggle("active", state.toolCallsLive);
  if (state.toolCallsLive) {
    loadToolCalls({ force: true });
  }
  updateToolCallsPolling();
}

function updateToolCallsPolling() {
  const inCodex = document.getElementById("panel-codex")?.classList.contains("active");
  const shouldPoll = Boolean(inCodex && state.currentSession && state.toolCallsLive && !state.pollId);

  if (shouldPoll && !state.toolCallsPollId) {
    state.toolCallsPollId = setInterval(() => {
      loadToolCalls({ silent: true, force: true });
    }, POLL_INTERVAL_MS);
  } else if (!shouldPoll && state.toolCallsPollId) {
    clearInterval(state.toolCallsPollId);
    state.toolCallsPollId = null;
  }
}

function safeJsonParse(text) {
  if (!text || typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatShellArguments(argumentsText) {
  const obj = safeJsonParse(argumentsText);
  if (!obj) return (argumentsText || "").slice(0, 600);
  const command = Array.isArray(obj.command) ? obj.command.join(" ") : obj.command;
  const workdir = obj.workdir ? ` (cwd=${obj.workdir})` : "";
  return `${command || ""}${workdir}`.trim();
}

function renderToolCalls(data) {
  const items = data.items || [];
  const counters = data.counters || {};
  els.toolCallsMeta.textContent = `Showing ${items.length} • paired ${counters.paired || 0} • scanned ${counters.lines_scanned || 0} lines`;

  els.toolCallsList.innerHTML = "";
  if (!items.length) {
    els.toolCallsList.textContent = "No tool calls found.";
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((it) => {
    const card = document.createElement("div");
    card.className = "toolcall-card";

    const header = document.createElement("div");
    header.className = "toolcall-header";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = it.name || "function_call";
    const meta = document.createElement("div");
    meta.className = "meta";
    const lines = [];
    if (it.call_line) lines.push(`call@${it.call_line}`);
    if (it.output_line) lines.push(`out@${it.output_line}`);
    if (it.call_timestamp) lines.push(it.call_timestamp);
    meta.textContent = lines.join(" • ");
    header.appendChild(name);
    header.appendChild(meta);
    card.appendChild(header);

    const callId = document.createElement("div");
    callId.className = "toolcall-code";
    callId.textContent = `call_id: ${it.call_id || ""}`;
    card.appendChild(callId);

    if (it.arguments) {
      const argsPre = document.createElement("pre");
      argsPre.className = "toolcall-code";
      const prettyArgs = it.name === "shell" ? formatShellArguments(it.arguments) : String(it.arguments).slice(0, 800);
      argsPre.textContent = `args: ${prettyArgs}`;
      card.appendChild(argsPre);
    }

    if (it.output_meta) {
      const m = it.output_meta || {};
      const metaLine = [];
      if (m.exit_code !== undefined) metaLine.push(`exit=${m.exit_code}`);
      if (m.duration_seconds !== undefined) metaLine.push(`dur=${m.duration_seconds}s`);
      if (metaLine.length) {
        const outMeta = document.createElement("pre");
        outMeta.className = "toolcall-code";
        outMeta.textContent = `output: ${metaLine.join(" ")}`;
        card.appendChild(outMeta);
      }
    }

    if (it.output_preview) {
      const out = document.createElement("pre");
      out.className = "toolcall-code";
      out.textContent = `out_preview: ${String(it.output_preview).slice(0, 800)}`;
      card.appendChild(out);
    }

    const actions = document.createElement("div");
    actions.className = "toolcall-actions";
    const jump = document.createElement("button");
    jump.textContent = "Show In Log";
    jump.addEventListener("click", () => {
      els.containsInput.value = it.call_id || "";
      state.contains = it.call_id || "";
      state.offset = 0;
      state.history = [];
      loadEvents();
    });
    const copy = document.createElement("button");
    copy.textContent = "Copy call_id";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(it.call_id || "");
      } catch {
        // ignore
      }
    });
    actions.appendChild(jump);
    actions.appendChild(copy);
    card.appendChild(actions);

    fragment.appendChild(card);
  });
  els.toolCallsList.appendChild(fragment);
}

async function loadReasoning(options = {}) {
  const { silent = false, force = false } = options;
  if (!state.currentSession) {
    els.reasoningMeta.textContent = "";
    els.reasoningList.textContent = "(select a session)";
    return;
  }
  if (state.reasoningLoading && silent) return;
  if (!force && !state.reasoningLive && state.reasoning.length && state.currentSession === state.reasoningSession) return;

  state.reasoningLoading = true;
  state.reasoningSession = state.currentSession;
  const sessionPath = encodePath(state.currentSession);
  const params = new URLSearchParams({ limit: String(state.reasoningLimit || 200), order: "desc" });
  const contains = (state.reasoningContains || "").trim();
  if (contains) params.set("contains", contains);

  if (!silent) {
    els.reasoningMeta.textContent = "Loading…";
    els.reasoningList.textContent = "";
  }
  try {
    const res = await fetch(`/api/session/${sessionPath}/reasoning?${params.toString()}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    const data = await res.json();
    state.reasoning = data.items || [];
    renderReasoning(data);
  } catch (err) {
    console.warn(err);
    if (!silent) {
      const msg = err?.message || String(err || "");
      els.reasoningMeta.textContent = msg.includes("Not Found") || msg.includes("404") ? msg : "Failed to load reasoning.";
      els.reasoningList.textContent = "Failed to load reasoning. If you just updated the code, restart the server (or run with --reload).";
    }
  } finally {
    state.reasoningLoading = false;
  }
}

function toggleReasoningLive() {
  state.reasoningLive = !state.reasoningLive;
  els.reasoningLive.classList.toggle("active", state.reasoningLive);
  if (state.reasoningLive) {
    loadReasoning({ force: true });
  }
  updateReasoningPolling();
}

function updateReasoningPolling() {
  const inCodex = document.getElementById("panel-codex")?.classList.contains("active");
  const shouldPoll = Boolean(inCodex && state.currentSession && state.reasoningLive && !state.pollId);

  if (shouldPoll && !state.reasoningPollId) {
    state.reasoningPollId = setInterval(() => {
      loadReasoning({ silent: true, force: true });
    }, POLL_INTERVAL_MS);
  } else if (!shouldPoll && state.reasoningPollId) {
    clearInterval(state.reasoningPollId);
    state.reasoningPollId = null;
  }
}

function renderReasoning(data) {
  const items = data.items || [];
  const counters = data.counters || {};
  els.reasoningMeta.textContent = `Showing ${items.length} • matched ${counters.matched || 0} • scanned ${counters.lines_scanned || 0} lines`;

  els.reasoningList.innerHTML = "";
  if (!items.length) {
    els.reasoningList.textContent = "No reasoning items found.";
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((it) => {
    const card = document.createElement("div");
    card.className = "reasoning-card";

    const header = document.createElement("div");
    header.className = "reasoning-header";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = "agent_reasoning";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${it.timestamp || ""} • line ${it.line || ""}`;
    header.appendChild(name);
    header.appendChild(meta);
    card.appendChild(header);

    const text = document.createElement("pre");
    text.className = "reasoning-text";
    text.textContent = String(it.text || "").trim();
    card.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "reasoning-actions";
    const jump = document.createElement("button");
    jump.textContent = "Show In Log";
    jump.addEventListener("click", () => {
      els.containsInput.value = it.timestamp || "agent_reasoning";
      applyFilters();
      els.eventList.scrollTop = 0;
    });
    actions.appendChild(jump);
    card.appendChild(actions);

    fragment.appendChild(card);
  });

  els.reasoningList.appendChild(fragment);
}

async function handleKillSwitch() {
  const confirmed = confirm("Kill all Codex executables on this host? This will abort any running sessions.");
  if (!confirmed) return;
  if (!(await ensureToken())) return;
  try {
    const res = await fetch("/api/kill-codex", { method: "POST", headers: getAuthHeaders() });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    alert(
      `Kill issued.\nBefore: ${data.before?.length || 0}\nAfter: ${data.after?.length || 0}\nDetails:\n${(data.results || []).join(
        "\n"
      )}`
    );
  } catch (err) {
    console.error(err);
    alert("Failed to trigger kill switch.");
  }
}
