const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const claude = require("../src/claude-viewer");

test("Claude projects root expands home and accepts an explicit root", () => {
  assert.equal(
    claude.resolveProjectsRoot(),
    path.join(os.homedir(), ".claude", "projects"),
  );
  assert.equal(claude.resolveProjectsRoot("/tmp/claude-projects"), "/tmp/claude-projects");
});

test("project and session discovery only includes direct JSONL sessions", () => {
  const root = temporaryRoot();
  try {
    const olderProject = path.join(root, "-Users-willer-old");
    const newerProject = path.join(root, "-Users-willer-new");
    const emptyProject = path.join(root, "empty");
    fs.mkdirSync(path.join(newerProject, "session-id", "subagents"), { recursive: true });
    fs.mkdirSync(olderProject, { recursive: true });
    fs.mkdirSync(emptyProject, { recursive: true });
    const older = path.join(olderProject, "11111111-1111-4111-8111-111111111111.jsonl");
    const newer = path.join(newerProject, "22222222-2222-4222-8222-222222222222.jsonl");
    fs.writeFileSync(older, "{}\n");
    fs.writeFileSync(newer, "{}\n");
    fs.writeFileSync(path.join(newerProject, "notes.txt"), "ignored");
    fs.writeFileSync(path.join(newerProject, "session-id", "subagents", "agent.jsonl"), "{}\n");
    fs.utimesSync(older, new Date("2026-07-30T08:00:00Z"), new Date("2026-07-30T08:00:00Z"));
    fs.utimesSync(newer, new Date("2026-07-31T08:00:00Z"), new Date("2026-07-31T08:00:00Z"));

    const projects = claude.listProjects(root);
    const sessions = claude.listSessionFiles(root, "-Users-willer-new");

    assert.deepEqual(projects.map((project) => project.name), ["-Users-willer-new", "-Users-willer-old"]);
    assert.equal(projects[0].sessionCount, 1);
    assert.deepEqual(sessions.map((session) => session.name), [path.basename(newer)]);
    assert.equal(sessions[0].id, path.basename(newer, ".jsonl"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("safe Claude paths reject traversal, nested files, and symlinks", () => {
  const root = temporaryRoot();
  const outside = temporaryRoot();
  try {
    const project = path.join(root, "-Users-willer-project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "session.jsonl"), "{}\n");
    fs.writeFileSync(path.join(outside, "outside.jsonl"), "{}\n");
    fs.symlinkSync(path.join(outside, "outside.jsonl"), path.join(project, "linked.jsonl"));

    assert.equal(
      claude.safeSessionPath(root, "-Users-willer-project", "session.jsonl"),
      path.join(project, "session.jsonl"),
    );
    assert.throws(() => claude.safeProjectPath(root, "../outside"), hasStatus(400));
    assert.throws(() => claude.safeSessionPath(root, "-Users-willer-project", "../outside.jsonl"), hasStatus(400));
    assert.throws(() => claude.safeSessionPath(root, "-Users-willer-project", "subagents/agent.jsonl"), hasStatus(400));
    assert.throws(() => claude.safeSessionPath(root, "-Users-willer-project", "notes.txt"), hasStatus(400));
    assert.throws(() => claude.safeSessionPath(root, "-Users-willer-project", "linked.jsonl"), hasStatus(400));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Claude records aggregate around real prompts without splitting on tool results", () => {
  const fixture = createTranscript([
    { type: "mode", mode: "default", sessionId: "session-1" },
    userRecord("prompt-1", "Inspect the viewer", "2026-07-31T01:00:00.000Z"),
    assistantRecord([
      { type: "thinking", thinking: "I should inspect files", signature: "redacted" },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/app.js" } },
    ], usage(10, 2, 3, 4), "2026-07-31T01:00:01.000Z"),
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file body" }] },
      timestamp: "2026-07-31T01:00:02.000Z",
      sessionId: "session-1",
      cwd: "/workspace/viewer",
      version: "1.0.80",
    },
    assistantRecord(
      [{ type: "text", text: "The viewer uses a local server." }],
      usage(5, 0, 0, 6),
      "2026-07-31T01:00:03.000Z",
    ),
    {
      type: "system",
      subtype: "turn_duration",
      durationMs: 4472,
      timestamp: "2026-07-31T01:00:04.472Z",
      sessionId: "session-1",
      cwd: "/workspace/viewer",
      version: "1.0.80",
    },
    {
      type: "ai-title",
      sessionId: "session-1",
      aiTitle: "Viewer architecture",
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Add Claude" }, { type: "text", text: "Keep it separate" }] },
      uuid: "prompt-2",
      timestamp: "2026-07-31T01:01:00.000Z",
      sessionId: "session-1",
      cwd: "/workspace/viewer",
      version: "1.0.80",
    },
    assistantRecord([
      { type: "server_tool_use", id: "server-tool-1", name: "advisor", input: { question: "architecture" } },
      { type: "advisor_tool_result", tool_use_id: "server-tool-1", content: "separate adapters" },
      { type: "text", text: "Claude support is ready." },
    ], usage(2, 1, 7, 3), "2026-07-31T01:01:01.000Z"),
    { type: "future-record", payload: { any: "shape" }, timestamp: "2026-07-31T01:01:02.000Z" },
  ]);

  try {
    const result = claude.summarizeSessionTurns(fixture.file);
    assert.equal(result.turns.length, 2);

    const newest = result.turns[0];
    const first = result.turns[1];
    assert.equal(first.userMessage, "Inspect the viewer");
    assert.equal(first.assistantMessage, "The viewer uses a local server.");
    assert.equal(first.toolCount, 1);
    assert.deepEqual(first.toolNames, ["Read"]);
    assert.equal(first.durationMs, 4472);
    assert.equal(first.status, "complete");
    assert.deepEqual(first.tokenDelta, {
      input_tokens: 15,
      cached_input_tokens: 3,
      cache_write_input_tokens: 2,
      output_tokens: 10,
      reasoning_output_tokens: 0,
      total_tokens: 30,
    });
    assert.ok(first.composition.reasoning.bytes > 0);
    assert.ok(first.composition.tools.bytes > 0);
    assert.ok(first.composition.assistant.bytes > 0);

    assert.equal(newest.userMessage, "Add Claude Keep it separate");
    assert.equal(newest.assistantMessage, "Claude support is ready.");
    assert.equal(newest.toolCount, 1);
    assert.deepEqual(newest.toolNames, ["advisor"]);
    assert.equal(newest.status, "live");
    assert.equal(newest.eventCount, 3);

    assert.deepEqual(result.session, {
      id: "session-1",
      sessionId: "session-1",
      cwd: "/workspace/viewer",
      originator: "claude-code",
      source: "claude",
      cliVersion: "1.0.80",
      version: "1.0.80",
      startedAt: "2026-07-31T01:00:00.000Z",
      model: "claude-opus-4-1",
      title: "Viewer architecture",
      agentName: "",
    });
    assert.equal(result.offset, fs.statSync(fixture.file).size);
  } finally {
    fixture.cleanup();
  }
});

test("Claude turns use unique prompt UUIDs and deduplicate usage from streamed message chunks", () => {
  const first = userRecord("prompt-uuid-1", "First prompt", "2026-07-31T01:00:00.000Z");
  first.promptId = "shared-prompt-id";
  const firstChunk = assistantRecord(
    [{ type: "thinking", thinking: "work" }],
    usage(10, 2, 3, 4),
    "2026-07-31T01:00:01.000Z",
  );
  firstChunk.message.id = "streamed-message-1";
  const secondChunk = assistantRecord(
    [{ type: "text", text: "First answer" }],
    usage(10, 2, 3, 4),
    "2026-07-31T01:00:02.000Z",
  );
  secondChunk.message.id = "streamed-message-1";
  const second = userRecord("prompt-uuid-2", "Second prompt", "2026-07-31T01:01:00.000Z");
  second.promptId = "shared-prompt-id";
  const secondAnswer = assistantRecord(
    [{ type: "text", text: "Second answer" }],
    usage(1, 0, 0, 1),
    "2026-07-31T01:01:01.000Z",
  );
  secondAnswer.message.stop_reason = "end_turn";
  const fixture = createTranscript([
    first,
    firstChunk,
    secondChunk,
    { type: "system", subtype: "turn_duration", durationMs: 2000, timestamp: "2026-07-31T01:00:02.000Z" },
    second,
    secondAnswer,
  ]);

  try {
    const result = claude.summarizeSessionTurns(fixture.file);
    assert.deepEqual(result.turns.map((turn) => turn.id), ["prompt-uuid-2", "prompt-uuid-1"]);
    assert.equal(new Set(result.turns.map((turn) => turn.id)).size, 2);
    assert.equal(result.turns[0].status, "complete");
    assert.deepEqual(result.turns[1].tokenDelta, {
      input_tokens: 10,
      cached_input_tokens: 3,
      cache_write_input_tokens: 2,
      output_tokens: 4,
      reasoning_output_tokens: 0,
      total_tokens: 19,
    });
  } finally {
    fixture.cleanup();
  }
});

test("tool-only Claude turns remain partial without a completed response", () => {
  const fixture = createTranscript([
    userRecord("prompt-tool-only", "Inspect the files", "2026-07-31T01:00:00.000Z"),
    assistantRecord([
      { type: "thinking", thinking: "I should inspect the source" },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/app.js" } },
    ], usage(10, 0, 0, 2), "2026-07-31T01:00:01.000Z"),
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "source" }] },
      timestamp: "2026-07-31T01:00:02.000Z",
      sessionId: "session-1",
      cwd: "/workspace/viewer",
      version: "1.0.80",
    },
    userRecord("prompt-next", "Continue", "2026-07-31T01:01:00.000Z"),
  ]);

  try {
    const result = claude.summarizeSessionTurns(fixture.file);
    const toolOnly = result.turns.find((turn) => turn.id === "prompt-tool-only");

    assert.equal(toolOnly.status, "partial");
    assert.equal(toolOnly.assistantMessage, "");
    assert.equal(toolOnly.toolCount, 1);
  } finally {
    fixture.cleanup();
  }
});

test("meta user text is system context instead of assistant output", () => {
  const fixture = createTranscript([
    userRecord("prompt-1", "Inspect the viewer", "2026-07-31T01:00:00.000Z"),
    {
      type: "user",
      isMeta: true,
      message: { role: "user", content: [{ type: "text", text: "System task notification" }] },
      timestamp: "2026-07-31T01:00:01.000Z",
      sessionId: "session-1",
      cwd: "/workspace/viewer",
      version: "1.0.80",
    },
    {
      type: "system",
      subtype: "turn_duration",
      durationMs: 1000,
      timestamp: "2026-07-31T01:00:02.000Z",
      sessionId: "session-1",
      cwd: "/workspace/viewer",
      version: "1.0.80",
    },
  ]);

  try {
    const turn = claude.summarizeSessionTurns(fixture.file).turns[0];

    assert.ok(turn.composition.system.events >= 2);
    assert.equal(turn.composition.assistant.events, 0);
  } finally {
    fixture.cleanup();
  }
});

test("Claude handoff fields retain long prompts and only the completed assistant message", () => {
  const userMessage = `First request line\n${"u".repeat(900)}\nLast request line`;
  const finalPartOne = `First final line\n${"a".repeat(700)}`;
  const finalPartTwo = `Second final line\n${"b".repeat(700)}\nLast final line`;
  const preamble = assistantRecord(
    [
      { type: "thinking", thinking: "reasoning-secret" },
      { type: "text", text: "I will inspect the files first." },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/app.js" } },
    ],
    usage(10, 0, 0, 2),
    "2026-07-31T01:00:01.000Z",
  );
  const finalFirstChunk = assistantRecord(
    [{ type: "text", text: finalPartOne }],
    usage(5, 0, 0, 8),
    "2026-07-31T01:00:03.000Z",
  );
  const finalLastChunk = assistantRecord(
    [{ type: "text", text: finalPartOne }, { type: "text", text: finalPartTwo }],
    usage(5, 0, 0, 8),
    "2026-07-31T01:00:04.000Z",
  );
  finalFirstChunk.message.id = "final-message";
  finalLastChunk.message.id = "final-message";
  finalLastChunk.message.stop_reason = "end_turn";
  const fixture = createTranscript([
    userRecord("prompt-long", userMessage, "2026-07-31T01:00:00.000Z"),
    preamble,
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "tool-output-secret" }] },
      timestamp: "2026-07-31T01:00:02.000Z",
    },
    finalFirstChunk,
    finalLastChunk,
  ]);

  try {
    const turn = claude.summarizeSessionTurns(fixture.file).turns[0];
    const expectedAssistant = `${finalPartOne}\n${finalPartTwo}`;

    assert.equal(turn.status, "complete");
    assert.equal(turn.userMessageFull, userMessage);
    assert.equal(turn.assistantMessageFull, expectedAssistant);
    assert.match(turn.userMessage, / \.\.\.$/);
    assert.match(turn.assistantMessage, / \.\.\.$/);
    assert.doesNotMatch(turn.assistantMessageFull, /inspect the files/);
    assert.doesNotMatch(JSON.stringify(turn), /reasoning-secret|tool-output-secret/);

    const endItem = claude.parseClaudeJsonlLine(`${JSON.stringify(finalLastChunk)}\n`, 5, 100);
    assert.equal(endItem.viewer.boundary, "end");
    assert.equal(endItem.viewer.assistantMessageFull, expectedAssistant);
  } finally {
    fixture.cleanup();
  }
});

test("meta users and tool results are not treated as real prompt boundaries", () => {
  const meta = {
    type: "user",
    isMeta: true,
    message: { role: "user", content: "synthetic context" },
  };
  const notification = {
    type: "user",
    origin: { kind: "task-notification" },
    promptSource: "system",
    message: { role: "user", content: "agent completed" },
  };
  const toolResult = {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: "done" }] },
  };

  assert.equal(claude.realUserPrompt(meta), "");
  assert.equal(claude.realUserPrompt(notification), "");
  assert.equal(claude.realUserPrompt(toolResult), "");
  assert.equal(claude.realUserPrompt({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "actual prompt" }] },
  }), "actual prompt");
  assert.equal(claude.realUserPrompt({
    type: "user",
    message: { role: "user", content: "<local-command-stdout>done</local-command-stdout>" },
  }), "");
  assert.equal(claude.realUserPrompt({
    type: "user",
    message: { role: "user", content: [
      { type: "text", text: "<ide_opened_file>src/app.js</ide_opened_file>" },
      { type: "text", text: "Explain this function" },
    ] },
  }), "Explain this function");
  assert.match(claude.realUserPrompt({
    type: "user",
    message: { role: "user", content: "<command-message>review</command-message>" },
  }), /command-message/);
});

test("records retain raw data and expose Claude-specific viewer descriptions", () => {
  const source = JSON.stringify(assistantRecord([
    { type: "thinking", thinking: "plan" },
    { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
    { type: "text", text: "working" },
  ], usage(1, 2, 3, 4), "2026-07-31T01:00:00.000Z"));
  const item = claude.parseClaudeJsonlLine(`${source}\n`, 8, 123);

  assert.equal(item.rawLine, source);
  assert.equal(item.record.message.content[1].name, "Bash");
  assert.deepEqual(item.viewer.categories, ["reasoning", "tools", "assistant"]);
  assert.equal(item.viewer.provider, "claude");
  assert.equal(item.viewer.kind, "tool-use");
  assert.match(item.viewer.label, /Bash/);
  assert.equal(item.viewer.toolCount, 1);
  assert.equal(item.viewer.toolResultCount, 0);
  assert.deepEqual(item.viewer.toolNames, ["Bash"]);
  assert.equal(item.viewer.assistantMessage, "working");

  const unknown = claude.parseClaudeJsonlLine('{"type":"future-record","value":1}\n', 9, item.nextOffset);
  assert.equal(unknown.record.value, 1);
  assert.deepEqual(unknown.viewer.categories, []);
  assert.equal(unknown.viewer.kind, "future-record");

  const invalid = claude.parseClaudeJsonlLine("not-json\n", 10, unknown.nextOffset);
  assert.equal(invalid.rawLine, "not-json");
  assert.ok(invalid.error);
  assert.equal(invalid.viewer.kind, "invalid-json");
});

test("recent, byte-range, and tail reads preserve offsets and complete lines", () => {
  const fixture = createTranscript([
    { type: "mode", mode: "default" },
    userRecord("prompt-1", "one", "2026-07-31T01:00:00.000Z"),
    assistantRecord([{ type: "text", text: "two" }], usage(1, 0, 0, 1), "2026-07-31T01:00:01.000Z"),
  ]);

  try {
    const recent = claude.readRecentJsonl(fixture.file, 2);
    assert.equal(recent.records.length, 2);
    assert.equal(recent.records[0].lineNo, 2);
    assert.equal(recent.offset, fs.statSync(fixture.file).size);

    const range = claude.readJsonlRange(
      fixture.file,
      recent.records[0].offset,
      recent.records[0].nextOffset,
    );
    assert.equal(range.length, 1);
    assert.equal(range[0].record.message.content, "one");

    const tailer = new claude.ClaudeJsonlTailer(fixture.file, recent.offset);
    fs.appendFileSync(fixture.file, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]}}');
    assert.deepEqual(tailer.readAvailable(), []);
    fs.appendFileSync(fixture.file, "\n");
    const tailed = tailer.readAvailable();
    assert.equal(tailed.length, 1);
    assert.equal(tailed[0].viewer.kind, "assistant-text");
    assert.equal(tailed[0].record.message.content[0].text, "partial");
  } finally {
    fixture.cleanup();
  }
});

function userRecord(uuid, content, timestamp) {
  return {
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content },
    uuid,
    promptId: uuid,
    timestamp,
    origin: { kind: "human" },
    promptSource: "typed",
    userType: "external",
    cwd: "/workspace/viewer",
    sessionId: "session-1",
    version: "1.0.80",
  };
}

function assistantRecord(content, recordUsage, timestamp) {
  return {
    parentUuid: "prompt-1",
    isSidechain: false,
    type: "assistant",
    uuid: `assistant-${timestamp}`,
    timestamp,
    message: {
      id: `message-${timestamp}`,
      model: "claude-opus-4-1",
      role: "assistant",
      type: "message",
      usage: recordUsage,
      content,
    },
    cwd: "/workspace/viewer",
    sessionId: "session-1",
    version: "1.0.80",
  };
}

function usage(input, cacheCreation, cacheRead, output) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
  };
}

function createTranscript(records) {
  const root = temporaryRoot();
  const file = path.join(root, "session.jsonl");
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return {
    file,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-viewer-test-"));
}

function hasStatus(status) {
  return (error) => error && error.status === status;
}
