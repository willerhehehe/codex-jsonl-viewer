const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cli = require("../src/cli");
const releaseAutomation = require("../scripts/release");
const server = require("../src/session-server");
const updates = require("../src/update-manager");

test("package exposes an npx bin without runtime dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

  assert.equal(pkg.name, "codex-jsonl-viewer");
  assert.equal(pkg.bin["codex-jsonl-viewer"], "bin/codex-jsonl-viewer.js");
  assert.deepEqual(pkg.dependencies || {}, {});
  assert.equal(pkg.scripts["release:patch"], "node scripts/release.js patch");
  assert.equal(pkg.scripts["release:minor"], "node scripts/release.js minor");
  assert.equal(pkg.scripts["release:major"], "node scripts/release.js major");
  assert.doesNotMatch(pkg.scripts.test, /python/i);
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
  assert.equal(options.claudeRoot, "~/.claude/projects");
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.port, 8765);
  assert.equal(options.open, false);
  assert.equal(options.strictPort, false);
});

test("CLI preserves runtime arguments when building global and npx restarts", () => {
  const options = {
    root: "/tmp/codex sessions",
    claudeRoot: "/tmp/claude projects",
    host: "127.0.0.1",
    port: 9876,
    open: false,
    strictPort: true,
  };
  const update = {
    installMode: "global",
    packageName: "codex-jsonl-viewer",
    targetVersion: "0.3.0",
  };
  const globalSpec = cli.buildRestartSpec(update, options, "/tmp/viewer.js");
  const npxSpec = cli.buildRestartSpec({ ...update, installMode: "npx" }, options, "/tmp/viewer.js");

  assert.equal(globalSpec.command, process.execPath);
  assert.deepEqual(globalSpec.args, [
    "/tmp/viewer.js",
    "--root", "/tmp/codex sessions",
    "--claude-root", "/tmp/claude projects",
    "--host", "127.0.0.1",
    "--port", "9876",
    "--no-open",
    "--strict-port",
  ]);
  assert.match(npxSpec.command, /^npx(?:\.cmd)?$/);
  assert.deepEqual(npxSpec.args.slice(0, 2), ["-y", "codex-jsonl-viewer@0.3.0"]);
  assert.deepEqual(npxSpec.args.slice(2), globalSpec.args.slice(1));
});

test("update manager checks semver, caches registry results, and runs a global update", async () => {
  let registryCalls = 0;
  const commands = [];
  const restarts = [];
  const manager = updates.createUpdateManager({
    currentVersion: "0.2.1",
    installMode: "global",
    latestVersionProvider: async () => {
      registryCalls += 1;
      return "0.3.0";
    },
    commandRunner: async (command, args) => commands.push({ command, args }),
    restartProcess: async (update) => restarts.push(update),
    now: () => Date.parse("2026-07-31T06:00:00Z"),
  });

  const first = await manager.getStatus();
  const cached = await manager.getStatus();
  assert.equal(first.updateAvailable, true);
  assert.equal(cached.latestVersion, "0.3.0");
  assert.equal(registryCalls, 1);

  const started = await manager.startUpdate();
  assert.equal(started.phase, "installing");
  await manager.waitForUpdate();

  assert.equal(registryCalls, 2);
  assert.deepEqual(commands, [{
    command: updates.npmCommand(),
    args: ["install", "-g", "codex-jsonl-viewer@0.3.0"],
  }]);
  assert.deepEqual(restarts, [{
    installMode: "global",
    packageName: "codex-jsonl-viewer",
    targetVersion: "0.3.0",
  }]);
  assert.equal(manager.snapshot().phase, "restarting");
});

test("source installs expose a manual command instead of modifying the checkout", async () => {
  const manager = updates.createUpdateManager({
    currentVersion: "0.2.1",
    installMode: "source",
    latestVersionProvider: async () => "0.2.2",
    restartProcess: async () => assert.fail("source mode must not restart"),
  });

  const status = await manager.getStatus();
  assert.equal(status.canAutoUpdate, false);
  assert.equal(status.manualCommand, "git pull --ff-only && npm test");
  await assert.rejects(
    manager.startUpdate(),
    (error) => error.status === 409 && error.manualCommand === status.manualCommand,
  );
});

test("semantic versions and install modes are classified deterministically", () => {
  assert.equal(updates.compareVersions("0.2.1", "0.2.2"), -1);
  assert.equal(updates.compareVersions("1.0.0", "1.0.0-beta.2"), 1);
  assert.equal(updates.detectInstallMode("/tmp/.npm/_npx/abc/node_modules/codex-jsonl-viewer", {}), "npx");
  assert.equal(updates.detectInstallMode("/opt/homebrew/lib/node_modules/codex-jsonl-viewer", {}), "global");
  assert.equal(server.isLocalHostHeader("127.0.0.1:8765"), true);
  assert.equal(server.isLocalHostHeader("attacker.example"), false);
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
    assert.match(errorOutput.text(), /Failed to start Context Explorer: listen EADDRINUSE/);
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

test("Codex turn summaries retain full handoff messages while keeping compact previews", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-viewer-"));
  const file = path.join(root, "rollout-long-turn.jsonl");
  const userMessage = `First request line\n${"u".repeat(900)}\nLast request line`;
  const assistantMessage = `First answer line\n${"a".repeat(900)}\nLast answer line`;
  const records = [
    { type: "event_msg", timestamp: "2026-05-09T10:00:00Z", payload: { type: "task_started", turn_id: "turn-long" } },
    { type: "event_msg", timestamp: "2026-05-09T10:00:01Z", payload: { type: "user_message", message: userMessage } },
    { type: "response_item", timestamp: "2026-05-09T10:00:02Z", payload: { type: "reasoning", text: "reasoning-secret" } },
    { type: "response_item", timestamp: "2026-05-09T10:00:03Z", payload: { type: "function_call_output", output: "tool-output-secret" } },
    { type: "event_msg", timestamp: "2026-05-09T10:00:04Z", payload: { type: "agent_message", message: assistantMessage } },
    { type: "event_msg", timestamp: "2026-05-09T10:00:05Z", payload: { type: "task_complete", turn_id: "turn-long" } },
  ];
  try {
    fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    const turn = server.summarizeSessionTurns(file).turns[0];

    assert.equal(turn.userMessageFull, userMessage);
    assert.equal(turn.assistantMessageFull, assistantMessage);
    assert.match(turn.userMessage, / \.\.\.$/);
    assert.match(turn.assistantMessage, / \.\.\.$/);
    assert.ok(turn.userMessage.length < turn.userMessageFull.length);
    assert.ok(turn.assistantMessage.length < turn.assistantMessageFull.length);
    assert.doesNotMatch(JSON.stringify(turn), /reasoning-secret|tool-output-secret/);
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

  let updateStarts = 0;
  const updateStatus = {
    currentVersion: require("../package.json").version,
    latestVersion: "0.3.0",
    updateAvailable: true,
    installMode: "global",
    canAutoUpdate: true,
    phase: "idle",
    error: "",
    targetVersion: "",
    manualCommand: "npm install -g codex-jsonl-viewer@latest",
  };
  const updateManager = {
    getStatus: async () => updateStatus,
    startUpdate: async () => {
      updateStarts += 1;
      return { ...updateStatus, phase: "installing", targetVersion: "0.3.0" };
    },
  };
  const httpd = server.createHttpServer({ host: "127.0.0.1", port: 0, root, updateManager });
  try {
    await listen(httpd);
    const { port } = httpd.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const metadata = await getJson(`${baseUrl}/api/meta`);
    const availableUpdate = await getJson(`${baseUrl}/api/update-status`);
    const dates = await getJson(`${baseUrl}/api/dates`);
    const initial = await getJson(`${baseUrl}/api/initial?date=2026-05-09&file=rollout-test.jsonl&limit=2`);
    const html = await getText(`${baseUrl}/`);
    const icon = await getText(`${baseUrl}/static/icon.svg`);
    const app = await getText(`${baseUrl}/static/app.js`);
    const claudeApp = await getText(`${baseUrl}/static/claude-viewer.js`);
    const rejectedUpdate = await requestJson(`${baseUrl}/api/update`, { method: "POST" });
    const acceptedUpdate = await requestJson(`${baseUrl}/api/update`, {
      method: "POST",
      headers: { "X-Codex-Update-Token": metadata.updateToken },
    });

    assert.equal(metadata.version, require("../package.json").version);
    assert.ok(metadata.updateToken);
    assert.equal(availableUpdate.latestVersion, "0.3.0");
    assert.deepEqual(dates.dates, ["2026-05-09"]);
    assert.equal(dates.root, path.resolve(root));
    assert.deepEqual(initial.records.map((item) => item.record.index), [2, 3]);
    assert.match(html, /<title>Context Explorer<\/title>/);
    assert.match(html, /<h1>Context Explorer<\/h1>/);
    assert.match(html, /id="viewerSwitchButton"/);
    assert.match(html, /role="switch"/);
    assert.match(html, /aria-checked="false"/);
    assert.match(html, /viewer-switch-codex">Codex/);
    assert.match(html, /viewer-switch-claude">Claude/);
    assert.doesNotMatch(html, /viewer-switch-arrows/);
    assert.match(html, /id="appVersion"/);
    assert.match(html, /id="updateButton"/);
    assert.match(html, /rel="icon"/);
    assert.match(icon, /<svg/);
    assert.match(app, /\/api\/update-status/);
    assert.match(claudeApp, /\/api\/claude\/projects/);
    assert.equal(rejectedUpdate.status, 403);
    assert.equal(acceptedUpdate.status, 202);
    assert.equal(acceptedUpdate.body.phase, "installing");
    assert.equal(updateStarts, 1);
  } finally {
    await close(httpd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP API serves independent Claude projects, sessions, turns, and event detail", async () => {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-viewer-"));
  const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-session-viewer-"));
  const project = "-Users-willer-viewer";
  const projectDir = path.join(claudeRoot, project);
  fs.mkdirSync(projectDir);
  const fileName = "11111111-1111-4111-8111-111111111111.jsonl";
  fs.writeFileSync(
    path.join(projectDir, fileName),
    claudeHttpFixtureRecords().map((record) => JSON.stringify(record)).join("\n") + "\n",
  );

  const httpd = server.createHttpServer({
    host: "127.0.0.1",
    port: 0,
    root: codexRoot,
    claudeRoot,
  });
  try {
    await listen(httpd);
    const baseUrl = `http://127.0.0.1:${httpd.address().port}`;
    const projectParam = encodeURIComponent(project);
    const fileParam = encodeURIComponent(fileName);
    const projects = await getJson(`${baseUrl}/api/claude/projects`);
    const sessions = await getJson(`${baseUrl}/api/claude/sessions?project=${projectParam}`);
    const initial = await getJson(`${baseUrl}/api/claude/initial?project=${projectParam}&file=${fileParam}&limit=20`);
    const summary = await getJson(`${baseUrl}/api/claude/turns?project=${projectParam}&file=${fileParam}`);
    const turn = summary.turns[0];
    const detail = await getJson(
      `${baseUrl}/api/claude/turn-events?project=${projectParam}&file=${fileParam}&start=${turn.startOffset}&end=${turn.endOffset}`,
    );

    assert.equal(httpd.claudeRoot, path.resolve(claudeRoot));
    assert.deepEqual(projects.projects.map((item) => item.id), [project]);
    assert.equal(projects.projects[0].displayName, "viewer");
    assert.equal(sessions.sessions[0].firstPrompt, "Inspect Claude support");
    assert.equal(initial.records[0].viewer.provider, "claude");
    assert.equal(summary.session.source, "claude");
    assert.equal(summary.session.cwd, "/Users/willer/viewer");
    assert.equal(summary.turns.length, 1);
    assert.equal(turn.userMessage, "Inspect Claude support");
    assert.equal(turn.toolCount, 1);
    assert.equal(turn.durationMs, 1200);
    assert.equal(detail.records[0].viewer.boundary, "start");
    assert.equal(detail.records.at(-1).viewer.boundary, "end");
  } finally {
    await close(httpd);
    fs.rmSync(codexRoot, { recursive: true, force: true });
    fs.rmSync(claudeRoot, { recursive: true, force: true });
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

function claudeHttpFixtureRecords() {
  const common = {
    sessionId: "claude-session",
    cwd: "/Users/willer/viewer",
    version: "2.1.0",
  };
  return [
    {
      ...common,
      type: "user",
      uuid: "prompt-1",
      promptId: "prompt-1",
      timestamp: "2026-07-31T02:00:00.000Z",
      message: { role: "user", content: "Inspect Claude support" },
    },
    {
      ...common,
      type: "assistant",
      uuid: "assistant-1",
      timestamp: "2026-07-31T02:00:00.500Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-1",
        usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 4, output_tokens: 5 },
        content: [
          { type: "thinking", thinking: "Inspect the implementation" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/session-server.js" } },
        ],
      },
    },
    {
      ...common,
      type: "user",
      timestamp: "2026-07-31T02:00:00.800Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "source" }] },
    },
    {
      ...common,
      type: "assistant",
      uuid: "assistant-2",
      timestamp: "2026-07-31T02:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-1",
        usage: { input_tokens: 3, output_tokens: 4 },
        content: [{ type: "text", text: "Claude support is available." }],
      },
    },
    {
      ...common,
      type: "system",
      subtype: "turn_duration",
      durationMs: 1200,
      timestamp: "2026-07-31T02:00:01.200Z",
    },
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

async function requestJson(url, options) {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.json() };
}
