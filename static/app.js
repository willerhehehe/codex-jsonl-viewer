const INSPECTOR_WIDTH_STORAGE_KEY = "jsonl-session-viewer.inspector-width";
const TAIL_VARIANT_STORAGE_KEY = "jsonl-session-viewer.tail-variant";
const TAIL_JQ_SUFFIX = `jq -Rr -C --unbuffered 'fromjson? // .'`;
const TAIL_VARIANTS = [
  { key: "follow", label: "Follow (tail -F)", args: "-F" },
  { key: "new", label: "New lines only (-n 0)", args: "-F -n 0" },
  { key: "replay", label: "Replay from start (-n +1)", args: "-F -n +1" },
  { key: "raw", label: "Raw tail (no jq)", args: "-F", jq: false },
];
const DEFAULT_INSPECTOR_WIDTH = 380;
const WIDE_INSPECTOR_WIDTH = 720;
const MIN_INSPECTOR_WIDTH = 320;
const MIN_STREAM_WIDTH = 520;
const SIDEBAR_WIDTH = 255;
const RESIZE_HANDLE_WIDTH = 8;
const TURN_CATEGORY_KEYS = ["requirement", "system", "retrieved", "reasoning", "tools", "assistant"];
const TURN_CATEGORY_LABELS = {
  requirement: "Requirement / User",
  system: "System & Policy",
  retrieved: "Retrieved Context",
  reasoning: "Reasoning",
  tools: "Tools & Results",
  assistant: "Assistant Output",
};

const DEFAULT_FIELDS = new Set([
  "timestamp",
  "type",
  "payload.type",
  "payload.output",
  "payload.metadata.exit_code",
  "payload.info.total_token_usage.input_tokens",
  "payload.info.total_token_usage.output_tokens",
  "payload.info.total_token_usage.total_tokens",
  "payload.info.rate_limits.primary.used_percent",
  "payload.info.rate_limits.secondary.used_percent",
]);

const state = {
  root: "",
  dates: [],
  selectedDate: "",
  files: [],
  selectedFile: "",
  records: [],
  turns: [],
  sessionContext: {},
  session: {},
  selectedTurnId: null,
  turnRecords: new Map(),
  expandedTurns: new Set(),
  viewMode: "turns",
  turnDensity: "compact",
  compositionMetric: "bytes",
  turnPhaseFilter: "",
  fields: new Set(DEFAULT_FIELDS),
  discoveredFields: new Set(),
  expanded: new Set(),
  expandedEvents: new Set(),
  selectedLineNo: null,
  eventFilter: "all",
  inspectorTab: "summary",
  offset: 0,
  stream: null,
  paused: false,
  autoScroll: true,
  query: "",
  fieldQuery: "",
  eventOrder: "latest-top",
  inspectorWide: false,
  inspectorWidth: readInspectorWidth(),
  tailVariant: readTailVariant(),
  truncateAfter: 180,
};

const el = {
  rootPath: document.querySelector("#rootPath"),
  viewTabs: document.querySelector("#viewTabs"),
  dateInput: document.querySelector("#dateInput"),
  copyHandoffButton: document.querySelector("#copyHandoffButton"),
  copyTailGroup: document.querySelector("#copyTailGroup"),
  copyTailButton: document.querySelector("#copyTailButton"),
  copyTailMenuButton: document.querySelector("#copyTailMenuButton"),
  copyTailMenu: document.querySelector("#copyTailMenu"),
  refreshButton: document.querySelector("#refreshButton"),
  dateStatus: document.querySelector("#dateStatus"),
  fileList: document.querySelector("#fileList"),
  mainLayout: document.querySelector("#mainLayout"),
  activeFile: document.querySelector("#activeFile"),
  streamStatus: document.querySelector("#streamStatus"),
  eventControls: document.querySelector("#eventControls"),
  turnControls: document.querySelector("#turnControls"),
  turnOverview: document.querySelector("#turnOverview"),
  eventFilterBar: document.querySelector("#eventFilterBar"),
  eventStream: document.querySelector("#eventStream"),
  searchInput: document.querySelector("#searchInput"),
  eventOrderSelect: document.querySelector("#eventOrderSelect"),
  autoScrollInput: document.querySelector("#autoScrollInput"),
  pauseButton: document.querySelector("#pauseButton"),
  inspectorResizeHandle: document.querySelector("#inspectorResizeHandle"),
  inspectorWideButton: document.querySelector("#inspectorWideButton"),
  inspectorTitle: document.querySelector("#inspectorTitle"),
  inspectorStatus: document.querySelector("#inspectorStatus"),
  inspectorTabs: document.querySelector("#inspectorTabs"),
  inspectorContent: document.querySelector("#inspectorContent"),
};

async function api(path) {
  const response = await fetch(path);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || response.statusText);
  }
  return body;
}

async function loadDates() {
  setStatus("Loading dates");
  const data = await api("/api/dates");
  state.root = data.root;
  state.dates = data.dates || [];
  state.selectedDate = state.dates.includes(data.today) ? data.today : (state.dates[0] || data.today);
  el.rootPath.textContent = state.root;
  el.dateInput.value = state.selectedDate;
  await loadFiles();
}

async function loadFiles() {
  closeStream();
  state.records = [];
  state.turns = [];
  state.session = {};
  state.turnRecords = new Map();
  state.selectedTurnId = null;
  state.expandedTurns = new Set();
  state.selectedLineNo = null;
  state.offset = 0;
  setFileActionsEnabled(false);
  renderEvents();
  renderInspector();
  setStatus("Loading files");
  const data = await api(`/api/files?date=${encodeURIComponent(state.selectedDate)}`);
  state.files = data.files || [];
  state.selectedFile = state.files[0]?.name || "";
  renderFiles();
  if (state.selectedFile) {
    await loadInitial();
  } else {
    el.activeFile.textContent = "";
    setStatus("No rollout files");
  }
}

async function loadInitial() {
  closeStream();
  const limit = 250;
  const url = `/api/initial?date=${encodeURIComponent(state.selectedDate)}&file=${encodeURIComponent(state.selectedFile)}&limit=${limit}`;
  const turnsUrl = `/api/turns?date=${encodeURIComponent(state.selectedDate)}&file=${encodeURIComponent(state.selectedFile)}`;
  const [data, turnData] = await Promise.all([api(url), api(turnsUrl)]);
  state.records = data.records || [];
  state.turns = turnData.turns || [];
  state.sessionContext = turnData.sessionContext || {};
  state.session = turnData.session || {};
  state.turnRecords = new Map();
  state.selectedTurnId = state.turns[0]?.id || null;
  state.expandedTurns = new Set(state.selectedTurnId ? [state.selectedTurnId] : []);
  state.offset = data.offset || 0;
  setFileActionsEnabled(true);
  renderFiles();
  renderEvents();
  renderInspector();
  renderViewMode();
  el.activeFile.textContent = `${formatFileName(state.selectedFile)} · ${formatFileId(state.selectedFile)}`;
  setStatus(`${state.turns.length} turns · ${state.records.length} recent events`);
  if (!state.paused) {
    openStream();
  }
}

function openStream() {
  closeStream();
  if (!state.selectedDate || !state.selectedFile || state.paused) {
    return;
  }
  const params = new URLSearchParams({
    date: state.selectedDate,
    file: state.selectedFile,
    offset: String(state.offset),
  });
  state.stream = new EventSource(`/api/stream?${params.toString()}`);
  state.stream.onopen = () => setStatus("Live");
  state.stream.onerror = () => setStatus("Stream reconnecting");
  state.stream.onmessage = (event) => {
    const item = JSON.parse(event.data);
    state.records.push(item);
    state.offset = Math.max(state.offset, item.nextOffset || item.offset || state.offset);
    if (state.viewMode === "turns") {
      updateLiveTurn(item);
      const payloadType = getByPath(item.record || {}, "payload.type");
      if (["task_started", "task_complete", "turn_aborted"].includes(payloadType)) {
        refreshTurns();
      } else {
        renderEvents({ preserveScroll: !state.autoScroll });
      }
    } else {
      appendOrRender(item);
    }
    renderInspector();
  };
}

async function refreshTurns() {
  if (!state.selectedDate || !state.selectedFile) {
    return;
  }
  const url = `/api/turns?date=${encodeURIComponent(state.selectedDate)}&file=${encodeURIComponent(state.selectedFile)}`;
  const data = await api(url);
  const selected = state.selectedTurnId;
  const previousEnds = new Map(state.turns.map((turn) => [turn.id, turn.endOffset]));
  state.turns = data.turns || [];
  state.sessionContext = data.sessionContext || {};
  state.session = data.session || {};
  for (const turn of state.turns) {
    if (previousEnds.has(turn.id) && previousEnds.get(turn.id) !== turn.endOffset) {
      state.turnRecords.delete(turn.id);
    }
  }
  if (!state.turns.some((turn) => turn.id === selected)) {
    state.selectedTurnId = state.turns[0]?.id || null;
  }
  if (state.selectedTurnId) {
    state.expandedTurns.add(state.selectedTurnId);
  }
  renderEvents({ preserveScroll: true });
  renderInspector();
}

function closeStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
}

function renderFiles() {
  el.dateStatus.textContent = `${state.selectedDate || "No date"} · ${state.files.length} files`;
  if (!state.files.length) {
    el.fileList.innerHTML = `<div class="empty-state">No rollout JSONL files</div>`;
    return;
  }
  el.fileList.innerHTML = state.files.map((file) => {
    const active = file.name === state.selectedFile ? " active" : "";
    return `
      <button class="file-button${active}" type="button" data-file="${escapeAttr(file.name)}">
        <div class="file-name">${escapeHtml(formatFileName(file.name))}</div>
        <div class="file-id">${escapeHtml(formatFileId(file.name))}</div>
        <div class="file-meta"><span>${formatBytes(file.size)}</span><span>${formatTimeOnly(file.modifiedAt)}</span></div>
      </button>
    `;
  }).join("");
}

function renderEvents(options = {}) {
  if (state.viewMode === "turns") {
    renderTurns(options);
    return;
  }
  const visible = orderedRecords(filteredRecords());
  const render = () => {
    if (!visible.length) {
      el.eventStream.innerHTML = `<div class="empty-state">No events</div>`;
      return;
    }
    el.eventStream.innerHTML = visible.map((item) => renderEvent(item)).join("");
  };
  if (options.preserveScroll) {
    preserveScrollPosition(render);
  } else {
    render();
    scrollIfNeeded();
  }
}

function renderViewMode() {
  for (const tab of el.viewTabs.querySelectorAll("[data-view]")) {
    tab.classList.toggle("active", tab.dataset.view === state.viewMode);
  }
  const turnsMode = state.viewMode === "turns";
  el.eventControls.hidden = turnsMode;
  el.turnControls.hidden = !turnsMode;
  el.eventFilterBar.hidden = turnsMode;
  el.turnOverview.hidden = !turnsMode;
  el.inspectorTitle.textContent = turnsMode ? "Turn Inspector" : "Inspector";
  el.searchInput.placeholder = turnsMode ? "Search turns" : "Search rendered events";
  for (const button of el.turnControls.querySelectorAll("[data-turn-density]")) {
    button.classList.toggle("active", button.dataset.turnDensity === state.turnDensity);
  }
  renderTurnOverview();
}

function renderTurns(options = {}) {
  const turns = filteredTurns();
  const render = () => {
    if (!turns.length) {
      el.eventStream.innerHTML = `<div class="empty-state">No turns match this session.</div>`;
      return;
    }
    if (state.turnDensity === "narrative") {
      el.eventStream.innerHTML = `<div class="turn-narrative-list">${turns.map(renderNarrativeTurn).join("")}</div>`;
    } else {
      el.eventStream.innerHTML = `
        <div class="turn-ledger" role="list" aria-label="Conversation turns">
          <div class="turn-ledger-head" aria-hidden="true">
            <span>Turn</span><span>Time</span><span>User request</span><span class="col-duration">Duration</span>
            <span>Events</span><span>Token Δ</span><span class="col-tools">Tools</span><span class="col-status">Status</span>
            <span>Context composition</span><span aria-hidden="true"></span>
          </div>
          ${turns.map(renderCompactTurn).join("")}
        </div>
      `;
    }
    scrollSelectedTurnIntoView(options);
  };
  if (options.preserveScroll) {
    preserveScrollPosition(render);
  } else {
    render();
  }
  renderTurnOverview();
}

function renderCompactTurn(turn) {
  const selected = turn.id === state.selectedTurnId;
  const expanded = state.expandedTurns.has(turn.id);
  return `
    <article class="turn-ledger-item${selected ? " selected" : ""}" data-turn-id="${escapeAttr(turn.id)}" role="listitem">
      <button class="turn-row-grid" type="button" data-select-turn="${escapeAttr(turn.id)}" aria-expanded="${expanded}">
        <span class="turn-index">${escapeHtml(turnNumber(turn))}</span>
        <span class="turn-time">${escapeHtml(formatShortTime(turn.startTime))}</span>
        <span class="turn-request">${escapeHtml(turn.userMessage || "No user message captured")}</span>
        <span class="col-duration">${escapeHtml(formatDuration(turn.durationMs))}</span>
        <span>${formatNumber(turn.eventCount)}</span>
        <span>${escapeHtml(formatDelta(turn.tokenDelta?.total_tokens))}</span>
        <span class="col-tools">${formatNumber(turn.toolCount)}</span>
        <span class="col-status"><span class="turn-status ${escapeAttr(turn.status)}">${escapeHtml(turn.status)}</span></span>
        <span>${renderCompositionBar(turn)}</span>
        <span class="turn-chevron" aria-hidden="true">${expanded ? "−" : "+"}</span>
      </button>
      ${expanded ? renderTurnExpansion(turn) : ""}
    </article>
  `;
}

function renderNarrativeTurn(turn) {
  const selected = turn.id === state.selectedTurnId;
  const expanded = state.expandedTurns.has(turn.id);
  return `
    <article class="turn-narrative-item${selected ? " selected" : ""}" data-turn-id="${escapeAttr(turn.id)}">
      <button class="turn-narrative-header" type="button" data-select-turn="${escapeAttr(turn.id)}" aria-expanded="${expanded}">
        <span class="turn-index">${escapeHtml(turnNumber(turn))}</span>
        <span class="turn-request">${escapeHtml(turn.userMessage || "No user message captured")}</span>
        <span class="turn-narrative-meta">${escapeHtml(formatShortTime(turn.startTime))} · ${escapeHtml(formatDuration(turn.durationMs))} · ${formatNumber(turn.eventCount)} events · ${escapeHtml(formatDelta(turn.tokenDelta?.total_tokens))}</span>
        <span class="turn-chevron" aria-hidden="true">${expanded ? "−" : "+"}</span>
      </button>
      <div class="turn-narrative-composition">${renderCompositionBar(turn, true)}</div>
      ${expanded ? renderTurnExpansion(turn) : ""}
    </article>
  `;
}

function renderTurnExpansion(turn) {
  const inputCount = categoryCount(turn, ["requirement", "system", "retrieved"]);
  const reasoningCount = categoryCount(turn, ["reasoning"]);
  const toolCount = categoryCount(turn, ["tools"]);
  const outputCount = categoryCount(turn, ["assistant"]);
  return `
    <div class="turn-expansion">
      ${renderTurnPhase(turn, "input", "Input context", "User request, system & policy, retrieved context", inputCount, turn.userMessage)}
      ${renderTurnPhase(turn, "reasoning", "Agent work", "Reasoning steps and intermediate actions", reasoningCount, "How the agent planned and worked through this turn.")}
      ${renderTurnPhase(turn, "tools", "Tool calls", turn.toolNames?.length ? turn.toolNames.join(", ") : "Tool calls and results", toolCount, turn.toolCount ? `${turn.toolCount} calls across this turn.` : "No tool calls in this turn.")}
      ${renderTurnPhase(turn, "assistant", "Final answer", "Assistant output", outputCount, turn.assistantMessage || "No final answer captured yet.")}
    </div>
  `;
}

function renderTurnPhase(turn, phase, label, meta, count, summary) {
  const selected = turn.id === state.selectedTurnId && phase === state.turnPhaseFilter;
  return `
    <button class="turn-phase${selected ? " selected" : ""}" type="button" data-turn-phase="${phase}" data-turn-id="${escapeAttr(turn.id)}" aria-pressed="${selected}">
      <span class="phase-dot ${phase}"></span>
      <span class="phase-copy">
        <span class="phase-title">${escapeHtml(label)} <span>${escapeHtml(meta)}</span></span>
        <span class="phase-summary">${escapeHtml(oneLine(summary, 180))}</span>
      </span>
      <span class="phase-count">${formatNumber(count)} ${count === 1 ? "item" : "items"}</span>
    </button>
  `;
}

function renderTurnOverview() {
  if (state.viewMode !== "turns") {
    el.turnOverview.innerHTML = "";
    return;
  }
  const turns = state.turns;
  const totalTokens = turns.reduce((sum, turn) => sum + Number(turn.tokenDelta?.total_tokens || 0), 0);
  const metric = state.compositionMetric;
  const totals = TURN_CATEGORY_KEYS.map((key) => turns.reduce((sum, turn) => (
    sum + Number(turn.composition?.[key]?.[metric] || 0)
  ), 0));
  const totalComposition = totals.reduce((sum, value) => sum + value, 0);
  const segments = TURN_CATEGORY_KEYS.map((key, index) => {
    const percent = totalComposition ? totals[index] / totalComposition * 100 : 0;
    if (!percent) {
      return "";
    }
    const valueLabel = metric === "bytes" ? formatBytes(totals[index]) : `${formatNumber(totals[index])} events`;
    const label = percent >= 8 ? `${Math.round(percent)}%` : "";
    return `<span class="session-composition-segment category-${key}" style="width:${percent.toFixed(2)}%" title="${escapeAttr(`${TURN_CATEGORY_LABELS[key]} · ${Math.round(percent)}% · ${valueLabel}`)}">${label}</span>`;
  }).join("");
  el.turnOverview.innerHTML = `
    <div class="overview-summary">
      <strong>Session overview</strong>
      <span>${formatNumber(turns.length)} turns</span>
      <span>${escapeHtml(formatDelta(totalTokens))} token delta</span>
      <div class="metric-switch" aria-label="Composition measure">
        <span>Measured by</span>
        <button type="button" data-composition-metric="bytes" class="${state.compositionMetric === "bytes" ? "active" : ""}">Payload size</button>
        <button type="button" data-composition-metric="events" class="${state.compositionMetric === "events" ? "active" : ""}">Event count</button>
      </div>
    </div>
    <div class="session-composition-total" aria-label="Session context composition by ${metric === "bytes" ? "payload size" : "event count"}">${segments || `<span class="muted">No turn activity</span>`}</div>
    <div class="composition-legend">${TURN_CATEGORY_KEYS.map((key, index) => {
      const percent = totalComposition ? Math.round(totals[index] / totalComposition * 100) : 0;
      const valueLabel = metric === "bytes" ? formatBytes(totals[index]) : `${formatNumber(totals[index])} events`;
      return `<span title="${escapeAttr(`${TURN_CATEGORY_LABELS[key]} · ${valueLabel}`)}"><i class="category-${key}"></i>${escapeHtml(TURN_CATEGORY_LABELS[key])}<strong>${percent}%</strong></span>`;
    }).join("")}</div>
  `;
}

function renderCompositionBar(turn, showLabels = false) {
  const values = TURN_CATEGORY_KEYS.map((key) => Number(turn.composition?.[key]?.[state.compositionMetric] || 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total) {
    return `<span class="composition-empty">No content</span>`;
  }
  return `<span class="composition-bar" aria-label="Turn composition by ${state.compositionMetric === "bytes" ? "payload size" : "event count"}">${TURN_CATEGORY_KEYS.map((key, index) => {
    const percent = values[index] / total * 100;
    if (!percent) {
      return "";
    }
    const label = showLabels && percent >= 10 ? `${Math.round(percent)}%` : "";
    return `<span class="composition-segment category-${key}" style="width:${percent.toFixed(2)}%" title="${escapeAttr(`${TURN_CATEGORY_LABELS[key]} ${Math.round(percent)}%`)}">${label}</span>`;
  }).join("")}</span>`;
}

function filteredTurns() {
  if (!state.query) {
    return state.turns;
  }
  return state.turns.filter((turn) => [turn.id, turn.userMessage, turn.assistantMessage, ...(turn.toolNames || [])]
    .join(" ").toLowerCase().includes(state.query));
}

function selectedTurn() {
  return state.turns.find((turn) => turn.id === state.selectedTurnId) || null;
}

function categoryCount(turn, keys) {
  return keys.reduce((sum, key) => sum + Number(turn.composition?.[key]?.events || 0), 0);
}

function turnNumber(turn) {
  const chronological = [...state.turns].reverse();
  const index = chronological.findIndex((candidate) => candidate.id === turn.id);
  return index >= 0 ? `T${String(index + 1).padStart(2, "0")}` : "Turn";
}

function buildSessionHandoff() {
  const chronological = [...state.turns].reverse();
  const selectedIndex = chronological.findIndex((turn) => turn.id === state.selectedTurnId);
  const endIndex = selectedIndex >= 0 ? selectedIndex : chronological.length - 1;
  const included = chronological.slice(0, endIndex + 1);
  const current = included.at(-1) || null;
  const objective = handoffObjective(included);
  const tools = [...new Set(included.flatMap((turn) => turn.toolNames || []))];
  const cwd = state.session?.cwd || "Unknown — ask the user or inspect the target environment";
  const sessionId = state.session?.id || formatFileId(state.selectedFile) || "Unknown";
  const scope = current ? `${turnLabelForIndex(endIndex)} (${included.length} turns)` : "No captured turns";
  const turnSummaries = included.map((turn, index) => {
    const lines = [
      `### ${turnLabelForIndex(index)} · ${formatTimeOnly(turn.startTime)} · ${turn.status}`,
      `- 用户请求：${handoffText(turn.userMessage || "未捕获")}`,
    ];
    if (turn.assistantMessage) {
      lines.push(`- Agent 结果：${handoffText(turn.assistantMessage)}`);
    }
    if (turn.toolNames?.length) {
      lines.push(`- 使用工具：${turn.toolNames.join(", ")}`);
    }
    return lines.join("\n");
  }).join("\n\n");

  return `请接手并继续处理以下任务。此内容可独立使用，不依赖原会话。\n\n目标：\n- ${handoffText(objective || "根据下方 Turn 摘要确认下一步")}`
    + `\n\n工作区：\n- cwd: ${cwd}\n- session_id: ${sessionId}\n- source_file: ${state.selectedFile || "Unknown"}`
    + `\n\n交接范围：\n- 截止 ${scope}`
    + `\n\n当前状态：\n- ${handoffText(current?.assistantMessage || "当前 Turn 尚未捕获 Agent 最终回复，请先检查工作区现状。")}`
    + `\n- 已使用工具：${tools.length ? tools.join(", ") : "未记录"}`
    + `\n\nTurn 摘要：\n\n${turnSummaries || "无可用 Turn 摘要。"}`
    + `\n\n下一步：\n1. 先检查 cwd 中的当前文件和运行状态。\n2. 从“目标”和最后一个 Turn 继续，不要重复已明确完成的工作。`
    + `\n\n注意事项：\n- 此交接包不包含 Git state、系统/开发者指令、内部 reasoning、密钥或完整原始工具日志。\n- 事实与推断请重新区分；历史路径、URL 和运行状态可能已经变化。`
    + `\n\n期望输出：\n- 直接推进当前目标，并报告完成内容、验证结果和仍需决策的问题。`;
}

function turnLabelForIndex(index) {
  return `T${String(index + 1).padStart(2, "0")}`;
}

function handoffText(value) {
  return oneLine(String(value || ""), 600);
}

function handoffObjective(turns) {
  const acknowledgment = /^(好|好的|可以|行|嗯|ok|okay|执行|继续|做吧|就这样|没问题)[。！!]*$/i;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const message = String(turns[index]?.userMessage || "").trim();
    if (message && !acknowledgment.test(message)) {
      return message;
    }
  }
  return turns.at(-1)?.userMessage || "";
}

function updateLiveTurn(item) {
  const record = item.record || {};
  const payloadType = getByPath(record, "payload.type");
  const turnId = getByPath(record, "payload.turn_id") || getByPath(record, "turn_id");
  if (payloadType === "task_started") {
    return;
  }
  const turn = state.turns.find((candidate) => candidate.id === turnId)
    || state.turns.find((candidate) => candidate.status === "live");
  if (!turn) {
    return;
  }
  turn.eventCount += 1;
  turn.endLine = item.lineNo;
  turn.endOffset = item.nextOffset;
  turn.endTime = record.timestamp || turn.endTime;
  const category = turnCategory(record);
  if (category) {
    turn.contentEventCount += 1;
    turn.composition[category].events += 1;
    turn.composition[category].bytes += new TextEncoder().encode(item.rawLine || JSON.stringify(record)).length;
  }
}

function turnCategory(record) {
  const type = record.type || "";
  const payloadType = getByPath(record, "payload.type") || "";
  const role = getByPath(record, "payload.role") || "";
  if (payloadType === "user_message" || (payloadType === "message" && role === "user")) return "requirement";
  if (type === "turn_context" || type === "world_state" || (payloadType === "message" && ["system", "developer"].includes(role))) return "system";
  if (["tool_search_output", "web_search_end", "mcp_tool_call_end"].includes(payloadType)) return "retrieved";
  if (["reasoning", "agent_reasoning"].includes(payloadType)) return "reasoning";
  if (["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "tool_search_call", "patch_apply_begin", "patch_apply_end"].includes(payloadType)) return "tools";
  if (payloadType === "agent_message" || (payloadType === "message" && role === "assistant")) return "assistant";
  return null;
}

function scrollSelectedTurnIntoView(options) {
  if (options.preserveScroll || !state.autoScroll || !state.selectedTurnId) {
    return;
  }
  const selected = el.eventStream.querySelector(`[data-turn-id="${CSS.escape(state.selectedTurnId)}"]`);
  selected?.scrollIntoView({ block: "nearest" });
}

function appendOrRender(item) {
  if (!matchesQuery(item)) {
    return;
  }
  if (state.eventOrder === "latest-top") {
    renderEvents({ preserveScroll: !state.autoScroll });
    return;
  }
  if (el.eventStream.querySelector(".empty-state")) {
    renderEvents();
    return;
  }
  el.eventStream.insertAdjacentHTML("beforeend", renderEvent(item));
  scrollIfNeeded();
}

function renderEvent(item) {
  const record = item.record || {};
  const selected = state.selectedLineNo === item.lineNo ? " selected" : "";
  const className = item.error ? `event-card error${selected}` : `event-card${selected}`;

  return `
    <article class="${className}" data-line="${item.lineNo}" data-select-line="${item.lineNo}">
      ${renderSemanticEvent(item, record)}
    </article>
  `;
}

function renderSemanticEvent(item, record) {
  const semantic = describeEvent(item, record);
  return `
    <div class="event-header">
      <div class="event-title">
        <span class="time-chip">${escapeHtml(formatTimestamp(record.timestamp))}</span>
        <span class="kind-chip ${escapeAttr(semantic.kind)}">${escapeHtml(semantic.label)}</span>
        ${item.error ? `<span class="badge error">parse error</span>` : `<span class="line-chip">line ${item.lineNo}</span>`}
        <span class="event-summary">${escapeHtml(semantic.summary)}</span>
      </div>
      <div class="event-actions">
        <button class="copy-event" type="button" data-select-line="${item.lineNo}">Inspect</button>
        <button class="copy-event" type="button" data-copy-full="${item.lineNo}">JSON</button>
      </div>
    </div>
  `;
}

function renderEventDetails(item, record) {
  const fields = eventFields(record);
  return `
    <div class="event-body">
      ${fields.map(([path, value]) => renderField(item, path, value)).join("")}
    </div>
  `;
}

function renderInspector() {
  if (state.viewMode === "turns") {
    renderTurnInspector();
    return;
  }
  const item = selectedItem();
  renderInspectorTabs();
  if (!item) {
    el.inspectorStatus.textContent = "Select an event";
    el.inspectorContent.innerHTML = `<div class="empty-state">Click any event to inspect its JSONL structure.</div>`;
    return;
  }

  const semantic = describeEvent(item, item.record || {});
  el.inspectorStatus.textContent = `${semantic.label} · line ${item.lineNo}`;
  if (state.inspectorTab === "structured") {
    el.inspectorContent.innerHTML = renderStructuredInspector(item);
  } else if (state.inspectorTab === "raw") {
    el.inspectorContent.innerHTML = renderRawInspector(item);
  } else if (state.inspectorTab === "related") {
    el.inspectorContent.innerHTML = renderRelatedInspector(item);
  } else {
    el.inspectorContent.innerHTML = renderSummaryInspector(item, semantic);
  }
}

function renderTurnInspector() {
  const turn = selectedTurn();
  renderInspectorTabs();
  if (!turn) {
    el.inspectorStatus.textContent = "Select a turn";
    el.inspectorContent.innerHTML = `<div class="empty-state">Choose a conversation turn to inspect its context.</div>`;
    return;
  }

  const phaseRecords = turnRecordsForInspector(turn);
  const phaseStatus = state.turnPhaseFilter
    ? ` · ${turnPhaseLabel(state.turnPhaseFilter)}${phaseRecords ? ` (${formatNumber(phaseRecords.length)})` : ""}`
    : "";
  el.inspectorStatus.textContent = `${turnNumber(turn)} · ${formatShortTime(turn.startTime)} · ${turn.status}${phaseStatus}`;
  if (state.inspectorTab === "structured") {
    renderTurnStructuredInspector(turn);
  } else if (state.inspectorTab === "raw") {
    renderTurnRawInspector(turn);
  } else if (state.inspectorTab === "related") {
    el.inspectorContent.innerHTML = state.turnPhaseFilter
      ? renderTurnPhaseRelatedInspector(turn)
      : renderAdjacentTurns(turn);
  } else {
    el.inspectorContent.innerHTML = state.turnPhaseFilter
      ? renderTurnPhaseSummaryInspector(turn)
      : renderTurnSummaryInspector(turn);
  }
}

function turnRecordsForInspector(turn) {
  const records = state.turnRecords.get(turn.id);
  if (!records) {
    return null;
  }
  return state.turnPhaseFilter
    ? records.filter((item) => phaseMatchesRecord(state.turnPhaseFilter, item.record || {}))
    : records;
}

function turnPhaseLabel(phase) {
  return {
    input: "Input context",
    reasoning: "Agent work",
    tools: "Tool calls",
    assistant: "Final answer",
  }[phase] || phase;
}

function renderTurnPhaseFilterNote(records) {
  if (!state.turnPhaseFilter) {
    return "";
  }
  return `<div class="raw-filter-note"><span>${escapeHtml(turnPhaseLabel(state.turnPhaseFilter))} · ${formatNumber(records.length)} events</span><button type="button" data-clear-turn-phase>Clear</button></div>`;
}

function renderTurnPhaseSummaryInspector(turn) {
  const records = turnRecordsForInspector(turn);
  if (!records) {
    return `
      <div class="empty-state">
        <p>Load this turn's records to inspect ${escapeHtml(turnPhaseLabel(state.turnPhaseFilter))}.</p>
        <button type="button" data-load-turn-events="${escapeAttr(turn.id)}">Load phase records</button>
      </div>
    `;
  }
  const payloadBytes = records.reduce((sum, item) => sum + new TextEncoder().encode(item.rawLine || JSON.stringify(item.record || {})).length, 0);
  const eventTypes = new Map();
  const tools = new Set();
  let toolCalls = 0;
  let toolOutputs = 0;
  for (const item of records) {
    const record = item.record || {};
    const payloadType = String(getByPath(record, "payload.type") || record.type || "unknown");
    eventTypes.set(payloadType, (eventTypes.get(payloadType) || 0) + 1);
    if (["function_call", "custom_tool_call", "tool_search_call"].includes(payloadType)) {
      toolCalls += 1;
      const toolName = getByPath(record, "payload.name") || getByPath(record, "payload.tool_name");
      if (toolName) {
        tools.add(String(toolName));
      }
    }
    if (["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(payloadType)) {
      toolOutputs += 1;
    }
  }
  const typeSummary = [...eventTypes.entries()].sort((left, right) => right[1] - left[1]);
  return `
    <div class="turn-scope-headline">
      <span class="turn-index">${escapeHtml(turnNumber(turn))}</span>
      <span class="scope-chevron">›</span>
      <strong>${escapeHtml(turnPhaseLabel(state.turnPhaseFilter))}</strong>
      <span>${formatNumber(records.length)} events</span>
    </div>
    <section class="inspector-section">
      <div class="inspector-section-title">Selected scope <span>linked from the turn phase</span></div>
      ${renderMetricRow("Phase", turnPhaseLabel(state.turnPhaseFilter))}
      ${renderMetricRow("Events", records.length)}
      ${renderMetricRow("Payload", formatBytes(payloadBytes))}
      ${state.turnPhaseFilter === "tools" ? renderMetricRow("Tool calls", toolCalls) : ""}
      ${state.turnPhaseFilter === "tools" ? renderMetricRow("Tool outputs", toolOutputs) : ""}
      ${tools.size ? renderMetricRow("Tools", [...tools].join(", ")) : ""}
    </section>
    <section class="inspector-section">
      <div class="inspector-section-title">Event types</div>
      ${typeSummary.map(([type, count]) => renderMetricRow(type, count)).join("") || `<div class="muted">No event types captured.</div>`}
    </section>
    <section class="inspector-section">
      <div class="inspector-section-title">Records in scope <span>select one to inspect raw content</span></div>
      <div class="turn-raw-list compact">
        ${records.map((item) => renderTurnRecordLink(item)).join("") || `<div class="muted">No records in this phase.</div>`}
      </div>
    </section>
  `;
}

function renderTurnRecordLink(item) {
  const semantic = describeEvent(item, item.record || {});
  return `
    <button type="button" class="turn-raw-item" data-inspect-turn-line="${item.lineNo}">
      <span class="line-chip">${item.lineNo}</span>
      <span class="kind-chip ${escapeAttr(semantic.kind)}">${escapeHtml(semantic.label)}</span>
      <span>${escapeHtml(semantic.summary || "No summary")}</span>
    </button>
  `;
}

function renderTurnPhaseRelatedInspector(turn) {
  const records = turnRecordsForInspector(turn);
  if (!records) {
    return `<div class="empty-state">Load phase records before inspecting related entries.</div>`;
  }
  const groups = new Map();
  for (const item of records) {
    const record = item.record || {};
    const callId = getByPath(record, "payload.call_id") || getByPath(record, "call_id");
    const key = callId ? `call_id ${callId}` : (getByPath(record, "payload.type") || record.type || "other");
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }
  return `
    ${renderTurnPhaseFilterNote(records)}
    <div class="phase-related-groups">
      ${[...groups.entries()].map(([key, items]) => `
        <section class="inspector-section">
          <div class="inspector-section-title">${escapeHtml(key)} <span>${formatNumber(items.length)} records</span></div>
          <div class="turn-raw-list compact">${items.map((item) => renderTurnRecordLink(item)).join("")}</div>
        </section>
      `).join("") || `<div class="empty-state">No related records in this phase.</div>`}
    </div>
  `;
}

function renderTurnStructuredInspector(turn) {
  const records = turnRecordsForInspector(turn);
  if (!records) {
    el.inspectorContent.innerHTML = `
      <div class="empty-state">
        <p>Load this turn's ${formatNumber(turn.eventCount)} records to inspect their structure.</p>
        <button type="button" data-load-turn-events="${escapeAttr(turn.id)}">Load structured records</button>
      </div>
    `;
    return;
  }
  el.inspectorContent.innerHTML = `
    ${renderTurnPhaseFilterNote(records)}
    <div class="inspector-tree-toolbar">
      <button class="tree-action" type="button" data-tree-action="expand-all">Expand all</button>
      <button class="tree-action" type="button" data-tree-action="collapse-all">Collapse all</button>
    </div>
    <div class="json-tree turn-record-tree">
      ${records.map((item) => {
        const semantic = describeEvent(item, item.record || {});
        const selected = Number(state.selectedLineNo) === Number(item.lineNo);
        return `
          <details class="turn-record-node${selected ? " selected" : ""}"${selected ? " open" : ""}>
            <summary>
              <span class="line-chip">${item.lineNo}</span>
              <span class="kind-chip ${escapeAttr(semantic.kind)}">${escapeHtml(semantic.label)}</span>
              <span class="turn-record-summary">${escapeHtml(semantic.summary || "No summary")}</span>
            </summary>
            <div class="turn-record-content">${renderJsonTree(item.record || {}, "record", 1)}</div>
          </details>
        `;
      }).join("") || `<div class="empty-state">No records in this phase.</div>`}
    </div>
  `;
}

function renderTurnSummaryInspector(turn) {
  const metric = state.compositionMetric;
  const values = TURN_CATEGORY_KEYS.map((key) => Number(turn.composition?.[key]?.[metric] || 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const usage = turn.tokenDelta || {};
  return `
    <div class="turn-inspector-headline">
      <strong>${escapeHtml(turnNumber(turn))}</strong>
      <span>${escapeHtml(turn.userMessage || "No user message captured")}</span>
      <code>${escapeHtml(turn.id)}</code>
    </div>
    <section class="inspector-section">
      <div class="inspector-section-title">Context composition <span>by ${metric === "bytes" ? "payload size" : "event count"}</span></div>
      ${renderCompositionBar(turn)}
      <div class="composition-breakdown">
        ${TURN_CATEGORY_KEYS.map((key, index) => {
          const percent = total ? Math.round(values[index] / total * 100) : 0;
          return `<div><span><i class="category-${key}"></i>${escapeHtml(TURN_CATEGORY_LABELS[key])}</span><strong>${percent}%</strong><code>${metric === "bytes" ? formatBytes(values[index]) : formatNumber(values[index])}</code></div>`;
        }).join("")}
      </div>
    </section>
    <section class="inspector-section">
      <div class="inspector-section-title">Token usage <span>cumulative delta</span></div>
      ${renderMetricRow("Input", usage.input_tokens)}
      ${renderMetricRow("Cached input", usage.cached_input_tokens)}
      ${renderMetricRow("Output", usage.output_tokens)}
      ${renderMetricRow("Reasoning", usage.reasoning_output_tokens)}
      ${renderMetricRow("Net token delta", usage.total_tokens, true)}
      <p class="metric-note">Token deltas are independent of payload composition.</p>
    </section>
    <section class="inspector-section">
      <div class="inspector-section-title">Turn details</div>
      ${renderMetricRow("Duration", formatDuration(turn.durationMs))}
      ${renderMetricRow("Events", turn.eventCount)}
      ${renderMetricRow("Tools called", turn.toolCount)}
      ${renderMetricRow("Status", turn.status)}
    </section>
    <section class="inspector-section inspector-actions">
      <button type="button" data-open-turn-events="${escapeAttr(turn.id)}">Open raw events (${formatNumber(turn.eventCount)})</button>
      <button type="button" data-copy-turn="${escapeAttr(turn.id)}">Copy turn context</button>
    </section>
  `;
}

function renderMetricRow(label, value, strong = false) {
  const formatted = typeof value === "number" ? formatNumber(value) : String(value ?? "—");
  return `<div class="turn-metric-row${strong ? " total" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(formatted)}</strong></div>`;
}

function renderTurnRawInspector(turn) {
  const records = turnRecordsForInspector(turn);
  if (!records) {
    el.inspectorContent.innerHTML = `
      <div class="empty-state">
        <p>Load this turn's ${formatNumber(turn.eventCount)} raw events on demand.</p>
        <button type="button" data-load-turn-events="${escapeAttr(turn.id)}">Load raw events</button>
      </div>
    `;
    return;
  }
  el.inspectorContent.innerHTML = `
    ${renderTurnPhaseFilterNote(records)}
    <div class="turn-raw-list">
      ${records.map((item) => {
        const semantic = describeEvent(item, item.record || {});
        const selected = Number(state.selectedLineNo) === Number(item.lineNo);
        const raw = item.rawLine || JSON.stringify(item.record || {}, null, 2);
        return `
          <button type="button" class="turn-raw-item${selected ? " selected" : ""}" data-select-line="${item.lineNo}" aria-expanded="${selected}">
            <span class="line-chip">${item.lineNo}</span>
            <span class="kind-chip ${escapeAttr(semantic.kind)}">${escapeHtml(semantic.label)}</span>
            <span>${escapeHtml(semantic.summary || "No summary")}</span>
          </button>
          ${selected ? `
            <section class="turn-raw-detail" aria-label="Raw event line ${item.lineNo}">
              <div class="turn-raw-detail-head"><strong>Line ${item.lineNo}</strong><span>${escapeHtml(semantic.label)}</span></div>
              <pre class="raw-json">${escapeHtml(raw)}</pre>
            </section>
          ` : ""}
        `;
      }).join("") || `<div class="empty-state">No events in this phase.</div>`}
    </div>
  `;
}

function renderAdjacentTurns(turn) {
  const chronological = [...state.turns].reverse();
  const index = chronological.findIndex((candidate) => candidate.id === turn.id);
  const adjacent = [chronological[index - 1], chronological[index + 1]].filter(Boolean);
  if (!adjacent.length) {
    return `<div class="empty-state">No adjacent turns.</div>`;
  }
  return `<div class="related-list">${adjacent.map((candidate) => `
    <button class="related-item turn-related" type="button" data-select-turn="${escapeAttr(candidate.id)}">
      <span class="turn-index">${escapeHtml(turnNumber(candidate))}</span>
      <span class="turn-status ${escapeAttr(candidate.status)}">${escapeHtml(candidate.status)}</span>
      <span>${escapeHtml(oneLine(candidate.userMessage || "No user message", 120))}</span>
    </button>
  `).join("")}</div>`;
}

async function loadTurnRecords(turn) {
  if (state.turnRecords.has(turn.id)) {
    return state.turnRecords.get(turn.id);
  }
  const params = new URLSearchParams({
    date: state.selectedDate,
    file: state.selectedFile,
    start: String(turn.startOffset),
    end: String(turn.endOffset),
  });
  const data = await api(`/api/turn-events?${params.toString()}`);
  const records = data.records || [];
  state.turnRecords.set(turn.id, records);
  const merged = new Map(state.records.map((item) => [`${item.offset}:${item.lineNo}`, item]));
  for (const item of records) {
    merged.set(`${item.offset}:${item.lineNo}`, item);
  }
  state.records = [...merged.values()].sort((left, right) => left.offset - right.offset);
  return records;
}

function phaseMatchesRecord(phase, record) {
  const category = turnCategory(record);
  if (phase === "input") {
    return ["requirement", "system", "retrieved"].includes(category);
  }
  if (phase === "assistant") {
    return category === "assistant";
  }
  return category === phase;
}

function renderInspectorTabs() {
  for (const tab of el.inspectorTabs.querySelectorAll("[data-inspector-tab]")) {
    tab.classList.toggle("active", tab.dataset.inspectorTab === state.inspectorTab);
  }
}

function renderSummaryInspector(item, semantic) {
  const record = item.record || {};
  const rows = [
    ["kind", semantic.label],
    ["line", item.lineNo],
    ["timestamp", record.timestamp],
    ["type", record.type],
    ["payload.type", getByPath(record, "payload.type")],
    ["role", getByPath(record, "payload.role")],
    ["call_id", getByPath(record, "payload.call_id") || getByPath(record, "call_id")],
    ["turn_id", getByPath(record, "payload.turn_id") || getByPath(record, "turn_id")],
    ["offset", item.offset],
    ["nextOffset", item.nextOffset],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");

  return `
    <div class="inspector-summary">
      <div class="inspector-headline">${escapeHtml(semantic.summary || semantic.label)}</div>
      ${rows.map(([key, value]) => `
        <div class="inspector-row">
          <div class="inspector-key">${escapeHtml(key)}</div>
          <div class="inspector-value">${escapeHtml(valueToText(value))}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderStructuredInspector(item) {
  return `
    <div class="inspector-tree-toolbar">
      <button class="tree-action" type="button" data-tree-action="expand-all">Expand all</button>
      <button class="tree-action" type="button" data-tree-action="collapse-all">Collapse all</button>
    </div>
    <div class="json-tree">${renderJsonTree(item.record || {}, "record", 0)}</div>
  `;
}

function renderRawInspector(item) {
  const raw = item.rawLine || JSON.stringify(item.record || {}, null, 2);
  return `<pre class="raw-json">${escapeHtml(raw)}</pre>`;
}

function renderRelatedInspector(item) {
  const related = findRelatedEvents(item);
  if (!related.length) {
    return `<div class="empty-state">No related events found by call_id or turn_id.</div>`;
  }
  return `
    <div class="related-list">
      ${related.map((relatedItem) => {
        const semantic = describeEvent(relatedItem, relatedItem.record || {});
        return `
          <button class="related-item" type="button" data-select-line="${relatedItem.lineNo}">
            <span class="line-chip">line ${relatedItem.lineNo}</span>
            <span class="kind-chip ${escapeAttr(semantic.kind)}">${escapeHtml(semantic.label)}</span>
            <span>${escapeHtml(semantic.summary)}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderJsonTree(value, label, depth) {
  if (value === null || typeof value !== "object") {
    return `<div class="json-leaf"><span class="json-key">${escapeHtml(label)}</span><span class="json-value">${renderRichValue(value)}</span></div>`;
  }
  const entries = Array.isArray(value) ? value.map((child, index) => [String(index), child]) : Object.entries(value);
  const open = depth < 2 ? " open" : "";
  return `
    <details class="json-node"${open}>
      <summary><span class="json-key">${escapeHtml(label)}</span><span class="json-count">${Array.isArray(value) ? `${entries.length} items` : `${entries.length} keys`}</span></summary>
      <div class="json-children">
        ${entries.map(([key, child]) => renderJsonTree(child, key, depth + 1)).join("")}
      </div>
    </details>
  `;
}

function eventFields(record) {
  const rows = [];
  for (const field of state.fields) {
    const value = getByPath(record, field);
    if (value !== undefined) {
      rows.push([field, value]);
    }
  }
  if (!rows.length) {
    rows.push(["record", record]);
  }
  return rows;
}

function describeEvent(item, record) {
  if (item.error) {
    return { kind: "errors", label: "Parse Error", summary: item.error };
  }

  const type = record.type || "";
  const payloadType = getByPath(record, "payload.type") || "";
  const role = getByPath(record, "payload.role");
  const toolName = getByPath(record, "payload.name") || getByPath(record, "payload.tool_name") || getByPath(record, "payload.call_name");

  if (payloadType === "token_count" || type === "token_count") {
    const total = getByPath(record, "payload.info.total_token_usage.total_tokens");
    const primary = getByPath(record, "payload.info.rate_limits.primary.used_percent");
    return { kind: "tokens", label: "Token", summary: oneLine(`total ${total ?? "-"} · primary ${primary ?? "-"}%`, 140) };
  }

  if (payloadType && String(payloadType).includes("patch")) {
    return { kind: "patches", label: "Patch", summary: summarizePatch(record) };
  }

  if (type === "function_call" || payloadType === "function_call" || payloadType === "custom_tool_call") {
    return { kind: "tools", label: "Tool Call", summary: oneLine(`${toolName || "tool"} ${valueToText(getByPath(record, "payload.arguments") || getByPath(record, "payload.input") || "")}`, 180) };
  }

  if (type === "function_call_output" || payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
    return { kind: "tools", label: "Tool Output", summary: summarizeRecord(record) };
  }

  if (type === "response_item" && payloadType === "message") {
    return { kind: "messages", label: role ? `Message · ${role}` : "Message", summary: summarizeMessage(record) };
  }

  if (type === "event_msg" && payloadType === "user_message") {
    return { kind: "messages", label: "User", summary: summarizeRecord(record) };
  }

  if (type === "event_msg" && payloadType === "agent_message") {
    return { kind: "messages", label: "Assistant", summary: summarizeRecord(record) };
  }

  if (type === "session_meta" || type === "turn_context") {
    return { kind: "context", label: titleCase(type), summary: summarizeRecord(record) };
  }

  if (JSON.stringify(record).toLowerCase().includes("error")) {
    return { kind: "errors", label: [type, payloadType].filter(Boolean).join(" / ") || "Error", summary: summarizeRecord(record) };
  }

  return {
    kind: "context",
    label: [type, payloadType].filter(Boolean).join(" / ") || "Event",
    summary: summarizeRecord(record),
  };
}

function renderField(item, path, value) {
  const key = `${item.lineNo}:${path}`;
  const focused = state.fields.has(path);
  const expanded = focused || state.expanded.has(key);
  const rendered = renderValue(value, expanded, key);
  return `
    <div class="field-row">
      <div class="field-key">${escapeHtml(path)}</div>
      <div class="field-value">${rendered}</div>
    </div>
  `;
}

function renderValue(value, expanded, key) {
  const text = valueToText(value);
  const isLong = text.length > state.truncateAfter;
  const shouldPre = expanded || text.includes("\n") || typeof value === "object";
  if (!expanded && isLong) {
    const preview = text.slice(0, state.truncateAfter);
    return `${escapeHtml(preview)} <span class="muted">${text.length} chars ...</span><button class="inline-action" type="button" data-expand="${escapeAttr(key)}">+</button>`;
  }
  if (expanded) {
    return `<div class="rich-value">${renderRichValue(value)}</div>${isLong ? `<button class="inline-action" type="button" data-collapse="${escapeAttr(key)}">Collapse</button>` : ""}`;
  }
  if (shouldPre) {
    return `<pre>${escapeHtml(text)}</pre>${isLong ? `<button class="inline-action" type="button" data-collapse="${escapeAttr(key)}">Collapse</button>` : ""}`;
  }
  return escapeHtml(text);
}

function renderRichValue(value) {
  if (value === null || value === undefined) {
    return `<span class="json-scalar muted">${escapeHtml(valueToText(value))}</span>`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `<span class="json-scalar">${escapeHtml(String(value))}</span>`;
  }
  if (typeof value === "object") {
    return `<div class="rich-json">${renderJsonTree(value, "value", 0)}</div>`;
  }

  const text = String(value);
  const embedded = parseEmbeddedJsonText(text);
  if (embedded) {
    return `
      <details class="rich-embedded-json" open>
        <summary>Parsed JSON string</summary>
        <div class="rich-json">${renderJsonTree(embedded, "value", 0)}</div>
      </details>
    `;
  }

  const normalized = normalizeEscapedText(text);
  if (shouldRenderRichMarkdown(normalized)) {
    return renderRichMarkdown(normalized);
  }

  return `<span class="json-scalar">${escapeHtml(text)}</span>`;
}

function parseEmbeddedJsonText(text) {
  const trimmed = String(text).trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeEscapedText(text) {
  const raw = String(text);
  const escapedBreaks = (raw.match(/\\n/g) || []).length;
  const realBreaks = (raw.match(/\n/g) || []).length;
  if (escapedBreaks <= realBreaks) {
    return raw;
  }
  return raw
    .replaceAll("\\r\\n", "\n")
    .replaceAll("\\n", "\n")
    .replaceAll("\\t", "\t")
    .replaceAll('\\"', '"');
}

function shouldRenderRichMarkdown(text) {
  return text.includes("\n")
    || text.includes("```")
    || /^#{1,6}\s+/m.test(text)
    || /^\s*[-*]\s+\S/m.test(text);
}

function renderRichMarkdown(text) {
  const normalized = String(text);
  const blocks = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match;
  while ((match = fence.exec(normalized)) !== null) {
    if (match.index > cursor) {
      blocks.push(renderRichMarkdownText(normalized.slice(cursor, match.index)));
    }
    const language = match[1].trim();
    const code = match[2].replace(/^\n/, "").replace(/\n$/, "");
    blocks.push(`
      <div class="rich-code-shell">
        ${language ? `<div class="rich-code-meta">${escapeHtml(language)}</div>` : ""}
        <pre class="rich-code-block"><code>${escapeHtml(code)}</code></pre>
      </div>
    `);
    cursor = fence.lastIndex;
  }
  if (cursor < normalized.length) {
    blocks.push(renderRichMarkdownText(normalized.slice(cursor)));
  }
  return `<div class="rich-markdown">${blocks.join("")}</div>`;
}

function renderRichMarkdownText(text) {
  const lines = String(text).split("\n");
  const output = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }
    output.push(`<p>${paragraph.map((line) => renderInlineRichText(line)).join("<br>")}</p>`);
    paragraph = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (!line.trim()) {
      flushParagraph();
    } else if (heading) {
      flushParagraph();
      output.push(`<div class="rich-heading level-${heading[1].length}">${renderInlineRichText(heading[2])}</div>`);
    } else if (listItem) {
      flushParagraph();
      output.push(`<div class="rich-list-item">${renderInlineRichText(listItem[1])}</div>`);
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();
  return output.join("");
}

function renderInlineRichText(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
}

function collectFields() {
  state.discoveredFields = new Set();
  for (const item of state.records) {
    collectFieldsFromRecord(item.record);
  }
}

function collectFieldsFromRecord(record) {
  for (const field of extractFieldPaths(record)) {
    state.discoveredFields.add(field);
  }
}

function extractFieldPaths(value, prefix = "", depth = 0, output = new Set()) {
  if (depth > 5 || value === null || value === undefined) {
    return output;
  }
  if (Array.isArray(value)) {
    if (prefix) {
      output.add(prefix);
    }
    for (const item of value.slice(0, 3)) {
      extractFieldPaths(item, prefix ? `${prefix}.*` : "*", depth + 1, output);
    }
    return output;
  }
  if (typeof value !== "object") {
    if (prefix) {
      output.add(prefix);
    }
    return output;
  }
  if (prefix) {
    output.add(prefix);
  }
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    extractFieldPaths(child, next, depth + 1, output);
  }
  return output;
}

function getByPath(value, path) {
  const parts = path.split(".");
  let current = value;
  for (const part of parts) {
    if (part === "*") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current.map((item) => item).filter((item) => item !== undefined);
      continue;
    }
    if (Array.isArray(current)) {
      current = current.map((item) => item?.[part]).filter((item) => item !== undefined);
    } else {
      current = current?.[part];
    }
    if (current === undefined || current === null) {
      return current;
    }
  }
  return current;
}

function filteredRecords() {
  return state.records.filter((item) => matchesQuery(item) && matchesFilter(item));
}

function orderedRecords(records) {
  if (state.eventOrder === "latest-top") {
    return [...records].reverse();
  }
  return records;
}

function matchesFilter(item) {
  if (state.eventFilter === "all") {
    return true;
  }
  return describeEvent(item, item.record || {}).kind === state.eventFilter;
}

function matchesQuery(item) {
  if (!state.query) {
    return true;
  }
  return JSON.stringify(item.record || {}).toLowerCase().includes(state.query);
}

function selectedItem() {
  return state.records.find((item) => item.lineNo === state.selectedLineNo);
}

function findRelatedEvents(item) {
  const ids = relationIds(item.record || {});
  if (!ids.size) {
    return [];
  }
  return state.records.filter((candidate) => {
    if (candidate.lineNo === item.lineNo) {
      return false;
    }
    for (const id of relationIds(candidate.record || {})) {
      if (ids.has(id)) {
        return true;
      }
    }
    return false;
  });
}

function relationIds(record) {
  const ids = new Set();
  for (const path of ["call_id", "turn_id", "payload.call_id", "payload.turn_id"]) {
    const value = getByPath(record, path);
    if (value) {
      ids.add(String(value));
    }
  }
  return ids;
}

function formatTimestamp(value) {
  if (!value) {
    return "no time";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleTimeString();
}

function formatShortTime(value) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) {
    return "—";
  }
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function formatNumber(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat("en-US", { notation: number >= 100000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(number);
}

function formatDelta(value) {
  const number = Number(value || 0);
  return `${number >= 0 ? "+" : ""}${formatNumber(number)}`;
}

function summarizeRecord(record) {
  const candidates = [
    getByPath(record, "payload.output"),
    getByPath(record, "payload.cwd"),
    getByPath(record, "payload.input"),
    getByPath(record, "payload.message"),
    getByPath(record, "payload.role"),
    getByPath(record, "payload.model"),
    getByPath(record, "payload.originator"),
    getByPath(record, "payload.metadata.exit_code"),
    getByPath(record, "payload.info.total_token_usage.total_tokens"),
  ];
  const value = candidates.find((item) => item !== undefined && item !== null && valueToText(item).trim());
  if (value === undefined) {
    return "";
  }
  return oneLine(valueToText(value), 140);
}

function summarizeMessage(record) {
  const content = getByPath(record, "payload.content") || getByPath(record, "payload.text") || getByPath(record, "payload.output");
  if (Array.isArray(content)) {
    return oneLine(content.map((item) => valueToText(item.text || item.content || item)).join(" "), 180);
  }
  return oneLine(valueToText(content || summarizeRecord(record)), 180);
}

function summarizePatch(record) {
  const changes = getByPath(record, "payload.changes");
  if (changes && typeof changes === "object") {
    return oneLine(Object.keys(changes).join(", "), 180);
  }
  return summarizeRecord(record);
}

function titleCase(value) {
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function oneLine(value, limit) {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)} ...`;
}

function valueToText(value) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function formatBytes(value) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatFileName(name) {
  const match = name.match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)\.jsonl$/);
  if (!match) {
    return name;
  }
  return match[1].replace("T", " ");
}

function formatFileId(name) {
  const match = name.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/);
  return match ? match[1] : "";
}

function formatTimeOnly(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return escapeHtml(value);
  }
  return date.toLocaleTimeString();
}

function setStatus(text) {
  el.streamStatus.textContent = text;
}

function scrollIfNeeded() {
  if (state.autoScroll) {
    el.eventStream.scrollTop = state.eventOrder === "latest-top" ? 0 : el.eventStream.scrollHeight;
  }
}

function preserveScrollPosition(callback) {
  const scrollTop = el.eventStream.scrollTop;
  callback();
  el.eventStream.scrollTop = scrollTop;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function readInspectorWidth() {
  try {
    const stored = Number(localStorage.getItem(INSPECTOR_WIDTH_STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= MIN_INSPECTOR_WIDTH) {
      return stored;
    }
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
  return DEFAULT_INSPECTOR_WIDTH;
}

function setInspectorWidth(width, persist = true) {
  const clamped = clampInspectorWidth(width);
  state.inspectorWidth = clamped;
  el.mainLayout.style.setProperty("--inspector-width", `${clamped}px`);
  if (persist) {
    try {
      localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(clamped));
    } catch {
      // Width persistence is a convenience; the viewer should still work without it.
    }
  }
  return clamped;
}

function clampInspectorWidth(width) {
  const requested = Number(width);
  const safeWidth = Number.isFinite(requested) ? requested : DEFAULT_INSPECTOR_WIDTH;
  const layoutWidth = el.mainLayout.getBoundingClientRect().width || window.innerWidth || 1400;
  const maxWidth = Math.max(
    MIN_INSPECTOR_WIDTH,
    layoutWidth - SIDEBAR_WIDTH - RESIZE_HANDLE_WIDTH - MIN_STREAM_WIDTH,
  );
  return Math.round(Math.min(Math.max(safeWidth, MIN_INSPECTOR_WIDTH), maxWidth));
}

function readTailVariant() {
  try {
    const stored = localStorage.getItem(TAIL_VARIANT_STORAGE_KEY);
    if (TAIL_VARIANTS.some((variant) => variant.key === stored)) {
      return stored;
    }
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
  return TAIL_VARIANTS[0].key;
}

function setTailVariant(key) {
  const variant = tailVariant(key);
  state.tailVariant = variant.key;
  try {
    localStorage.setItem(TAIL_VARIANT_STORAGE_KEY, variant.key);
  } catch {
    // Variant persistence is a convenience; the viewer should still work without it.
  }
  renderTailMenu();
}

function tailVariant(key) {
  return TAIL_VARIANTS.find((variant) => variant.key === key) || TAIL_VARIANTS[0];
}

function activeFilePath() {
  if (!state.selectedFile) {
    return "";
  }
  const known = state.files.find((file) => file.name === state.selectedFile);
  if (known?.path) {
    return known.path;
  }
  const parts = String(state.selectedDate || "").split("-");
  if (!state.root || parts.length !== 3) {
    return "";
  }
  return [state.root.replace(/\/+$/, ""), ...parts, state.selectedFile].join("/");
}

function shellQuotePath(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9._/@:+-]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function tailCommand(key) {
  const filePath = activeFilePath();
  if (!filePath) {
    return "";
  }
  const variant = tailVariant(key);
  const command = `tail ${variant.args} ${shellQuotePath(filePath)}`;
  return variant.jq === false ? command : `${command} | ${TAIL_JQ_SUFFIX}`;
}

function renderTailMenu() {
  el.copyTailMenu.innerHTML = TAIL_VARIANTS.map((variant) => {
    const active = variant.key === state.tailVariant ? " active" : "";
    return `
      <button class="split-menu-item${active}" type="button" role="menuitem" data-tail-variant="${escapeAttr(variant.key)}">
        ${escapeHtml(variant.label)}
      </button>
    `;
  }).join("");
  const command = tailCommand(state.tailVariant);
  el.copyTailButton.title = command || "Select a rollout file to build a tail command";
}

function setTailMenuOpen(open) {
  el.copyTailMenu.hidden = !open;
  el.copyTailMenuButton.setAttribute("aria-expanded", String(open));
  el.copyTailGroup.classList.toggle("open", open);
}

async function copyTailCommand(key) {
  const variant = tailVariant(key);
  const command = tailCommand(variant.key);
  if (!command) {
    setStatus("No rollout file selected");
    return;
  }
  try {
    await copyText(command, `Tail command copied · ${variant.label}`);
  } catch {
    setStatus("Copy failed · copy the command manually");
    window.prompt("Copy this tail command:", command);
  }
}

function setFileActionsEnabled(enabled) {
  el.copyHandoffButton.disabled = !enabled;
  el.copyTailButton.disabled = !enabled;
  el.copyTailMenuButton.disabled = !enabled;
  if (!enabled) {
    setTailMenuOpen(false);
  }
  renderTailMenu();
}

function initResizableInspector() {
  if (!el.inspectorResizeHandle) {
    return;
  }

  el.inspectorResizeHandle.addEventListener("pointerdown", startInspectorResize);
  el.inspectorResizeHandle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    setInspectorWideMode(false);
    const delta = event.key === "ArrowLeft" ? 32 : -32;
    setInspectorWidth(state.inspectorWidth + delta);
  });
  window.addEventListener("resize", () => {
    setInspectorWidth(state.inspectorWidth, false);
  });
}

function startInspectorResize(event) {
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  setInspectorWideMode(false);
  el.mainLayout.classList.add("resizing");
  resizeInspectorFromPointer(event);
  el.inspectorResizeHandle.setPointerCapture(event.pointerId);

  const stopResize = () => {
    el.mainLayout.classList.remove("resizing");
    el.inspectorResizeHandle.removeEventListener("pointermove", resizeInspectorFromPointer);
    try {
      el.inspectorResizeHandle.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  };

  el.inspectorResizeHandle.addEventListener("pointermove", resizeInspectorFromPointer);
  el.inspectorResizeHandle.addEventListener("pointerup", stopResize, { once: true });
  el.inspectorResizeHandle.addEventListener("pointercancel", stopResize, { once: true });
}

function resizeInspectorFromPointer(event) {
  const layoutRect = el.mainLayout.getBoundingClientRect();
  setInspectorWidth(layoutRect.right - event.clientX);
}

function setInspectorWideMode(enabled) {
  state.inspectorWide = enabled;
  el.mainLayout.classList.toggle("inspector-wide", enabled);
  el.inspectorWideButton.textContent = enabled ? "Normal" : "Wide";
}

el.fileList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-file]");
  if (!button) {
    return;
  }
  state.selectedFile = button.dataset.file;
  await loadInitial();
});

el.viewTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (!button || button.dataset.view === state.viewMode) {
    return;
  }
  state.viewMode = button.dataset.view;
  state.query = "";
  el.searchInput.value = "";
  state.inspectorTab = "summary";
  state.turnPhaseFilter = "";
  renderViewMode();
  renderEvents();
  renderInspector();
});

el.turnControls.addEventListener("click", (event) => {
  const density = event.target.closest("[data-turn-density]");
  if (!density) {
    return;
  }
  state.turnDensity = density.dataset.turnDensity;
  renderViewMode();
  renderEvents({ preserveScroll: true });
});

el.turnOverview.addEventListener("click", (event) => {
  const metric = event.target.closest("[data-composition-metric]");
  if (!metric) {
    return;
  }
  state.compositionMetric = metric.dataset.compositionMetric;
  renderEvents({ preserveScroll: true });
  renderInspector();
});

el.copyHandoffButton.addEventListener("click", async () => {
  await copyText(buildSessionHandoff(), `Handoff copied · ${formatNumber(state.turns.length)} turns`);
});

el.copyTailButton.addEventListener("click", async () => {
  setTailMenuOpen(false);
  await copyTailCommand(state.tailVariant);
});

el.copyTailMenuButton.addEventListener("click", () => {
  setTailMenuOpen(el.copyTailMenu.hidden);
});

el.copyTailMenu.addEventListener("click", async (event) => {
  const item = event.target.closest("[data-tail-variant]");
  if (!item) {
    return;
  }
  setTailVariant(item.dataset.tailVariant);
  setTailMenuOpen(false);
  await copyTailCommand(state.tailVariant);
});

document.addEventListener("click", (event) => {
  if (!el.copyTailMenu.hidden && !el.copyTailGroup.contains(event.target)) {
    setTailMenuOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.copyTailMenu.hidden) {
    setTailMenuOpen(false);
    el.copyTailMenuButton.focus();
  }
});

el.eventStream.addEventListener("click", async (event) => {
  const selectTurn = event.target.closest("[data-select-turn]");
  const turnPhase = event.target.closest("[data-turn-phase]");
  const expand = event.target.closest("[data-expand]");
  const collapse = event.target.closest("[data-collapse]");
  const selectLine = event.target.closest("[data-select-line]");
  const copyFull = event.target.closest("[data-copy-full]");
  if (turnPhase) {
    const turn = state.turns.find((candidate) => candidate.id === turnPhase.dataset.turnId);
    if (!turn) {
      return;
    }
    state.selectedTurnId = turn.id;
    state.turnPhaseFilter = turnPhase.dataset.turnPhase;
    state.selectedLineNo = null;
    state.inspectorTab = "raw";
    await loadTurnRecords(turn);
    renderEvents({ preserveScroll: true });
    renderInspector();
  } else if (selectTurn) {
    const turnId = selectTurn.dataset.selectTurn;
    const alreadyExpanded = state.expandedTurns.has(turnId);
    state.selectedTurnId = turnId;
    state.selectedLineNo = null;
    state.expandedTurns = alreadyExpanded ? new Set() : new Set([turnId]);
    state.turnPhaseFilter = "";
    state.inspectorTab = "summary";
    renderEvents({ preserveScroll: true });
    renderInspector();
  } else if (expand) {
    state.expanded.add(expand.dataset.expand);
    renderEvents({ preserveScroll: true });
  } else if (collapse) {
    state.expanded.delete(collapse.dataset.collapse);
    renderEvents({ preserveScroll: true });
  } else if (copyFull) {
    const item = state.records.find((record) => String(record.lineNo) === copyFull.dataset.copyFull);
    await copyText(JSON.stringify(item?.record || {}, null, 2));
  } else if (selectLine) {
    state.selectedLineNo = Number(selectLine.dataset.selectLine);
    renderEvents({ preserveScroll: true });
    renderInspector();
  }
});

el.eventFilterBar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) {
    return;
  }
  state.eventFilter = button.dataset.filter;
  for (const item of el.eventFilterBar.querySelectorAll("[data-filter]")) {
    item.classList.toggle("active", item === button);
  }
  renderEvents();
});

el.inspectorTabs.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-inspector-tab]");
  if (!button) {
    return;
  }
  state.inspectorTab = button.dataset.inspectorTab;
  const turn = selectedTurn();
  if (state.viewMode === "turns" && turn && ["structured", "raw"].includes(state.inspectorTab) && !state.turnRecords.has(turn.id)) {
    await loadTurnRecords(turn);
  }
  renderInspector();
});

el.inspectorWideButton.addEventListener("click", () => {
  toggleInspectorWide();
});

function toggleInspectorWide() {
  const next = !state.inspectorWide;
  setInspectorWideMode(next);
  setInspectorWidth(next ? WIDE_INSPECTOR_WIDTH : DEFAULT_INSPECTOR_WIDTH);
}

el.inspectorContent.addEventListener("click", (event) => {
  const treeAction = event.target.closest("[data-tree-action]");
  const selectLine = event.target.closest("[data-select-line]");
  const selectTurn = event.target.closest("[data-select-turn]");
  const loadTurn = event.target.closest("[data-load-turn-events]");
  const openTurn = event.target.closest("[data-open-turn-events]");
  const copyTurn = event.target.closest("[data-copy-turn]");
  const clearPhase = event.target.closest("[data-clear-turn-phase]");
  const inspectTurnLine = event.target.closest("[data-inspect-turn-line]");
  if (treeAction) {
    handleInspectorTreeAction(treeAction.dataset.treeAction);
  } else if (loadTurn) {
    const turn = state.turns.find((candidate) => candidate.id === loadTurn.dataset.loadTurnEvents);
    if (turn) {
      loadTurnRecords(turn).then(() => renderInspector());
    }
  } else if (openTurn) {
    const turn = state.turns.find((candidate) => candidate.id === openTurn.dataset.openTurnEvents);
    if (turn) {
      loadTurnRecords(turn).then((records) => {
        state.viewMode = "events";
        state.selectedLineNo = records[0]?.lineNo || null;
        state.query = "";
        el.searchInput.value = "";
        state.inspectorTab = "summary";
        renderViewMode();
        renderEvents();
        renderInspector();
      });
    }
  } else if (copyTurn) {
    const turn = state.turns.find((candidate) => candidate.id === copyTurn.dataset.copyTurn);
    if (turn) {
      copyText(JSON.stringify({
        turn_id: turn.id,
        user: turn.userMessage,
        assistant: turn.assistantMessage,
        composition: turn.composition,
        token_delta: turn.tokenDelta,
      }, null, 2));
    }
  } else if (clearPhase) {
    state.turnPhaseFilter = "";
    state.selectedLineNo = null;
    renderInspector();
  } else if (selectTurn) {
    state.selectedTurnId = selectTurn.dataset.selectTurn;
    state.selectedLineNo = null;
    state.expandedTurns = new Set([state.selectedTurnId]);
    state.inspectorTab = "summary";
    renderEvents({ preserveScroll: true });
    renderInspector();
  } else if (inspectTurnLine) {
    state.selectedLineNo = Number(inspectTurnLine.dataset.inspectTurnLine);
    state.inspectorTab = "raw";
    renderInspector();
  } else if (selectLine) {
    state.selectedLineNo = Number(selectLine.dataset.selectLine);
    if (state.viewMode !== "turns") {
      state.inspectorTab = "summary";
      renderEvents({ preserveScroll: true });
    }
    renderInspector();
  } else {
    return;
  }
});

function handleInspectorTreeAction(action) {
  const shouldOpen = action === "expand-all";
  for (const node of el.inspectorContent.querySelectorAll(".json-tree details")) {
    node.open = shouldOpen;
  }
}

el.dateInput.addEventListener("change", async () => {
  state.selectedDate = el.dateInput.value;
  await loadFiles();
});

el.refreshButton.addEventListener("click", async () => {
  await loadDates();
});

el.searchInput.addEventListener("input", () => {
  state.query = el.searchInput.value.trim().toLowerCase();
  renderEvents();
});

el.eventOrderSelect.addEventListener("change", () => {
  state.eventOrder = el.eventOrderSelect.value;
  renderEvents();
});

el.autoScrollInput.addEventListener("change", () => {
  state.autoScroll = el.autoScrollInput.checked;
});

el.pauseButton.addEventListener("click", () => {
  state.paused = !state.paused;
  el.pauseButton.textContent = state.paused ? "Resume" : "Pause";
  if (state.paused) {
    closeStream();
    setStatus("Paused");
  } else {
    openStream();
  }
});

async function copyText(text, statusText = "Copied") {
  await navigator.clipboard.writeText(text);
  setStatus(statusText);
}

setInspectorWidth(state.inspectorWidth, false);
initResizableInspector();
renderViewMode();

loadDates().catch((error) => {
  el.rootPath.textContent = error.message;
  setStatus("Load failed");
  el.eventStream.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
});
