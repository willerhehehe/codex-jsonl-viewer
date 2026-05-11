#!/usr/bin/env node
const { runCli } = require("../src/cli");

const result = runCli();
if (typeof result === "number") {
  process.exitCode = result;
}
