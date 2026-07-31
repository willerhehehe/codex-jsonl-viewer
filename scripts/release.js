#!/usr/bin/env node

const { execFileSync } = require("node:child_process");

const ALLOWED_RELEASE_TYPES = new Set(["patch", "minor", "major"]);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  }).trim();
}

function read(command, args) {
  return run(command, args, { capture: true });
}

function ensureReleaseReady() {
  const branch = read("git", ["branch", "--show-current"]);
  if (branch !== "main") {
    throw new Error(`Releases must run from main; current branch is ${branch || "detached HEAD"}.`);
  }

  if (read("git", ["status", "--porcelain"])) {
    throw new Error("Working tree must be clean before releasing.");
  }

  run("git", ["fetch", "origin", "main"]);
  const localHead = read("git", ["rev-parse", "HEAD"]);
  const remoteHead = read("git", ["rev-parse", "origin/main"]);
  if (localHead !== remoteHead) {
    throw new Error("Local main must exactly match origin/main before releasing.");
  }
}

function release(releaseType) {
  if (!ALLOWED_RELEASE_TYPES.has(releaseType)) {
    throw new Error("Usage: node scripts/release.js <patch|minor|major>");
  }

  ensureReleaseReady();
  run("npm", ["test"]);
  run("npm", ["pack", "--dry-run"]);
  run("npm", ["version", releaseType]);
  run("git", ["push", "origin", "main", "--follow-tags"]);
}

if (require.main === module) {
  try {
    release(process.argv[2]);
  } catch (error) {
    console.error(`Release failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { ensureReleaseReady, release };
