const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");

const DEFAULT_ROOT = "~/.codex/sessions";
const STATIC_DIR = path.resolve(__dirname, "..", "static");

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
    if (requestUrl.pathname === "/api/dates") {
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
  createHttpServer,
  dateToDir,
  listDates,
  listRolloutFiles,
  parseJsonlLine,
  readRecentJsonl,
  resolveSessionsRoot,
  safeRolloutPath,
};
