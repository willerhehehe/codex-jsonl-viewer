const { spawn } = require("node:child_process");
const { DEFAULT_ROOT, createHttpServer, resolveSessionsRoot } = require("./session-server");

function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    port: 8765,
    root: DEFAULT_ROOT,
    open: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--open") {
      options.open = true;
    } else if (arg === "--no-open") {
      options.open = false;
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--root") {
      options.root = nextValue(argv, index, "--root");
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

function runCli(argv = process.argv.slice(2), output = process.stdout, errorOutput = process.stderr) {
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

  const server = createHttpServer(options);
  server.listen(options.port, options.host, () => {
    const address = server.address();
    const url = `http://${options.host}:${address.port}`;
    output.write(`Codex Session Viewer\n`);
    output.write(`Serving at: ${url}\n`);
    output.write(`Session root: ${resolveSessionsRoot(options.root)}\n`);
    output.write(`Press Ctrl+C to stop.\n`);
    if (options.open) {
      openBrowser(url);
    }
  });

  server.on("error", (error) => {
    errorOutput.write(`Failed to start Codex Session Viewer: ${error.message}\n`);
    process.exitCode = 1;
  });

  return server;
}

function usage() {
  return `Usage: codex-jsonl-viewer [options]\n\n` +
    `Options:\n` +
    `  --root <path>   Codex sessions root. Defaults to ~/.codex/sessions\n` +
    `  --host <host>   Host to bind. Defaults to 127.0.0.1\n` +
    `  --port <port>   Port to bind. Defaults to 8765\n` +
    `  --open          Open the viewer in your default browser\n` +
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

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

module.exports = {
  parseArgs,
  runCli,
  usage,
};
