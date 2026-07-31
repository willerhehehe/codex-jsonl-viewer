const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");

const DEFAULT_ROOT = "~/.codex/sessions";
const STATIC_DIR = path.resolve(__dirname, "..", "static");
const PACKAGE_JSON = path.resolve(__dirname, "..", "package.json");

function appMetadata() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
    return {
      name: String(pkg.name || "codex-jsonl-viewer"),
      version: String(pkg.version || "dev"),
    };
  } catch {
    return { name: "codex-jsonl-viewer", version: "dev" };
  }
}

function resolveSessionsRoot(rootText = DEFAULT_ROOT) {
  if (rootText === "~") {
    return os.homedir();
  }
  if (rootText.startsWith("~/")) {
    return path.resolve(os.homedir(), rootText.slice(2));
  }
  return path.resolve(rootText);
}

function dateToDir(root, dateText) {
  const parsed = parseDateText(dateText);
  return path.join(root, parsed.year, parsed.month, parsed.day);
}

function listDates(root) {
  if (!isDirectory(root)) {
    return [];
  }

  const dates = [];
  for (const year of fs.readdirSync(root)) {
    const yearDir = path.join(root, year);
    if (!isDigits(year, 4) || !isDirectory(yearDir)) {
      continue;
    }
    for (const month of fs.readdirSync(yearDir)) {
      const monthDir = path.join(yearDir, month);
      if (!isDigits(month, 2) || !isDirectory(monthDir)) {
        continue;
      }
      for (const day of fs.readdirSync(monthDir)) {
        const dayDir = path.join(monthDir, day);
        const dateText = `${year}-${month}-${day}`;
        if (isDigits(day, 2) && isDirectory(dayDir) && isValidDateText(dateText)) {
          dates.push(dateText);
        }
      }
    }
  }
  return dates.sort().reverse();
}

function listRolloutFiles(root, dateText) {
  const dayDir = dateToDir(root, dateText);
  if (!isDirectory(dayDir)) {
    return [];
  }

  return fs.readdirSync(dayDir)
    .filter((name) => name.startsWith("rollout-") && name.endsWith(".jsonl"))
    .map((name) => path.join(dayDir, name))
    .filter((filePath) => fs.statSync(filePath).isFile())
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
    .map(fileInfo);
}

function safeRolloutPath(root, dateText, fileName) {
  if (path.basename(fileName) !== fileName) {
    throw badRequest("file must be a rollout JSONL file name, not a path");
  }
  if (!fileName.startsWith("rollout-") || !fileName.endsWith(".jsonl")) {
    throw badRequest("file must match rollout-*.jsonl");
  }

  const dayDir = path.resolve(dateToDir(root, dateText));
  const filePath = path.resolve(dayDir, fileName);
  if (!isPathInside(filePath, dayDir)) {
    throw badRequest("file is outside the selected date directory");
  }
  return filePath;
}

function parseJsonlLine(line, lineNo, offset) {
  const raw = line.endsWith("\n") ? line.slice(0, -1) : line;
  try {
    return {
      lineNo,
      offset,
      nextOffset: offset + Buffer.byteLength(line),
      rawLine: raw,
      record: JSON.parse(raw),
      error: null,
    };
  } catch (error) {
    return {
      lineNo,
      offset,
      nextOffset: offset + Buffer.byteLength(line),
      rawLine: raw,
      record: { raw },
      error: error.message,
    };
  }
}

function readRecentJsonl(filePath, limit) {
  if (limit <= 0 || !fs.existsSync(filePath)) {
    return { records: [], offset: 0 };
  }

  const fileSize = fs.statSync(filePath).size;
  const { data, offset: dataOffset } = readTailBytes(filePath, limit);
  let lines = splitLinesKeepEnd(data);
  let offset = dataOffset;
  if (lines.length > limit) {
    const skipped = lines.length - limit;
    offset += lines.slice(0, skipped).reduce((sum, line) => sum + line.length, 0);
    lines = lines.slice(skipped);
  }

  const records = [];
  const firstLineNo = countLinesBefore(filePath, offset) + 1;
  let lineOffset = offset;
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index].toString("utf8");
    records.push(parseJsonlLine(lineText, firstLineNo + index, lineOffset));
    lineOffset += lines[index].length;
  }
  return { records, offset: fileSize };
}

const TURN_CATEGORY_KEYS = ["requirement", "system", "retrieved", "reasoning", "tools", "assistant"];

function summarizeSessionTurns(filePath) {
  if (!fs.existsSync(filePath)) {
    return { turns: [], sessionContext: emptyComposition(), session: {}, offset: 0 };
  }

  const data = fs.readFileSync(filePath);
  const lines = splitLinesKeepEnd(data);
  const turns = [];
  const sessionContext = emptyComposition();
  const session = {};
  let current = null;
  let lineNo = 1;
  let offset = 0;
  let lastUsage = emptyUsage();

  for (const line of lines) {
    const lineText = line.toString("utf8");
    const item = parseJsonlLine(lineText, lineNo, offset);
    const record = item.record || {};
    const payloadType = record.payload?.type || "";
    const turnId = record.payload?.turn_id || record.turn_id || "";

    if (record.type === "session_meta") {
      Object.assign(session, sessionMetadata(record));
    } else if (record.type === "turn_context" && !session.cwd && record.payload?.cwd) {
      session.cwd = String(record.payload.cwd);
    }

    if (payloadType === "task_started") {
      if (current) {
        const endingUsage = current.lastUsage || lastUsage;
        finalizeTurn(current, turns, lastUsage, "partial");
        lastUsage = endingUsage;
      }
      current = createTurnSummary(turnId, item, lastUsage);
    } else if (!current && record.type === "turn_context") {
      current = createTurnSummary(turnId, item, lastUsage);
    }

    if (current) {
      addRecordToTurn(current, item);
      if (!current.id && turnId) {
        current.id = String(turnId);
      }
      if (payloadType === "task_complete" || payloadType === "turn_aborted") {
        const status = payloadType === "turn_aborted" ? "aborted" : "complete";
        const endingUsage = current.lastUsage || lastUsage;
        finalizeTurn(current, turns, lastUsage, status);
        lastUsage = endingUsage;
        current = null;
      }
    } else {
      addCompositionRecord(sessionContext, item);
      const usage = totalTokenUsage(record);
      if (usage) {
        lastUsage = usage;
      }
    }

    offset += line.length;
    lineNo += 1;
  }

  if (current) {
    finalizeTurn(current, turns, lastUsage, "live");
  }

  return {
    turns: turns.reverse(),
    sessionContext: finalizeComposition(sessionContext),
    session,
    offset: data.length,
  };
}

function sessionMetadata(record) {
  const payload = record?.payload || {};
  return {
    id: String(payload.session_id || payload.id || ""),
    cwd: String(payload.cwd || ""),
    originator: String(payload.originator || ""),
    source: String(payload.source || ""),
    cliVersion: String(payload.cli_version || ""),
    startedAt: String(payload.timestamp || record?.timestamp || ""),
  };
}

function readJsonlRange(filePath, startOffset, endOffset) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const fileSize = fs.statSync(filePath).size;
  const start = Math.max(0, Math.min(fileSize, Number(startOffset) || 0));
  const end = Math.max(start, Math.min(fileSize, Number(endOffset) || fileSize));
  if (end - start > 64 * 1024 * 1024) {
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
    records.push(parseJsonlLine(line.toString("utf8"), lineNo, offset));
    offset += line.length;
    lineNo += 1;
  }
  return records;
}

function createTurnSummary(turnId, item, baselineUsage) {
  const timestamp = item.record?.timestamp || null;
  return {
    id: String(turnId || `line-${item.lineNo}`),
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
    userMessage: "",
    userMessagePriority: 0,
    assistantMessage: "",
    composition: emptyComposition(),
    baselineUsage: { ...baselineUsage },
    lastUsage: null,
    tokenDelta: emptyUsage(),
  };
}

function addRecordToTurn(turn, item) {
  const record = item.record || {};
  const payloadType = record.payload?.type || "";
  const role = record.payload?.role || "";
  turn.eventCount += 1;
  turn.endLine = item.lineNo;
  turn.endOffset = item.nextOffset;
  turn.endTime = record.timestamp || turn.endTime;

  const category = addCompositionRecord(turn.composition, item);
  if (category) {
    turn.contentEventCount += 1;
  }

  if (payloadType === "user_message") {
    setPreferredMessage(turn, "userMessage", messageText(record.payload?.message), 2);
  } else if (payloadType === "message" && role === "user") {
    setPreferredMessage(turn, "userMessage", messageText(record.payload?.content), 1);
  } else if (payloadType === "agent_message") {
    setPreferredMessage(turn, "assistantMessage", messageText(record.payload?.message || record.payload?.content), 2);
  } else if (payloadType === "message" && role === "assistant") {
    setPreferredMessage(turn, "assistantMessage", messageText(record.payload?.content), 1);
  }

  if (["function_call", "custom_tool_call", "tool_search_call"].includes(payloadType)) {
    turn.toolCount += 1;
    const toolName = record.payload?.name || record.payload?.tool_name || payloadType.replace("_call", "");
    if (toolName && !turn.toolNames.includes(toolName)) {
      turn.toolNames.push(String(toolName));
    }
  }

  const usage = totalTokenUsage(record);
  if (usage) {
    turn.lastUsage = usage;
  }

  if (payloadType === "task_complete" || payloadType === "turn_aborted") {
    const duration = Number(record.payload?.duration_ms);
    if (Number.isFinite(duration) && duration >= 0) {
      turn.durationMs = duration;
    }
  }
}

function finalizeTurn(turn, turns, fallbackUsage, status) {
  turn.status = status;
  turn.composition = finalizeComposition(turn.composition);
  turn.lastUsage = turn.lastUsage || fallbackUsage;
  turn.tokenDelta = subtractUsage(turn.lastUsage, turn.baselineUsage);
  if (turn.durationMs === null) {
    const start = Date.parse(turn.startTime || "");
    const end = Date.parse(turn.endTime || "");
    if (Number.isFinite(start) && Number.isFinite(end)) {
      turn.durationMs = Math.max(0, end - start);
    }
  }
  delete turn.userMessagePriority;
  delete turn.assistantMessagePriority;
  delete turn.baselineUsage;
  delete turn.lastUsage;
  turns.push(turn);
}

function emptyComposition() {
  return Object.fromEntries(TURN_CATEGORY_KEYS.map((key) => [key, { bytes: 0, events: 0 }]));
}

function addCompositionRecord(composition, item) {
  const category = turnCategory(item.record || {});
  if (!category) {
    return null;
  }
  composition[category].bytes += Buffer.byteLength(item.rawLine || JSON.stringify(item.record || {}));
  composition[category].events += 1;
  return category;
}

function finalizeComposition(composition) {
  const result = {};
  for (const key of TURN_CATEGORY_KEYS) {
    result[key] = {
      bytes: Number(composition[key]?.bytes || 0),
      events: Number(composition[key]?.events || 0),
    };
  }
  return result;
}

function turnCategory(record) {
  const type = record.type || "";
  const payloadType = record.payload?.type || "";
  const role = record.payload?.role || "";

  if (payloadType === "user_message" || (payloadType === "message" && role === "user")) {
    return "requirement";
  }
  if (type === "turn_context" || type === "world_state" || (payloadType === "message" && ["system", "developer"].includes(role))) {
    return "system";
  }
  if (["tool_search_output", "web_search_end", "mcp_tool_call_end"].includes(payloadType)) {
    return "retrieved";
  }
  if (payloadType === "reasoning" || payloadType === "agent_reasoning") {
    return "reasoning";
  }
  if ([
    "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output",
    "tool_search_call", "patch_apply_begin", "patch_apply_end",
  ].includes(payloadType)) {
    return "tools";
  }
  if (payloadType === "agent_message" || (payloadType === "message" && role === "assistant")) {
    return "assistant";
  }
  return null;
}

function setPreferredMessage(turn, key, value, priority) {
  const text = oneLineText(value, 600);
  if (!text) {
    return;
  }
  const priorityKey = key === "userMessage" ? "userMessagePriority" : "assistantMessagePriority";
  if (!turn[key] || priority >= (turn[priorityKey] || 0)) {
    turn[key] = text;
    turn[priorityKey] = priority;
  }
}

function messageText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => messageText(item)).filter(Boolean).join(" ");
  }
  if (value && typeof value === "object") {
    return messageText(value.text ?? value.content ?? value.message ?? "");
  }
  return typeof value === "string" ? value : "";
}

function oneLineText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)} ...` : text;
}

function totalTokenUsage(record) {
  const usage = record.payload?.info?.total_token_usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  return {
    input_tokens: Number(usage.input_tokens || 0),
    cached_input_tokens: Number(usage.cached_input_tokens || 0),
    cache_write_input_tokens: Number(usage.cache_write_input_tokens || 0),
    output_tokens: Number(usage.output_tokens || 0),
    reasoning_output_tokens: Number(usage.reasoning_output_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0),
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

function subtractUsage(end, start) {
  return Object.fromEntries(Object.keys(emptyUsage()).map((key) => [key, Math.max(0, Number(end?.[key] || 0) - Number(start?.[key] || 0))]));
}

class JsonlTailer {
  constructor(filePath, offset = 0) {
    this.filePath = filePath;
    this.offset = offset;
    this.buffer = Buffer.alloc(0);
    this.bufferOffset = offset;
    this.lineNo = fs.existsSync(filePath) ? countLinesBefore(filePath, offset) + 1 : 1;
  }

  readAvailable() {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const stat = fs.statSync(this.filePath);
    if (stat.size <= this.offset) {
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
      records.push(parseJsonlLine(line.toString("utf8"), this.lineNo, lineOffset));
      this.lineNo += 1;
      lineOffset += line.length;
    }
    return records;
  }
}

function createHttpServer({ host = "127.0.0.1", port = 8765, root = DEFAULT_ROOT, staticDir = STATIC_DIR } = {}) {
  const sessionsRoot = resolveSessionsRoot(root);
  const staticRoot = path.resolve(staticDir);
  const server = http.createServer((request, response) => {
    handleRequest(request, response, sessionsRoot, staticRoot);
  });
  server.sessionsRoot = sessionsRoot;
  server.staticDir = staticRoot;
  server.host = host;
  server.port = port;
  return server;
}

function handleRequest(request, response, sessionsRoot, staticRoot) {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  try {
    if (request.method !== "GET") {
      throw httpError(405, "method not allowed");
    }
    if (requestUrl.pathname === "/api/meta") {
      writeJson(response, appMetadata());
    } else if (requestUrl.pathname === "/api/dates") {
      writeJson(response, {
        root: sessionsRoot,
        dates: listDates(sessionsRoot),
        today: formatLocalDate(new Date()),
      });
    } else if (requestUrl.pathname === "/api/files") {
      const dateText = requiredParam(requestUrl, "date");
      writeJson(response, { date: dateText, files: listRolloutFiles(sessionsRoot, dateText) });
    } else if (requestUrl.pathname === "/api/initial") {
      handleInitial(requestUrl, response, sessionsRoot);
    } else if (requestUrl.pathname === "/api/turns") {
      handleTurns(requestUrl, response, sessionsRoot);
    } else if (requestUrl.pathname === "/api/turn-events") {
      handleTurnEvents(requestUrl, response, sessionsRoot);
    } else if (requestUrl.pathname === "/api/stream") {
      handleStream(requestUrl, request, response, sessionsRoot);
    } else {
      handleStatic(requestUrl.pathname, response, staticRoot);
    }
  } catch (error) {
    const status = error.status || 500;
    writeJson(response, { error: error.message }, status);
  }
}

function handleTurns(requestUrl, response, sessionsRoot) {
  const dateText = requiredParam(requestUrl, "date");
  const fileName = requiredParam(requestUrl, "file");
  const filePath = safeRolloutPath(sessionsRoot, dateText, fileName);
  writeJson(response, {
    date: dateText,
    file: fileName,
    ...summarizeSessionTurns(filePath),
  });
}

function handleTurnEvents(requestUrl, response, sessionsRoot) {
  const dateText = requiredParam(requestUrl, "date");
  const fileName = requiredParam(requestUrl, "file");
  const start = boundedInt(requestUrl.searchParams.get("start"), 0, 0, 10 ** 15);
  const end = boundedInt(requestUrl.searchParams.get("end"), 0, 0, 10 ** 15);
  if (end < start) {
    throw badRequest("end must be greater than or equal to start");
  }
  const filePath = safeRolloutPath(sessionsRoot, dateText, fileName);
  writeJson(response, {
    date: dateText,
    file: fileName,
    start,
    end,
    records: readJsonlRange(filePath, start, end),
  });
}

function handleInitial(requestUrl, response, sessionsRoot) {
  const dateText = requiredParam(requestUrl, "date");
  const fileName = requiredParam(requestUrl, "file");
  const limit = boundedInt(requestUrl.searchParams.get("limit"), 200, 1, 1000);
  const filePath = safeRolloutPath(sessionsRoot, dateText, fileName);
  const { records, offset } = readRecentJsonl(filePath, limit);
  writeJson(response, {
    date: dateText,
    file: fileName,
    path: filePath,
    records,
    offset,
  });
}

function handleStream(requestUrl, request, response, sessionsRoot) {
  const dateText = requiredParam(requestUrl, "date");
  const fileName = requiredParam(requestUrl, "file");
  const offset = boundedInt(requestUrl.searchParams.get("offset"), 0, 0, 10 ** 15);
  const filePath = safeRolloutPath(sessionsRoot, dateText, fileName);
  const tailer = new JsonlTailer(filePath, offset);

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const tick = () => {
    const records = tailer.readAvailable();
    if (records.length) {
      for (const record of records) {
        response.write(`data: ${JSON.stringify(record)}\n\n`);
      }
    } else {
      response.write(": keepalive\n\n");
    }
  };
  tick();
  const timer = setInterval(tick, 500);
  request.on("close", () => clearInterval(timer));
}

function handleStatic(rawPath, response, staticRoot) {
  const decoded = decodeURIComponent(rawPath);
  let relative = decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^\/+/, "");
  if (relative.startsWith("static/")) {
    relative = relative.slice("static/".length);
  }
  const filePath = path.resolve(staticRoot, relative);
  if (!isPathInside(filePath, staticRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw httpError(404, `not found: ${rawPath}`);
  }
  const body = fs.readFileSync(filePath);
  response.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Content-Length": body.length,
  });
  response.end(body);
}

function writeJson(response, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  response.end(body);
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
  if (lines.length && !lines[lines.length - 1].toString("utf8").endsWith("\n")) {
    return { complete: lines.slice(0, -1), remainder: lines[lines.length - 1] };
  }
  return { complete: lines, remainder: Buffer.alloc(0) };
}

function countLinesBefore(filePath, offset) {
  if (offset <= 0 || !fs.existsSync(filePath)) {
    return 0;
  }
  const fd = fs.openSync(filePath, "r");
  const chunkSize = 64 * 1024;
  const chunk = Buffer.alloc(chunkSize);
  let remaining = offset;
  let count = 0;
  try {
    while (remaining > 0) {
      const readSize = Math.min(chunkSize, remaining);
      const bytesRead = fs.readSync(fd, chunk, 0, readSize, offset - remaining);
      if (!bytesRead) {
        break;
      }
      count += countByte(chunk.subarray(0, bytesRead), 10);
      remaining -= bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return count;
}

function fileInfo(filePath) {
  const stat = fs.statSync(filePath);
  return {
    name: path.basename(filePath),
    path: filePath,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    mtime: stat.mtimeMs / 1000,
  };
}

function parseDateText(dateText) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText || "");
  if (!match || !isValidDateText(dateText)) {
    throw badRequest("date must use YYYY-MM-DD");
  }
  return { year: match[1], month: match[2], day: match[3] };
}

function isValidDateText(dateText) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText || "");
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function requiredParam(requestUrl, key) {
  const value = requestUrl.searchParams.get(key);
  if (!value) {
    throw badRequest(`missing required parameter: ${key}`);
  }
  return value;
}

function boundedInt(value, defaultValue, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.max(minimum, Math.min(maximum, parsed));
}

function contentType(filePath) {
  const extension = path.extname(filePath);
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  }[extension] || "application/octet-stream";
}

function formatLocalDate(date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isPathInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isDigits(value, size) {
  return value.length === size && /^\d+$/.test(value);
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
  return httpError(400, message);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = {
  DEFAULT_ROOT,
  STATIC_DIR,
  JsonlTailer,
  appMetadata,
  createHttpServer,
  dateToDir,
  listDates,
  listRolloutFiles,
  parseJsonlLine,
  readJsonlRange,
  readRecentJsonl,
  resolveSessionsRoot,
  safeRolloutPath,
  summarizeSessionTurns,
};
