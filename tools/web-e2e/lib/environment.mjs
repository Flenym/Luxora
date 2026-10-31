/**
 * Environment orchestration for the Luxora web messenger E2E gate.
 *
 * Responsibilities:
 * - locate the repo, artifacts and temp directories;
 * - generate throw-away development secrets (never logged, never committed);
 * - optionally build the API/web workspaces when their dist output is missing;
 * - spawn/stop the API (fresh SQLite DB under a temp dir) and `vite preview`;
 * - wait for readiness over HTTP with bounded polling;
 * - detect a usable Chrome/Chromium binary (CHROME_PATH override).
 *
 * Everything here is deliberately dependency-free (Node built-ins only) so the
 * runner works on CI before its single npm dependency (puppeteer-core) loads.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(TOOL_ROOT, "..", "..");

export const DEFAULT_API_BASE = "http://127.0.0.1:2222";
export const DEFAULT_WEB_BASE = "http://127.0.0.1:4173";

/** Filesystem-safe UTC timestamp for artifact names. */
export function timestamp() {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

export function log(message) {
  console.log(`[web-e2e] ${message}`);
}

export function warn(message) {
  console.warn(`[web-e2e] WARNING: ${message}`);
}

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms: ${label}`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Create the artifacts directory (kept for CI upload) and a disposable temp dir. */
export function createRunDirectories() {
  const configuredArtifactsDir = process.env["E2E_ARTIFACTS_DIR"];
  const artifactsDir = configuredArtifactsDir !== undefined && configuredArtifactsDir !== ""
    ? resolve(configuredArtifactsDir)
    : join(TOOL_ROOT, "artifacts");
  const logsDir = join(artifactsDir, "logs");
  const screenshotsDir = join(artifactsDir, "screenshots");
  // A previous local run must never leak stale "failure-*.png" screenshots into
  // a CI artifact upload for an unrelated failure.
  rmSync(logsDir, { recursive: true, force: true });
  rmSync(screenshotsDir, { recursive: true, force: true });
  rmSync(join(artifactsDir, "e2e-report.json"), { force: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(screenshotsDir, { recursive: true });
  const runDir = mkdtempSync(join(tmpdir(), "luxora-web-e2e-"));
  return { artifactsDir, logsDir, screenshotsDir, runDir };
}

/** Secrets generated per run; they never leave the child process environment. */
export function generateDevSecrets() {
  return {
    jwtSecret: randomBytes(48).toString("base64url"),
    dataEncryptionKeys: JSON.stringify({ main: randomBytes(32).toString("base64url") }),
    adminToken: randomBytes(32).toString("base64url")
  };
}

/** Follow redirects and treat non-2xx as "not ready yet". */
export async function httpStatus(url, timeoutMs = 3_000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    return response.status;
  } catch {
    return 0;
  }
}

/**
 * Poll one or more probe paths until a 2xx (and optional body validation)
 * succeeds. Used instead of fixed sleeps so slow CI runners are tolerated.
 */
export async function waitForHttpReady(baseUrl, paths, options = {}) {
  const label = options.label ?? baseUrl;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 250;
  const started = Date.now();
  let lastStatus = 0;
  while (Date.now() - started < timeoutMs) {
    for (const path of paths) {
      try {
        const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(3_000), redirect: "follow" });
        lastStatus = response.status;
        if (response.ok) {
          if (options.validate === undefined) return;
          const body = await response.text();
          if (options.validate(body)) return;
        }
      } catch {
        // Process not listening yet.
      }
    }
    if (process.env["E2E_VERBOSE"] === "1") {
      log(`waiting for ${label} (${baseUrl}${paths[0]}), last HTTP ${lastStatus}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} did not become ready at ${baseUrl} within ${timeoutMs}ms (last HTTP ${lastStatus})`);
}

/* --------------------------------------------------------------- processes */

const spawnedProcesses = [];

function npmInvocation(prefix, script) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return { command: npm, args: ["--prefix", prefix, "run", script] };
}

/** Run an npm script synchronously (used only when a dist folder is missing). */
function runNpmScript(prefixRelPath, script) {
  const prefix = join(REPO_ROOT, prefixRelPath);
  const { command } = npmInvocation(prefix, script);
  // Paths on this repo can contain spaces (OneDrive/Windows), so pass one
  // explicitly quoted command line to the shell instead of argv items.
  const quote = (value) => `"${value.replace(/"/gu, '\\"')}"`;
  const commandLine = `${quote(command)} --prefix ${quote(prefix)} run ${script}`;
  log(`building missing output: npm --prefix ${prefixRelPath} run ${script}`);
  const result = spawnSync(commandLine, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: true,
    timeout: 600_000
  });
  if (result.status !== 0) {
    throw new Error(`npm --prefix ${prefixRelPath} run ${script} failed with status ${String(result.status)}`);
  }
}

export function ensureApiBuild() {
  const serverEntry = join(REPO_ROOT, "services", "api", "dist", "server.js");
  if (existsSync(serverEntry)) return;
  runNpmScript("packages/protocol", "build");
  runNpmScript("packages/passkey-domain", "build");
  runNpmScript("packages/call-control", "build");
  runNpmScript("services/api", "build");
}

export function ensureWebBuild() {
  const indexHtml = join(REPO_ROOT, "apps", "web", "dist", "index.html");
  if (existsSync(indexHtml)) return;
  runNpmScript("apps/web", "build");
}

/** Last lines of a captured child log, for failure diagnostics. */
export function tailFile(filePath, lines = 20) {
  try {
    const content = readFileSync(filePath, "utf8");
    return content.split(/\r?\n/u).filter((line) => line.trim() !== "").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** Fail fast when a spawned service dies during startup instead of polling a port. */
export function assertProcessRunning(spawned, label) {
  if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
    const tail = tailFile(spawned.logPath);
    throw new Error(
      `${label} exited during startup (code=${String(spawned.child.exitCode)} signal=${String(spawned.child.signalCode)})\n${tail}`
    );
  }
}

function spawnLogged(label, command, args, options, logPath) {
  const logStream = createWriteStream(logPath, { flags: "w" });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  child.once("exit", (code, signal) => {
    logStream.write(`\n[web-e2e] ${label} exited code=${String(code)} signal=${String(signal)}\n`);
  });
  const spawned = { label, child, logPath };
  spawnedProcesses.push(spawned);
  return spawned;
}

function killProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
}

export async function stopSpawnedProcess(spawned, graceMs = 5_000) {
  const child = spawned.child;
  if (child.exitCode !== null || child.signalCode !== null) return;
  killProcessTree(child);
  const started = Date.now();
  while (Date.now() - started < graceMs && child.exitCode === null && child.signalCode === null) {
    await sleep(100);
  }
  if (child.exitCode === null && child.signalCode === null && process.platform !== "win32") {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Stop every spawned child (reverse order) and clear the registry. */
export async function stopAllSpawnedProcesses() {
  const pending = spawnedProcesses.splice(0, spawnedProcesses.length).reverse();
  await Promise.all(pending.map((spawned) => stopSpawnedProcess(spawned)));
}

/* ------------------------------------------------------------------ API */

export function startApi(options) {
  ensureApiBuild();
  const serverEntry = join(REPO_ROOT, "services", "api", "dist", "server.js");
  const baseUrl = `http://127.0.0.1:${options.apiPort}`;
  const logPath = join(options.logsDir, "api.log");
  const env = {
    ...process.env,
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(options.apiPort),
    DATABASE_PATH: join(options.runDir, "luxora.db"),
    STORAGE_LOCAL_PATH: join(options.runDir, "blobs"),
    UPLOAD_STAGING_PATH: join(options.runDir, "uploads"),
    JWT_SECRET: options.secrets.jwtSecret,
    DATA_ENCRYPTION_KEYS: options.secrets.dataEncryptionKeys,
    ACTIVE_DATA_ENCRYPTION_KEY_ID: "main",
    ADMIN_TOKEN: options.secrets.adminToken,
    PHONE_AUTH_ENABLED: "false",
    CORS_ORIGINS: [
      `http://127.0.0.1:${options.webPort}`,
      `http://localhost:${options.webPort}`
    ].join(","),
    // Never inherit a caller's proxy/feature flags that could alter the contract.
    TRUST_PROXY: "0"
  };
  log(`starting API on ${baseUrl} (fresh SQLite database in the temp directory)`);
  const spawned = spawnLogged("api", process.execPath, [serverEntry], { cwd: REPO_ROOT, env }, logPath);
  return { baseUrl, logPath, spawned };
}

export async function waitForApiReady(apiBase) {
  await waitForHttpReady(apiBase, ["/health/ready", "/health/live"], {
    label: "Luxora API",
    timeoutMs: 120_000
  });
}

/* ------------------------------------------------------------------ Web */

export function startWebPreview(options) {
  ensureWebBuild();
  const viteBin = join(REPO_ROOT, "apps", "web", "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) {
    throw new Error(`vite not found at ${viteBin}; run "npm --prefix apps/web ci" first`);
  }
  const baseUrl = `http://127.0.0.1:${options.webPort}`;
  const logPath = join(options.logsDir, "vite-preview.log");
  const env = { ...process.env, NODE_ENV: "production" };
  log(`starting vite preview on ${baseUrl} (same-origin proxy target is port ${options.apiPort})`);
  const spawned = spawnLogged(
    "vite-preview",
    process.execPath,
    [viteBin, "preview", "--host", "127.0.0.1", "--port", String(options.webPort), "--strictPort"],
    { cwd: join(REPO_ROOT, "apps", "web"), env },
    logPath
  );
  return { baseUrl, logPath, spawned };
}

export async function waitForWebReady(webBase) {
  await waitForHttpReady(webBase, ["/app"], {
    label: "web messenger (vite preview)",
    timeoutMs: 90_000,
    validate: (body) => /<div id="root">/u.test(body) || /<script[^>]+src="\/assets\//u.test(body)
  });
}

/* --------------------------------------------------------------- Chrome */

export function findChromeExecutable() {
  const override = process.env["CHROME_PATH"];
  if (override !== undefined && override.trim() !== "") {
    if (!existsSync(override)) {
      throw new Error(`CHROME_PATH is set but does not exist: ${override}`);
    }
    return override;
  }
  const candidates = [];
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] ?? "";
    candidates.push(
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      ...(localAppData === "" ? [] : [join(localAppData, "Google", "Chrome", "Application", "chrome.exe")]),
      join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe")
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium"
    );
  }
  for (const candidate of candidates) {
    if (candidate !== "" && existsSync(candidate)) return candidate;
  }
  throw new Error(
    `No Chrome/Chromium executable found (looked at: ${candidates.filter(Boolean).join(", ")}). Set CHROME_PATH.`
  );
}

export function chromeLaunchArgs() {
  return [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check"
  ];
}

/* --------------------------------------------------------------- cleanup */

export function removeRunDirectory(runDir) {
  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch (error) {
    warn(`could not remove temp directory ${runDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Resolve user-provided base URLs against our defaults. */
export function normalizeBaseUrl(value, fallback) {
  const candidate = (value === undefined || value.trim() === "" ? fallback : value).trim();
  return candidate.replace(/\/+$/u, "");
}
