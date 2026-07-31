const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cli = require("../src/cli");
const releaseAutomation = require("../scripts/release");
const server = require("../src/session-server");

test("package exposes an npx bin without runtime dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

  assert.equal(pkg.name, "codex-jsonl-viewer");
  assert.equal(pkg.bin["codex-jsonl-viewer"], "bin/codex-jsonl-viewer.js");
  assert.deepEqual(pkg.dependencies || {}, {});
  assert.equal(pkg.scripts["release:patch"], "node scripts/release.js patch");
  assert.equal(pkg.scripts["release:minor"], "node scripts/release.js minor");
  assert.equal(pkg.scripts["release:major"], "node scripts/release.js major");
});

test("tag releases are guarded and published through trusted GitHub Actions", () => {
  const root = path.join(__dirname, "..");
  const releaseScript = fs.readFileSync(path.join(root, "scripts", "release.js"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "publish.yml"), "utf8");

  assert.match(releaseScript, /branch !== "main"/);
  assert.match(releaseScript, /\["status", "--porcelain"\]/);
  assert.match(releaseScript, /origin\/main/);
  assert.match(releaseScript, /"pack", "--dry-run"/);
  assert.match(releaseScript, /"push", "origin", "main", "--follow-tags"/);
  assert.match(workflow, /tags:\s*\n\s*- "v\*"/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /github\.ref_name/);
  assert.match(workflow, /npm publish --access public/);
  assert.equal(releaseAutomation.run(process.execPath, ["-e", ""]), "");
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

test("CLI port zero uses an assigned port without a busy-port warning", async () => {
  const output = bufferedOutput();
  const errorOutput = bufferedOutput();
  const viewer = cli.runCli(["--port", "0"], output, errorOutput);

  try {
    await waitForListening(viewer);

    assert.match(output.text(), /Serving at: http:\/\/127\.0\.0\.1:\d+/);
    assert.doesNotMatch(output.text(), /Port 0 is busy/);
    assert.equal(errorOutput.text(), "");
  } finally {
    if (viewer.listening) {
      await close(viewer);
    }
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

test("summarizeSessionTurns groups records, composition, and cumulative token deltas", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-viewer-"));
  const file = path.join(root, "rollout-turns.jsonl");
  try {
    const records = turnFixtureRecords();
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

    const summary = server.summarizeSessionTurns(file);

    assert.equal(summary.turns.length, 2);
    assert.equal(summary.session.id, "session-test");
    assert.equal(summary.session.cwd, "/tmp");
    assert.equal(summary.session.originator, "Codex Desktop");
    assert.equal(summary.turns[0].id, "turn-2");
    assert.equal(summary.turns[0].status, "aborted");
    assert.equal(summary.turns[0].tokenDelta.total_tokens, 80);
    assert.equal(summary.turns[1].id, "turn-1");
    assert.equal(summary.turns[1].userMessage, "Build a turn view");
    assert.equal(summary.turns[1].assistantMessage, "Implemented it");
    assert.equal(summary.turns[1].toolCount, 1);
    assert.equal(summary.turns[1].composition.requirement.events, 1);
    assert.equal(summary.turns[1].composition.reasoning.events, 1);
    assert.equal(summary.turns[1].composition.tools.events, 2);
    assert.equal(summary.turns[1].tokenDelta.total_tokens, 120);
    assert.equal(summary.offset, fs.statSync(file).size);

    const firstTurn = summary.turns[1];
    const turnRecords = server.readJsonlRange(file, firstTurn.startOffset, firstTurn.endOffset);
    assert.equal(turnRecords[0].record.payload.type, "task_started");
    assert.equal(turnRecords.at(-1).record.payload.type, "task_complete");
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

test("HTTP API serves turn summaries and lazy turn events", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-viewer-"));
  const day = path.join(root, "2026", "05", "09");
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, "rollout-turns.jsonl");
  fs.writeFileSync(file, turnFixtureRecords().map((record) => JSON.stringify(record)).join("\n") + "\n");

  const httpd = server.createHttpServer({ host: "127.0.0.1", port: 0, root });
  try {
    await listen(httpd);
    const { port } = httpd.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const summary = await getJson(`${baseUrl}/api/turns?date=2026-05-09&file=rollout-turns.jsonl`);
    const turn = summary.turns.find((item) => item.id === "turn-1");
    const detail = await getJson(`${baseUrl}/api/turn-events?date=2026-05-09&file=rollout-turns.jsonl&start=${turn.startOffset}&end=${turn.endOffset}`);

    assert.equal(summary.turns.length, 2);
    assert.equal(detail.records[0].record.payload.turn_id, "turn-1");
    assert.equal(detail.records.at(-1).record.payload.type, "task_complete");
  } finally {
    await close(httpd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function turnFixtureRecords() {
  const usage = (input, output, reasoning, total) => ({
    type: "event_msg",
    timestamp: "2026-05-09T10:00:05Z",
    payload: {
      type: "token_count",
      info: { total_token_usage: {
        input_tokens: input,
        cached_input_tokens: Math.floor(input / 2),
        cache_write_input_tokens: 0,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: total,
      } },
    },
  });
  return [
    { type: "session_meta", timestamp: "2026-05-09T09:59:59Z", payload: { session_id: "session-test", cwd: "/tmp", originator: "Codex Desktop" } },
    { type: "event_msg", timestamp: "2026-05-09T10:00:00Z", payload: { type: "task_started", turn_id: "turn-1" } },
    { type: "turn_context", timestamp: "2026-05-09T10:00:00Z", payload: { turn_id: "turn-1", cwd: "/tmp" } },
    { type: "event_msg", timestamp: "2026-05-09T10:00:01Z", payload: { type: "user_message", message: "Build a turn view" } },
    { type: "response_item", timestamp: "2026-05-09T10:00:02Z", payload: { type: "reasoning", summary: [] } },
    { type: "response_item", timestamp: "2026-05-09T10:00:03Z", payload: { type: "function_call", name: "read_file", call_id: "1" } },
    { type: "response_item", timestamp: "2026-05-09T10:00:04Z", payload: { type: "function_call_output", output: "ok", call_id: "1" } },
    { type: "event_msg", timestamp: "2026-05-09T10:00:05Z", payload: { type: "agent_message", message: "Implemented it" } },
    usage(100, 15, 5, 120),
    { type: "event_msg", timestamp: "2026-05-09T10:00:06Z", payload: { type: "task_complete", turn_id: "turn-1", duration_ms: 6000 } },
    { type: "event_msg", timestamp: "2026-05-09T10:01:00Z", payload: { type: "task_started", turn_id: "turn-2" } },
    { type: "event_msg", timestamp: "2026-05-09T10:01:01Z", payload: { type: "user_message", message: "Stop the turn" } },
    usage(170, 22, 8, 200),
    { type: "event_msg", timestamp: "2026-05-09T10:01:03Z", payload: { type: "turn_aborted", turn_id: "turn-2", duration_ms: 3000 } },
  ];
}

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
