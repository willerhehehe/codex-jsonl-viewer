const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PACKAGE_NAME = "codex-jsonl-viewer";
const DEFAULT_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts.numbers[index] !== rightParts.numbers[index]) {
      return leftParts.numbers[index] < rightParts.numbers[index] ? -1 : 1;
    }
  }
  if (leftParts.prerelease === rightParts.prerelease) {
    return 0;
  }
  if (!leftParts.prerelease) {
    return 1;
  }
  if (!rightParts.prerelease) {
    return -1;
  }
  return leftParts.prerelease.localeCompare(rightParts.prerelease, "en", { numeric: true });
}

function parseVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) {
    throw new Error(`Invalid semantic version: ${value}`);
  }
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] || "",
  };
}

function detectInstallMode(packageRoot = path.resolve(__dirname, ".."), env = process.env) {
  if (fs.existsSync(path.join(packageRoot, ".git"))) {
    return "source";
  }
  const normalized = packageRoot.split(path.sep).join("/");
  if (normalized.includes("/_npx/") || env.npm_command === "exec") {
    return "npx";
  }
  if (normalized.includes("/lib/node_modules/") || normalized.includes("/npm/node_modules/")) {
    return "global";
  }
  return "package";
}

async function fetchLatestVersion(packageName = DEFAULT_PACKAGE_NAME, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js version cannot check npm for updates");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`npm registry returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    parseVersion(payload.version);
    return String(payload.version);
  } finally {
    clearTimeout(timeout);
  }
}

function createUpdateManager({
  currentVersion,
  packageName = DEFAULT_PACKAGE_NAME,
  installMode = detectInstallMode(),
  latestVersionProvider = () => fetchLatestVersion(packageName),
  commandRunner = runCommand,
  restartProcess = null,
  checkTtlMs = DEFAULT_CHECK_TTL_MS,
  now = () => Date.now(),
} = {}) {
  parseVersion(currentVersion);
  const state = {
    latestVersion: "",
    checkedAt: 0,
    phase: "idle",
    error: "",
    targetVersion: "",
  };
  let checkPromise = null;
  let updatePromise = null;

  const canAutoUpdate = Boolean(restartProcess) && (installMode === "global" || installMode === "npx");

  function snapshot() {
    const updateAvailable = Boolean(state.latestVersion)
      && compareVersions(currentVersion, state.latestVersion) < 0;
    return {
      currentVersion,
      latestVersion: state.latestVersion,
      updateAvailable,
      installMode,
      canAutoUpdate,
      phase: state.phase,
      error: state.error,
      targetVersion: state.targetVersion,
      checkedAt: state.checkedAt ? new Date(state.checkedAt).toISOString() : "",
      manualCommand: manualUpdateCommand(installMode, packageName),
    };
  }

  async function check({ force = false } = {}) {
    const fresh = state.checkedAt && now() - state.checkedAt < checkTtlMs;
    if (!force && fresh) {
      return snapshot();
    }
    if (checkPromise) {
      await checkPromise;
      return snapshot();
    }
    checkPromise = (async () => {
      const previousPhase = state.phase;
      if (previousPhase === "idle" || previousPhase === "failed") {
        state.phase = "checking";
      }
      try {
        const latestVersion = await latestVersionProvider();
        parseVersion(latestVersion);
        state.latestVersion = latestVersion;
        state.checkedAt = now();
        if (previousPhase === "idle" || previousPhase === "failed") {
          state.phase = "idle";
          state.error = "";
        }
      } catch (error) {
        if (previousPhase === "idle" || previousPhase === "failed") {
          state.phase = "failed";
          state.error = `Update check failed: ${error.message}`;
        }
      } finally {
        checkPromise = null;
      }
    })();
    await checkPromise;
    return snapshot();
  }

  async function startUpdate() {
    if (updatePromise) {
      return snapshot();
    }
    await check({ force: true });
    const status = snapshot();
    if (!status.updateAvailable) {
      return status;
    }
    if (!canAutoUpdate) {
      const error = new Error("Automatic updates are unavailable for this installation mode");
      error.status = 409;
      error.manualCommand = status.manualCommand;
      throw error;
    }

    state.phase = "installing";
    state.error = "";
    state.targetVersion = state.latestVersion;
    updatePromise = performUpdate(state.targetVersion)
      .catch((error) => {
        state.phase = "failed";
        state.error = `Update failed: ${error.message}`;
      })
      .finally(() => {
        updatePromise = null;
      });
    return snapshot();
  }

  async function performUpdate(targetVersion) {
    const packageSpec = `${packageName}@${targetVersion}`;
    if (installMode === "global") {
      await commandRunner(npmCommand(), ["install", "-g", packageSpec]);
    } else {
      await commandRunner(npxCommand(), ["-y", packageSpec, "--help"]);
    }
    state.phase = "restarting";
    await restartProcess({ installMode, packageName, targetVersion });
  }

  return {
    getStatus: check,
    snapshot,
    startUpdate,
    waitForUpdate: () => updatePromise || Promise.resolve(),
  };
}

function manualUpdateCommand(installMode, packageName = DEFAULT_PACKAGE_NAME) {
  if (installMode === "source") {
    return "git pull --ff-only && npm test";
  }
  if (installMode === "npx") {
    return `npx -y ${packageName}@latest`;
  }
  return `npm install -g ${packageName}@latest`;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      errorText = `${errorText}${chunk}`.slice(-4000);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = errorText.trim() || `exit ${code ?? signal}`;
      reject(new Error(detail));
    });
  });
}

module.exports = {
  DEFAULT_CHECK_TTL_MS,
  compareVersions,
  createUpdateManager,
  detectInstallMode,
  fetchLatestVersion,
  manualUpdateCommand,
  npmCommand,
  npxCommand,
  parseVersion,
  runCommand,
};
