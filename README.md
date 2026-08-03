# Context Explorer

Local browser UI for following and inspecting Codex and Claude Code session JSONL files.

Use the switch in the top-left corner to move between the Codex and Claude viewers. Each provider keeps its own session discovery and JSONL parsing while sharing the turn-oriented browsing experience.

## Features

- Top-left Codex / Claude viewer switch.
- Date and rollout file picker for Codex sessions, plus project and session browsing for Claude Code.
- Live tailing through server-sent events.
- Readable event stream with filters for messages, tools, patches, errors, tokens, and context.
- Turn ledger that groups each user conversation round with compact and narrative views.
- Session-total and per-turn context composition by payload size or event count, with token deltas reported separately.
- One-click paste-ready handoff covering every turn in the selected session, including full user requests, final assistant replies, and the recorded working directory while excluding Git state and private/internal context.
- One-click `tail -F … | jq` command for the selected session file, with variants for follow, new lines only, replay from start, and raw tail, so the same session can be traced in a terminal.
- Lazy loading of raw events for a selected turn, so large sessions stay responsive.
- Inspector tabs for summary, structured JSON tree, raw JSON, and related events.
- Expand all / collapse all controls for structured JSON.
- Resizable inspector pane and latest-top / latest-bottom ordering.
- Rich rendering for embedded JSON strings, Markdown-style text, and fenced code blocks in tool outputs.
- In-app npm update checks with a one-click, parameter-preserving restart for global and `npx` launches.

## Quick Start

```bash
npx codex-jsonl-viewer
```

The command starts the local server and automatically opens the viewer in your
default browser. It also prints the local URL:

```text
http://127.0.0.1:8765
```

If port `8765` is already in use, the viewer automatically picks another available port and prints the actual URL.

The default session root is:

```text
~/.codex/sessions
```

The default Claude projects root is:

```text
~/.claude/projects
```

The page scans `~/.codex/sessions/YYYY/MM/DD`, opens the most recently modified `rollout-*.jsonl` for the selected date, and tails appended JSONL lines through server-sent events.

Switch to Claude in the top-left corner to select a project and session. The Claude viewer provides the same Turn, Events, Inspector, context-composition, Copy handoff, and Copy tail workflows where the source data supports them. Codex and Claude discovery, turn boundaries, event categories, and token metadata are parsed independently so provider-specific formats do not leak into each other.

To point either viewer at another sessions directory:

```bash
npx codex-jsonl-viewer --root /path/to/sessions
npx codex-jsonl-viewer --claude-root /path/to/claude/projects
```

Other options:

```bash
npx codex-jsonl-viewer --port 9000
npx codex-jsonl-viewer --host 0.0.0.0
npx codex-jsonl-viewer --strict-port
npx codex-jsonl-viewer --no-open
```

All session files are read locally and treated as read-only. The viewer does not upload session data.

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

## Verify

```bash
npm test
```

## In-app updates

The header checks npm for a newer version without blocking startup. When an
update is available, click the update notice and confirm to install or warm the
new package, restart the local server with the same roots, host, and port, and
reload the page automatically. Source checkouts are never modified; development
mode shows a manual update command instead.

The update action accepts only localhost requests carrying the per-process
update token. Failed installs leave the currently running server available.

## Release

Releases are created from a clean, up-to-date `main` branch. Choose the semantic
version increment and run one command:

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

The release script verifies `main`, fetches `origin/main`, runs the full test
suite and an npm package dry run, creates the version commit and matching `v*`
Git tag, then pushes `main` and the tag. The tag triggers
`.github/workflows/publish.yml`, which verifies the version again and publishes
the package to npm.

### One-time npm setup

Configure `codex-jsonl-viewer` on npm with a GitHub Actions Trusted Publisher:

- GitHub owner: `willerhehehe`
- Repository: `codex-jsonl-viewer`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

Trusted Publishing uses short-lived OIDC credentials, so the repository does
not need a long-lived `NPM_TOKEN` secret. Do not run `npm publish` manually for
normal releases.

## License

MIT
