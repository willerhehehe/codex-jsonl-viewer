const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cli = require("../src/cli");
const server = require("../src/session-server");

test("package exposes an npx bin without runtime dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

  assert.equal(pkg.name, "codex-jsonl-viewer");
  assert.equal(pkg.bin["codex-jsonl-viewer"], "bin/codex-jsonl-viewer.js");
  assert.deepEqual(pkg.dependencies || {}, {});
});

test("default sessions root expands home", () => {
  const root = server.resolveSessionsRoot("~/.codex/sessions");

  assert.equal(root, path.join(os.homedir(), ".codex", "sessions"));
});

test("CLI defaults to the Codex sessions root and local URL port", () => {
  const options = cli.parseArgs([]);

  assert.equal(options.root, "~/.codex/sessions");
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.port, 8765);
  assert.equal(options.open, false);
  assert.equal(options.strictPort, false);
});

test("CLI automatically falls back when the requested port is busy", async () => {
  const blocker = server.createHttpServer({ host: "127.0.0.1", port: 0 });
  await listen(blocker);
  const blockedPort = blocker.address().port;
  const output = bufferedOutput();
  const errorOutput = bufferedOutput();
  let viewer;

  try {
    viewer = cli.runCli(["--port", String(blockedPort)], output, errorOutput);
    await waitForListening(viewer, { ignoreBusyPort: true });

    assert.notEqual(viewer.address().port, blockedPort);
    assert.match(output.text(), /Port \d+ is busy; using available port \d+\./);
    assert.match(output.text(), /Serving at: http:\/\/127\.0\.0\.1:\d+/);
    assert.equal(errorOutput.text(), "");
  } finally {
    if (viewer && viewer.listening) {
      await close(viewer);
    }
    await close(blocker);
  }
});

test("CLI strict port reports a busy port instead of falling back", async () => {
  const blocker = server.createHttpServer({ host: "127.0.0.1", port: 0 });
  await listen(blocker);
  const blockedPort = blocker.address().port;
  const output = bufferedOutput();
  const errorOutput = bufferedOutput();
  let viewer;

  try {
    viewer = cli.runCli(["--port", String(blockedPort), "--strict-port"], output, errorOutput);
    await waitForError(viewer);
    process.exitCode = 0;

    assert.equal(viewer.listening, false);
    assert.match(errorOutput.text(), /Failed to start Codex Session Viewer: listen EADDRINUSE/);
  } finally {
    if (viewer && viewer.listening) {
      await close(viewer);
    }
    await close(blocker);
  }
});

test("dateToDir uses year month day segments", () => {
  assert.equal(
    server.dateToDir("/tmp/sessions", "2026-05-09"),
    path.join("/tmp/sessions", "2026", "05", "09"),
  );
});

test("listDates returns existing day directories descending", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-viewer-"));
  try {
    fs.mkdirSync(path.join(root, "2026", "05", "08"), { recursive: true });
    fs.mkdirSync(path.join(root, "2026", "05", "09"), { recursive: true });
    fs.mkdirSync(path.join(root, "2026", "bad", "10"), { recursive: true });

    assert.deepEqual(server.listDates(root), ["2026-05-09", "2026-05-08"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listRolloutFiles sorts by modified time descending", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-viewer-"));
  try {
    const day = path.join(root, "2026", "05", "09");
    fs.mkdirSync(day, { recursive: true });
    const older = path.join(day, "rollout-older.jsonl");
    const newer = path.join(day, "rollout-newer.jsonl");
    const ignored = path.join(day, "notes.jsonl");
    fs.writeFileSync(older, "{}\n");
    fs.writeFileSync(newer, "{}\n");
    fs.writeFileSync(ignored, "{}\n");
    fs.utimesSync(older, new Date("2026-05-09T10:00:00Z"), new Date("2026-05-09T10:00:00Z"));
    fs.utimesSync(newer, new Date("2026-05-09T10:01:00Z"), new Date("2026-05-09T10:01:00Z"));

    const files = server.listRolloutFiles(root, "2026-05-09");

    assert.deepEqual(files.map((item) => item.name), ["rollout-newer.jsonl", "rollout-older.jsonl"]);
    assert.equal(files[0].size, 3);
    assert.ok(files[0].modifiedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP API serves dates, initial records, and static assets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-viewer-"));
  const day = path.join(root, "2026", "05", "09");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(
    path.join(day, "rollout-test.jsonl"),
    [0, 1, 2, 3].map((index) => JSON.stringify({ index, type: "event_msg" })).join("\n") + "\n",
  );

  const httpd = server.createHttpServer({ host: "127.0.0.1", port: 0, root });
  try {
    await listen(httpd);
    const { port } = httpd.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const dates = await getJson(`${baseUrl}/api/dates`);
    const initial = await getJson(`${baseUrl}/api/initial?date=2026-05-09&file=rollout-test.jsonl&limit=2`);
    const html = await getText(`${baseUrl}/`);

    assert.deepEqual(dates.dates, ["2026-05-09"]);
    assert.equal(dates.root, path.resolve(root));
    assert.deepEqual(initial.records.map((item) => item.record.index), [2, 3]);
    assert.match(html, /Codex Session Viewer/);
  } finally {
    await close(httpd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function listen(httpd) {
  return new Promise((resolve, reject) => {
    httpd.once("error", reject);
    httpd.listen(httpd.port, httpd.host, () => {
      httpd.off("error", reject);
      resolve();
    });
  });
}

function close(httpd) {
  return new Promise((resolve, reject) => {
    httpd.close((error) => (error ? reject(error) : resolve()));
  });
}

function waitForListening(httpd, options = {}) {
  if (httpd.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onListening = () => {
      httpd.off("error", onError);
      resolve();
    };
    const onError = (error) => {
      if (options.ignoreBusyPort && error.code === "EADDRINUSE") {
        return;
      }
      httpd.off("listening", onListening);
      reject(error);
    };
    httpd.once("listening", onListening);
    httpd.on("error", onError);
  });
}

function waitForError(httpd) {
  return new Promise((resolve) => {
    httpd.once("error", resolve);
  });
}

function bufferedOutput() {
  let buffer = "";
  return {
    write(chunk) {
      buffer += chunk;
    },
    text() {
      return buffer;
    },
  };
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return response.json();
}

async function getText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return response.text();
}
