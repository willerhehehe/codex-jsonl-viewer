const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_CLAUDE_ROOT = "~/.claude/projects";
const TURN_CATEGORY_KEYS = ["requirement", "system", "retrieved", "reasoning", "tools", "assistant"];
const MAX_RANGE_BYTES = 64 * 1024 * 1024;
const SYNTHETIC_PROMPT_TAGS = new Set([
  "bash-input",
  "bash-stdout",
  "command-name",
  "ide_opened_file",
  "ide_selection",
  "local-command-caveat",
  "local-command-stdout",
  "system-reminder",
  "task-notification",
]);

function resolveProjectsRoot(rootText = DEFAULT_CLAUDE_ROOT) {
  const value = String(rootText || DEFAULT_CLAUDE_ROOT);
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.resolve(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function listProjects(root) {
  const projectsRoot = resolveProjectsRoot(root);
  if (!isDirectory(projectsRoot)) {
    return [];
  }

  const projects = [];
  for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const projectPath = path.join(projectsRoot, entry.name);
    const sessions = listSessionFiles(projectsRoot, entry.name);
    if (!sessions.length) {
      continue;
    }
    projects.push({
      id: entry.name,
      name: entry.name,
      displayName: sessions[0].cwd ? path.basename(sessions[0].cwd) : entry.name,
      cwd: sessions[0].cwd || "",
      path: projectPath,
      sessionCount: sessions.length,
      modifiedAt: sessions[0].modifiedAt,
      mtime: sessions[0].mtime,
    });
  }
  return projects.sort((left, right) => right.mtime - left.mtime || left.name.localeCompare(right.name));
}

function listSessionFiles(root, projectName) {
  const projectsRoot = resolveProjectsRoot(root);
  const projectPath = safeProjectPath(projectsRoot, projectName);
  if (!isDirectory(projectPath)) {
    return [];
  }

  return fs.readdirSync(projectPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(projectPath, entry.name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
    .map(sessionFileInfo);
}

function safeProjectPath(root, projectName) {
  const projectsRoot = resolveProjectsRoot(root);
  const name = String(projectName || "");
  if (!name || name === "." || name === ".." || path.basename(name) !== name) {
    throw badRequest("project must be a direct child of the Claude projects root");
  }

  const projectPath = path.resolve(projectsRoot, name);
  assertPathInside(projectPath, projectsRoot, "project is outside the Claude projects root");
  if (fs.existsSync(projectPath)) {
    const stat = fs.lstatSync(projectPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw badRequest("project must be a real directory");
    }
    assertRealPathInside(projectPath, projectsRoot, "project resolves outside the Claude projects root");
  }
  return projectPath;
}

function safeSessionPath(root, projectName, fileName) {
  const projectsRoot = resolveProjectsRoot(root);
  const projectPath = safeProjectPath(projectsRoot, projectName);
  const name = String(fileName || "");
  if (!name || path.basename(name) !== name || !name.endsWith(".jsonl")) {
    throw badRequest("file must be a direct session JSONL file name");
  }

  const filePath = path.resolve(projectPath, name);
  assertPathInside(filePath, projectPath, "session is outside the selected Claude project");
  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw badRequest("session must be a real JSONL file");
    }
    assertRealPathInside(filePath, projectsRoot, "session resolves outside the Claude projects root");
  }
  return filePath;
}

function parseClaudeJsonlLine(line, lineNo, offset) {
  const rawLine = line.endsWith("\n") ? line.slice(0, -1) : line;
  const nextOffset = offset + Buffer.byteLength(line);
  try {
    const record = JSON.parse(rawLine);
    return {
      lineNo,
      offset,
      nextOffset,
      rawLine,
      record,
      error: null,
      viewer: describeClaudeRecord(record),
    };
  } catch (error) {
    return {
      lineNo,
      offset,
      nextOffset,
      rawLine,
      record: { raw: rawLine },
      error: error.message,
      viewer: {
        provider: "claude",
        categories: [],
        kind: "invalid-json",
        label: "Invalid JSON",
        summary: oneLineText(error.message, 240),
        boundary: null,
      },
    };
  }
}

function describeClaudeRecord(record) {
  const categories = recordCategories(record);
  const prompt = realUserPrompt(record);
  const blocks = contentBlocks(record);
  const toolUses = blocks.filter((block) => ["tool_use", "server_tool_use"].includes(block.type));
  const toolResults = blocks.filter((block) => ["tool_result", "advisor_tool_result"].includes(block.type));
  const texts = blocks.filter((block) => block.type === "text").map((block) => block.text);
  const thoughts = blocks.filter((block) => block.type === "thinking").map((block) => block.thinking);
  const type = String(record?.type || "unknown");
  const subtype = String(record?.subtype || "");
  let kind = subtype || type;
  let label = subtype ? `${humanize(type)} · ${humanize(subtype)}` : humanize(type);
  let summary = "";
  let boundary = null;

  if (prompt) {
    kind = "user-prompt";
    label = "User prompt";
    summary = prompt;
    boundary = "start";
  } else if (toolUses.length) {
    kind = "tool-use";
    const names = toolUses.map((block) => block.name || block.type).filter(Boolean);
    label = `Tool call${names.length ? ` · ${names.join(", ")}` : ""}`;
    summary = texts.join(" ") || thoughts.join(" ") || summarizeToolInputs(toolUses);
  } else if (toolResults.length) {
    kind = "tool-result";
    label = "Tool result";
    summary = toolResults.map((block) => messageText(block.content)).filter(Boolean).join(" ");
  } else if (type === "assistant" && thoughts.length && !texts.length) {
    kind = "thinking";
    label = "Thinking";
    summary = thoughts.join(" ");
  } else if (type === "assistant" && texts.length) {
    kind = "assistant-text";
    label = "Assistant output";
    summary = texts.join(" ");
  } else if (type === "system" && subtype === "turn_duration") {
    kind = "turn-duration";
    label = "Turn duration";
    summary = formatDuration(record.durationMs);
    boundary = "end";
  } else if (type === "ai-title") {
    label = "AI title";
    summary = record.aiTitle;
  } else if (type === "agent-name") {
    label = "Agent name";
    summary = record.agentName;
  } else if (type === "last-prompt") {
    label = "Last prompt";
    summary = record.lastPrompt;
  } else if (type === "queue-operation") {
    label = `Queue · ${humanize(record.operation || "operation")}`;
    summary = messageText(record.content);
  } else if (type === "system") {
    summary = messageText(record.content || record.error || record.cause || record.stopReason);
  } else if (type === "attachment") {
    summary = messageText(record.attachment);
  }
  if (!boundary && type === "assistant" && record?.message?.stop_reason === "end_turn") {
    boundary = "end";
  }

  return {
    provider: "claude",
    categories,
    kind,
    label,
    summary: oneLineText(summary, 600),
    boundary,
    toolCount: toolUses.length,
    toolResultCount: toolResults.length,
    toolNames: [...new Set(toolUses.map((block) => String(block.name || block.type)).filter(Boolean))],
    assistantMessage: type === "assistant" ? oneLineText(texts.join(" "), 600) : "",
    assistantMessageFull: type === "assistant" ? texts.filter(Boolean).join("\n").trim() : "",
  };
}

function readRecentJsonl(filePath, limit = 200) {
  const recordLimit = Math.max(0, Number(limit) || 0);
  if (!recordLimit || !fs.existsSync(filePath)) {
    return { records: [], offset: 0 };
  }

  const fileSize = fs.statSync(filePath).size;
  const { data, offset: dataOffset } = readTailBytes(filePath, recordLimit);
  let lines = splitLinesKeepEnd(data);
  let offset = dataOffset;
  if (lines.length > recordLimit) {
    const skipped = lines.length - recordLimit;
    offset += lines.slice(0, skipped).reduce((sum, line) => sum + line.length, 0);
    lines = lines.slice(skipped);
  }

  const records = [];
  const firstLineNo = countLinesBefore(filePath, offset) + 1;
  let lineOffset = offset;
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index].toString("utf8");
    records.push(parseClaudeJsonlLine(lineText, firstLineNo + index, lineOffset));
    lineOffset += lines[index].length;
  }
  return { records, offset: fileSize };
}

function readJsonlRange(filePath, startOffset, endOffset) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const fileSize = fs.statSync(filePath).size;
  const start = clampOffset(startOffset, 0, fileSize);
  const end = clampOffset(endOffset, fileSize, fileSize);
  if (end < start) {
    throw badRequest("end must be greater than or equal to start");
  }
  if (end - start > MAX_RANGE_BYTES) {
    throw badRequest("turn event range is too large");
  }

  const buffer = Buffer.alloc(end - start);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }

  const records = [];
  let lineNo = countLinesBefore(filePath, start) + 1;
  let offset = start;
  for (const line of splitLinesKeepEnd(buffer)) {
    records.push(parseClaudeJsonlLine(line.toString("utf8"), lineNo, offset));
    offset += line.length;
    lineNo += 1;
  }
  return records;
}

function summarizeSessionTurns(filePath) {
  if (!fs.existsSync(filePath)) {
    return { turns: [], sessionContext: emptyComposition(), session: {}, offset: 0 };
  }

  const data = fs.readFileSync(filePath);
  const turns = [];
  const sessionContext = emptyComposition();
  const session = {};
  let current = null;
  let lineNo = 1;
  let offset = 0;

  for (const line of splitLinesKeepEnd(data)) {
    const item = parseClaudeJsonlLine(line.toString("utf8"), lineNo, offset);
    const record = item.record || {};
    collectSessionMetadata(session, record);
    const prompt = realUserPrompt(record);

    if (prompt) {
      if (current) {
        finalizeTurn(current, turns, implicitTurnStatus(current));
      }
      current = createTurnSummary(record, prompt, item);
    }

    if (current) {
      addRecordToTurn(current, item);
      if (isTurnDuration(record)) {
        finalizeTurn(current, turns, current.hasError ? "error" : "complete");
        current = null;
      }
    } else {
      addCompositionItem(sessionContext, item);
    }

    offset += line.length;
    lineNo += 1;
  }

  if (current) {
    const status = current.hasError ? "error" : current.hasCompletedResponse ? "complete" : "live";
    finalizeTurn(current, turns, status);
  }

  return {
    turns: turns.reverse(),
    sessionContext: finalizeComposition(sessionContext),
    session: finalizeSessionMetadata(session),
    offset: data.length,
  };
}

function createTurnSummary(record, prompt, item) {
  const timestamp = record.timestamp || null;
  return {
    id: String(record.uuid || record.promptId || `line-${item.lineNo}`),
    startLine: item.lineNo,
    endLine: item.lineNo,
    startOffset: item.offset,
    endOffset: item.nextOffset,
    startTime: timestamp,
    endTime: timestamp,
    durationMs: null,
    status: "live",
    eventCount: 0,
    contentEventCount: 0,
    toolCount: 0,
    toolNames: [],
    userMessage: oneLineText(prompt, 600),
    userMessageFull: String(prompt || "").trim(),
    assistantMessage: "",
    assistantMessageFull: "",
    assistantMessages: new Map(),
    composition: emptyComposition(),
    tokenDelta: emptyUsage(),
    usageMessageIds: new Set(),
    hasCompletedResponse: false,
    hasError: false,
  };
}

function addRecordToTurn(turn, item) {
  const record = item.record || {};
  const blocks = contentBlocks(record);
  turn.eventCount += 1;
  turn.endLine = item.lineNo;
  turn.endOffset = item.nextOffset;
  turn.endTime = record.timestamp || turn.endTime;
  if (addCompositionItem(turn.composition, item)) {
    turn.contentEventCount += 1;
  }

  if (record.type === "assistant") {
    const assistantTexts = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .map((text) => String(text || "").trim())
      .filter(Boolean);
    const messageId = String(record.message?.id || record.uuid || `line-${item.lineNo}`);
    if (assistantTexts.length || record.message?.stop_reason === "end_turn") {
      const message = turn.assistantMessages.get(messageId) || {
        texts: [],
        seenTexts: new Set(),
        lastLine: item.lineNo,
        completed: false,
      };
      for (const text of assistantTexts) {
        if (!message.seenTexts.has(text)) {
          message.seenTexts.add(text);
          message.texts.push(text);
        }
      }
      message.lastLine = item.lineNo;
      message.completed ||= record.message?.stop_reason === "end_turn";
      turn.assistantMessages.set(messageId, message);
      selectHandoffAssistantMessage(turn);
    }
    if (record.message?.stop_reason === "end_turn") {
      turn.hasCompletedResponse = true;
    }
    if (record.error || record.isApiErrorMessage) {
      turn.hasError = true;
    } else if (turn.hasError && blocks.length) {
      turn.hasError = false;
    }
    const usage = claudeUsage(record);
    if (usage) {
      const usageId = String(record.message?.id || record.uuid || `line-${item.lineNo}`);
      if (!turn.usageMessageIds.has(usageId)) {
        turn.usageMessageIds.add(usageId);
        addUsage(turn.tokenDelta, usage);
      }
    }
  }

  for (const block of blocks) {
    if (!["tool_use", "server_tool_use"].includes(block.type)) {
      continue;
    }
    turn.toolCount += 1;
    const name = String(block.name || block.type);
    if (name && !turn.toolNames.includes(name)) {
      turn.toolNames.push(name);
    }
  }

  if (record.type === "system" && record.subtype === "api_error") {
    turn.hasError = true;
  }
  if (isTurnDuration(record)) {
    const duration = Number(record.durationMs);
    if (Number.isFinite(duration) && duration >= 0) {
      turn.durationMs = duration;
    }
  }
}

function finalizeTurn(turn, turns, status) {
  turn.status = status;
  turn.composition = finalizeComposition(turn.composition);
  if (turn.durationMs === null) {
    const start = Date.parse(turn.startTime || "");
    const end = Date.parse(turn.endTime || "");
    if (Number.isFinite(start) && Number.isFinite(end)) {
      turn.durationMs = Math.max(0, end - start);
    }
  }
  delete turn.hasCompletedResponse;
  delete turn.hasError;
  delete turn.usageMessageIds;
  delete turn.assistantMessages;
  turns.push(turn);
}

function selectHandoffAssistantMessage(turn) {
  const messages = [...turn.assistantMessages.values()].filter((message) => message.texts.length);
  const completed = messages.filter((message) => message.completed);
  const selected = (completed.length ? completed : messages)
    .sort((left, right) => left.lastLine - right.lastLine)
    .at(-1);
  if (!selected) {
    return;
  }
  const fullText = selected.texts.join("\n").trim();
  turn.assistantMessage = oneLineText(fullText, 600);
  turn.assistantMessageFull = fullText;
}

function implicitTurnStatus(turn) {
  if (turn.hasError) {
    return "error";
  }
  return turn.hasCompletedResponse || turn.assistantMessageFull ? "complete" : "partial";
}

function realUserPrompt(record) {
  if (record?.type !== "user" || record?.message?.role !== "user") {
    return "";
  }
  if (record.isSidechain || record.isMeta || record.promptSource === "system" || record.origin?.kind === "task-notification") {
    return "";
  }
  const content = record.message.content;
  if (typeof content === "string") {
    const text = content.trim();
    return isSyntheticPromptText(text) ? "" : text;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block && typeof block === "object" && block.type === "text")
    .map((block) => messageText(block.text))
    .filter((text) => !isSyntheticPromptText(text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isSyntheticPromptText(value) {
  const match = String(value || "").trim().match(/^<([A-Za-z0-9_-]+)/);
  if (!match) {
    return false;
  }
  return SYNTHETIC_PROMPT_TAGS.has(match[1]);
}

function recordCategories(record) {
  if (realUserPrompt(record)) {
    return ["requirement"];
  }
  const categories = [];
  if (["mode", "permission-mode", "file-history-snapshot", "file-history-delta", "agent-name", "ai-title", "last-prompt", "queue-operation", "bridge-session"].includes(record?.type)) {
    categories.push("system");
  }
  if (record?.type === "system") {
    categories.push("system");
  }
  if (record?.type === "attachment") {
    categories.push("retrieved");
  }
  for (const block of contentBlocks(record)) {
    const category = blockCategory(block, record);
    if (category && !categories.includes(category)) {
      categories.push(category);
    }
  }
  return categories;
}

function blockCategory(block, record) {
  const textCategory = record?.type === "assistant" || record?.message?.role === "assistant"
    ? "assistant"
    : record?.type === "attachment"
      ? "retrieved"
      : record?.type === "user" || record?.type === "system"
        ? "system"
        : null;
  return {
    thinking: "reasoning",
    tool_use: "tools",
    server_tool_use: "tools",
    tool_result: "tools",
    advisor_tool_result: "tools",
    text: textCategory,
  }[block?.type] || null;
}

function contentBlocks(record) {
  const content = record?.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((block) => block && typeof block === "object");
}

function emptyComposition() {
  return Object.fromEntries(TURN_CATEGORY_KEYS.map((key) => [key, { bytes: 0, events: 0 }]));
}

function addCompositionItem(composition, item) {
  const categories = item.viewer?.categories || [];
  if (!categories.length) {
    return false;
  }
  const bytes = Buffer.byteLength(item.rawLine || JSON.stringify(item.record || {}));
  const base = Math.floor(bytes / categories.length);
  let remainder = bytes - (base * categories.length);
  for (const category of categories) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    composition[category].bytes += base + extra;
    composition[category].events += 1;
  }
  return true;
}

function finalizeComposition(composition) {
  return Object.fromEntries(TURN_CATEGORY_KEYS.map((key) => [key, {
    bytes: Number(composition[key]?.bytes || 0),
    events: Number(composition[key]?.events || 0),
  }]));
}

function claudeUsage(record) {
  const usage = record?.message?.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const input = positiveNumber(usage.input_tokens);
  const cacheWrite = positiveNumber(usage.cache_creation_input_tokens);
  const cacheRead = positiveNumber(usage.cache_read_input_tokens);
  const output = positiveNumber(usage.output_tokens);
  return {
    input_tokens: input,
    cached_input_tokens: cacheRead,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + cacheWrite + cacheRead + output,
  };
}

function emptyUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

function addUsage(target, usage) {
  if (!usage) {
    return;
  }
  for (const key of Object.keys(emptyUsage())) {
    target[key] += positiveNumber(usage[key]);
  }
}

function collectSessionMetadata(session, record) {
  const sessionId = record?.sessionId || record?.session_id;
  if (sessionId && !session.sessionId) {
    session.sessionId = String(sessionId);
  }
  if (record?.cwd && !session.cwd) {
    session.cwd = String(record.cwd);
  }
  if (record?.version && !session.version) {
    session.version = String(record.version);
  }
  if (record?.message?.model && !session.model) {
    session.model = String(record.message.model);
  }
  if (record?.type === "ai-title" && record.aiTitle) {
    session.title = String(record.aiTitle);
  }
  if (record?.type === "agent-name" && record.agentName) {
    session.agentName = String(record.agentName);
  }
  if (record?.timestamp && !session.startedAt) {
    session.startedAt = String(record.timestamp);
  }
}

function finalizeSessionMetadata(session) {
  const sessionId = String(session.sessionId || "");
  const version = String(session.version || "");
  return {
    id: sessionId,
    sessionId,
    cwd: String(session.cwd || ""),
    originator: "claude-code",
    source: "claude",
    cliVersion: version,
    version,
    startedAt: String(session.startedAt || ""),
    model: String(session.model || ""),
    title: String(session.title || ""),
    agentName: String(session.agentName || ""),
  };
}

class ClaudeJsonlTailer {
  constructor(filePath, offset = 0) {
    this.filePath = filePath;
    this.offset = Math.max(0, Number(offset) || 0);
    this.buffer = Buffer.alloc(0);
    this.bufferOffset = this.offset;
    this.lineNo = fs.existsSync(filePath) ? countLinesBefore(filePath, this.offset) + 1 : 1;
  }

  readAvailable() {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    const stat = fs.statSync(this.filePath);
    if (stat.size < this.offset) {
      this.offset = 0;
      this.buffer = Buffer.alloc(0);
      this.bufferOffset = 0;
      this.lineNo = 1;
    }
    if (stat.size === this.offset) {
      return [];
    }

    const chunkOffset = this.offset;
    const chunk = Buffer.alloc(stat.size - this.offset);
    const fd = fs.openSync(this.filePath, "r");
    try {
      fs.readSync(fd, chunk, 0, chunk.length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = stat.size;

    const combinedOffset = this.buffer.length ? this.bufferOffset : chunkOffset;
    const combined = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const { complete, remainder } = splitCompleteLines(combined);
    this.buffer = remainder;
    this.bufferOffset = combinedOffset + complete.reduce((sum, line) => sum + line.length, 0);

    const records = [];
    let lineOffset = combinedOffset;
    for (const line of complete) {
      records.push(parseClaudeJsonlLine(line.toString("utf8"), this.lineNo, lineOffset));
      this.lineNo += 1;
      lineOffset += line.length;
    }
    return records;
  }
}

function readTailBytes(filePath, lineLimit) {
  const chunkSize = 64 * 1024;
  const fileSize = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, "r");
  const chunks = [];
  let position = fileSize;
  let newlineCount = 0;
  try {
    while (position > 0 && newlineCount <= lineLimit) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);
      chunks.unshift(chunk);
      newlineCount += countByte(chunk, 10);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { data: Buffer.concat(chunks), offset: position };
}

function splitLinesKeepEnd(buffer) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 10) {
      lines.push(buffer.subarray(start, index + 1));
      start = index + 1;
    }
  }
  if (start < buffer.length) {
    lines.push(buffer.subarray(start));
  }
  return lines;
}

function splitCompleteLines(buffer) {
  const lines = splitLinesKeepEnd(buffer);
  if (lines.length && lines[lines.length - 1][lines[lines.length - 1].length - 1] !== 10) {
    return { complete: lines.slice(0, -1), remainder: lines[lines.length - 1] };
  }
  return { complete: lines, remainder: Buffer.alloc(0) };
}

function countLinesBefore(filePath, offset) {
  if (offset <= 0 || !fs.existsSync(filePath)) {
    return 0;
  }
  const fd = fs.openSync(filePath, "r");
  const chunk = Buffer.alloc(64 * 1024);
  let position = 0;
  let count = 0;
  try {
    while (position < offset) {
      const readSize = Math.min(chunk.length, offset - position);
      const bytesRead = fs.readSync(fd, chunk, 0, readSize, position);
      if (!bytesRead) {
        break;
      }
      count += countByte(chunk.subarray(0, bytesRead), 10);
      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return count;
}

function sessionFileInfo(filePath) {
  const stat = fs.statSync(filePath);
  const preview = sessionFilePreview(filePath);
  return {
    id: path.basename(filePath, ".jsonl"),
    name: path.basename(filePath),
    path: filePath,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    mtime: stat.mtimeMs / 1000,
    firstPrompt: preview.firstPrompt,
    cwd: preview.cwd,
  };
}

function sessionFilePreview(filePath) {
  const maxBytes = 256 * 1024;
  const stat = fs.statSync(filePath);
  const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  let cwd = "";
  for (const line of splitLinesKeepEnd(buffer)) {
    try {
      const record = JSON.parse(line.toString("utf8"));
      cwd ||= String(record.cwd || "");
      const prompt = realUserPrompt(record);
      if (prompt) {
        return { cwd, firstPrompt: oneLineText(prompt, 180) };
      }
    } catch {
      // A truncated final line is expected when the preview reaches maxBytes.
    }
  }
  return { cwd, firstPrompt: "" };
}

function assertPathInside(child, parent, message) {
  if (!isPathInside(child, parent)) {
    throw badRequest(message);
  }
}

function assertRealPathInside(child, parent, message) {
  if (!fs.existsSync(parent)) {
    return;
  }
  const realParent = fs.realpathSync(parent);
  const realChild = fs.realpathSync(child);
  if (!isPathInside(realChild, realParent)) {
    throw badRequest(message);
  }
}

function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isTurnDuration(record) {
  return record?.type === "system" && record?.subtype === "turn_duration";
}

function summarizeToolInputs(blocks) {
  return blocks.map((block) => {
    const input = block.input && typeof block.input === "object" ? JSON.stringify(block.input) : messageText(block.input);
    return `${block.name || block.type}${input ? ` ${input}` : ""}`;
  }).join(" ");
}

function messageText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => messageText(item)).filter(Boolean).join(" ");
  }
  if (value && typeof value === "object") {
    return messageText(value.text ?? value.content ?? value.message ?? value.output ?? "");
  }
  return typeof value === "string" ? value : "";
}

function oneLineText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)} ...` : text;
}

function humanize(value) {
  const text = String(value || "unknown").replace(/[-_]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) {
    return "";
  }
  if (duration < 1000) {
    return `${duration} ms`;
  }
  return `${(duration / 1000).toFixed(duration >= 10000 ? 0 : 1)} s`;
}

function positiveNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function clampOffset(value, defaultValue, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return defaultValue;
  }
  return Math.max(0, Math.min(maximum, Math.trunc(number)));
}

function countByte(buffer, byte) {
  let count = 0;
  for (const item of buffer) {
    if (item === byte) {
      count += 1;
    }
  }
  return count;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

module.exports = {
  DEFAULT_CLAUDE_ROOT,
  DEFAULT_ROOT: DEFAULT_CLAUDE_ROOT,
  ClaudeJsonlTailer,
  describeClaudeRecord,
  listProjects,
  listSessionFiles,
  parseClaudeJsonlLine,
  readJsonlRange,
  readRecentJsonl,
  realUserPrompt,
  resolveProjectsRoot,
  safeProjectPath,
  safeSessionPath,
  summarizeSessionTurns,
};
