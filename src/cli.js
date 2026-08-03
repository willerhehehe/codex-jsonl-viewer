const { spawn } = require("node:child_process");
const path = require("node:path");
const { DEFAULT_CLAUDE_ROOT, resolveProjectsRoot } = require("./claude-viewer");
const { DEFAULT_ROOT, createHttpServer, resolveSessionsRoot } = require("./session-server");
const { npxCommand } = require("./update-manager");

function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    port: 8765,
    root: DEFAULT_ROOT,
    claudeRoot: DEFAULT_CLAUDE_ROOT,
    open: true,
    help: false,
    strictPort: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--strict-port") {
      options.strictPort = true;
    } else if (arg === "--open") {
      options.open = true;
    } else if (arg === "--no-open") {
      options.open = false;
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--root") {
      options.root = nextValue(argv, index, "--root");
      index += 1;
    } else if (arg.startsWith("--claude-root=")) {
      options.claudeRoot = arg.slice("--claude-root=".length);
    } else if (arg === "--claude-root") {
      options.claudeRoot = nextValue(argv, index, "--claude-root");
      index += 1;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
    } else if (arg === "--host") {
      options.host = nextValue(argv, index, "--host");
      index += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length));
    } else if (arg === "--port") {
      options.port = parsePort(nextValue(argv, index, "--port"));
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function runCli(argv = process.argv.slice(2), output = process.stdout, errorOutput = process.stderr, dependencies = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    errorOutput.write(`${error.message}\n\n${usage()}`);
    return 2;
  }

  if (options.help) {
    output.write(usage());
    return 0;
  }

  const browserOpener = dependencies.openBrowser || openBrowser;
  let server;
  const restartProcess = (update) => restartCli(server, options, update);
  server = createHttpServer({ ...options, restartProcess });
  const startPort = options.port;
  const onListening = () => {
    const address = server.address();
    const url = `http://${options.host}:${address.port}`;
    output.write(`Context Explorer\n`);
    if (startPort !== 0 && address.port !== startPort) {
      output.write(`Port ${startPort} is busy; using available port ${address.port}.\n`);
    }
    output.write(`Serving at: ${url}\n`);
    output.write(`Session root: ${resolveSessionsRoot(options.root)}\n`);
    output.write(`Claude root: ${resolveProjectsRoot(options.claudeRoot)}\n`);
    output.write(`Press Ctrl+C to stop.\n`);
    if (options.open) {
      browserOpener(url, (error) => {
        errorOutput.write(`Could not open the default browser automatically: ${error.message}\n`);
        errorOutput.write(`Open ${url} manually.\n`);
      });
    }
  };
  const onError = (error) => {
    if (error.code === "EADDRINUSE" && !options.strictPort && startPort !== 0) {
      server.off("error", onError);
      server.listen(0, options.host);
      return;
    }
    errorOutput.write(`Failed to start Context Explorer: ${error.message}\n`);
    process.exitCode = 1;
  };

  server.once("listening", onListening);
  server.on("error", onError);
  server.listen(startPort, options.host);

  return server;
}

function usage() {
  return `Usage: codex-jsonl-viewer [options]\n\n` +
    `Options:\n` +
    `  --root <path>   Codex sessions root. Defaults to ~/.codex/sessions\n` +
    `  --claude-root <path>  Claude projects root. Defaults to ~/.claude/projects\n` +
    `  --host <host>   Host to bind. Defaults to 127.0.0.1\n` +
    `  --port <port>   Port to bind. Defaults to 8765\n` +
    `  --strict-port   Fail instead of using another port when the requested port is busy\n` +
    `  --open          Open the viewer in your default browser (default)\n` +
    `  --no-open       Do not open a browser automatically\n` +
    `  -h, --help      Show this help\n`;
}

function nextValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  return port;
}

function openBrowser(url, onError = () => {}) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.once("error", onError);
  child.unref();
  return child;
}

function serializeCliArgs(options) {
  const args = [
    "--root", options.root,
  ];
  if (options.claudeRoot) {
    args.push("--claude-root", options.claudeRoot);
  }
  args.push(
    "--host", options.host,
    "--port", String(options.port),
    "--no-open",
  );
  if (options.strictPort) {
    args.push("--strict-port");
  }
  return args;
}

function buildRestartSpec(update, options, entryPath = path.resolve(__dirname, "..", "bin", "codex-jsonl-viewer.js")) {
  const cliArgs = serializeCliArgs(options);
  if (update.installMode === "npx") {
    return {
      command: npxCommand(),
      args: ["-y", `${update.packageName}@${update.targetVersion}`, ...cliArgs],
      cwd: process.cwd(),
      host: options.host,
      port: options.port,
    };
  }
  return {
    command: process.execPath,
    args: [entryPath, ...cliArgs],
    cwd: process.cwd(),
    host: options.host,
    port: options.port,
  };
}

async function restartCli(server, options, update) {
  const address = server.address();
  const restartOptions = {
    ...options,
    port: typeof address === "object" && address ? address.port : options.port,
    open: false,
    strictPort: true,
  };
  const spec = buildRestartSpec(update, restartOptions);
  const helperPath = path.join(__dirname, "restart-helper.js");
  await spawnDetached(process.execPath, [helperPath, JSON.stringify(spec)]);
  await new Promise((resolve) => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  });
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

module.exports = {
  buildRestartSpec,
  parseArgs,
  runCli,
  serializeCliArgs,
  usage,
};
