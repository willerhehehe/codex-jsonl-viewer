# Codex Session Viewer

Local browser UI for following and inspecting Codex session JSONL files.

It reads Codex session files from `~/.codex/sessions/YYYY/MM/DD`, renders each JSONL event into a readable stream, and provides an inspector for the underlying JSON structure.

## Features

- Date and rollout file picker for Codex session logs.
- Live tailing through server-sent events.
- Readable event stream with filters for messages, tools, patches, errors, tokens, and context.
- Turn ledger that groups each user conversation round with compact and narrative views.
- Session-total and per-turn context composition by payload size or event count, with token deltas reported separately.
- One-click paste-ready session handoff through the selected turn, including the recorded working directory while excluding Git state and private/internal context.
- One-click `tail -F … | jq` command for the selected rollout file, with variants for follow, new lines only, replay from start, and raw tail, so the same session can be traced in a terminal.
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

The command prints the local URL to open:

```text
http://127.0.0.1:8765
```

If port `8765` is already in use, the viewer automatically picks another available port and prints the actual URL.

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
npx codex-jsonl-viewer --strict-port
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

## Verify

```bash
npm test
```

## In-app updates

The header checks npm for a newer version without blocking startup. When an
update is available, click the version badge and confirm to install or warm the
new package, restart the local server with the same root, host, and port, and
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
