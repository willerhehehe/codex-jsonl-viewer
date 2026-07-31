#!/usr/bin/env node
const net = require("node:net");
const { spawn } = require("node:child_process");

async function main() {
  const spec = JSON.parse(process.argv[2] || "{}");
  validateSpec(spec);
  await waitForPortRelease(spec.host, spec.port);
  await new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: process.env,
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

function waitForPortRelease(host, port, timeoutMs = 15000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const probe = net.createServer();
      probe.once("error", (error) => {
        if (error.code === "EADDRINUSE" && Date.now() - startedAt < timeoutMs) {
          setTimeout(attempt, 100);
          return;
        }
        reject(error);
      });
      probe.listen(port, host, () => {
        probe.close(resolve);
      });
    };
    attempt();
  });
}

function validateSpec(spec) {
  if (!spec || typeof spec.command !== "string" || !Array.isArray(spec.args)) {
    throw new Error("Invalid restart specification");
  }
  if (typeof spec.host !== "string" || !Number.isInteger(spec.port)) {
    throw new Error("Invalid restart address");
  }
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = { main, validateSpec, waitForPortRelease };
