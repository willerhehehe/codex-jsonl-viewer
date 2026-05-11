# Codex Session Viewer

Local browser UI for following and inspecting Codex session JSONL files.

It reads Codex session files from `~/.codex/sessions/YYYY/MM/DD`, renders each JSONL event into a readable stream, and provides an inspector for the underlying JSON structure.

## Features

- Date and rollout file picker for Codex session logs.
- Live tailing through server-sent events.
- Readable event stream with filters for messages, tools, patches, errors, tokens, and context.
- Inspector tabs for summary, structured JSON tree, raw JSON, and related events.
- Expand all / collapse all controls for structured JSON.
- Resizable inspector pane and latest-top / latest-bottom ordering.

## Quick Start

```bash
npx codex-jsonl-viewer
```

The command prints the local URL to open:

```text
http://127.0.0.1:8765
```

The default session root is:

```text
~/.codex/sessions
```

The page scans `~/.codex/sessions/YYYY/MM/DD`, opens the most recently modified `rollout-*.jsonl` for the selected date, and tails appended JSONL lines through server-sent events.

To point the viewer at another sessions directory:

```bash
npx codex-jsonl-viewer --root /path/to/sessions
```

Other options:

```bash
npx codex-jsonl-viewer --port 9000
npx codex-jsonl-viewer --host 0.0.0.0
npx codex-jsonl-viewer --open
```

## Local Development

```bash
git clone https://github.com/willerhehehe/codex-jsonl-viewer.git
cd codex-jsonl-viewer
npm test
node bin/codex-jsonl-viewer.js
```

## Requirements

- Node.js 18+
- No runtime npm dependencies

The repository also includes the original Python server as a fallback:

```bash
python3 server.py --port 8765
```

## Verify

```bash
npm test
```

## License

MIT
