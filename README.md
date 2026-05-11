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

## Run

```bash
git clone https://github.com/<owner>/codex-session-viewer.git
cd codex-session-viewer
python3 server.py --port 8765
```

Open:

```text
http://127.0.0.1:8765
```

Default session root:

```text
~/.codex/sessions
```

The page scans `~/.codex/sessions/YYYY/MM/DD`, opens the most recently modified `rollout-*.jsonl` for the selected date, and tails appended JSONL lines through server-sent events.

To point the viewer at another sessions directory:

```bash
python3 server.py --root /path/to/sessions --port 8765
```

## Requirements

- Python 3.10+
- No third-party Python packages

## Verify

```bash
python3 -m unittest discover -s tests -v
python3 -m py_compile server.py
```

## License

MIT
