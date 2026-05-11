const INSPECTOR_WIDTH_STORAGE_KEY = "jsonl-session-viewer.inspector-width";
const DEFAULT_INSPECTOR_WIDTH = 380;
const WIDE_INSPECTOR_WIDTH = 720;
const MIN_INSPECTOR_WIDTH = 320;
const MIN_STREAM_WIDTH = 520;
const SIDEBAR_WIDTH = 255;
const RESIZE_HANDLE_WIDTH = 8;

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
  truncateAfter: 180,
};

const el = {
  rootPath: document.querySelector("#rootPath"),
  dateInput: document.querySelector("#dateInput"),
  refreshButton: document.querySelector("#refreshButton"),
  dateStatus: document.querySelector("#dateStatus"),
  fileList: document.querySelector("#fileList"),
  mainLayout: document.querySelector("#mainLayout"),
  activeFile: document.querySelector("#activeFile"),
  streamStatus: document.querySelector("#streamStatus"),
  eventFilterBar: document.querySelector("#eventFilterBar"),
  eventStream: document.querySelector("#eventStream"),
  searchInput: document.querySelector("#searchInput"),
  eventOrderSelect: document.querySelector("#eventOrderSelect"),
  autoScrollInput: document.querySelector("#autoScrollInput"),
  pauseButton: document.querySelector("#pauseButton"),
  inspectorResizeHandle: document.querySelector("#inspectorResizeHandle"),
  inspectorWideButton: document.querySelector("#inspectorWideButton"),
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
  state.selectedLineNo = null;
  state.offset = 0;
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
  const data = await api(url);
  state.records = data.records || [];
  state.offset = data.offset || 0;
  renderFiles();
  renderEvents();
  renderInspector();
  el.activeFile.textContent = `${formatFileName(state.selectedFile)} · ${formatFileId(state.selectedFile)}`;
  setStatus(`${state.records.length} recent events`);
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
    appendOrRender(item);
    renderInspector();
  };
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

el.eventStream.addEventListener("click", async (event) => {
  const expand = event.target.closest("[data-expand]");
  const collapse = event.target.closest("[data-collapse]");
  const selectLine = event.target.closest("[data-select-line]");
  const copyFull = event.target.closest("[data-copy-full]");
  if (expand) {
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

el.inspectorTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-inspector-tab]");
  if (!button) {
    return;
  }
  state.inspectorTab = button.dataset.inspectorTab;
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
  if (treeAction) {
    handleInspectorTreeAction(treeAction.dataset.treeAction);
  } else if (selectLine) {
    state.selectedLineNo = Number(selectLine.dataset.selectLine);
    state.inspectorTab = "summary";
    renderEvents({ preserveScroll: true });
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

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  setStatus("Copied");
}

setInspectorWidth(state.inspectorWidth, false);
initResizableInspector();

loadDates().catch((error) => {
  el.rootPath.textContent = error.message;
  setStatus("Load failed");
  el.eventStream.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
});
