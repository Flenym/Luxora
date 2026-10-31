#!/usr/bin/env node
/**
 * Luxora web messenger end-to-end gate.
 *
 * Default mode is fully self-contained:
 *   1. build API/web dist if missing (CI pre-builds them),
 *   2. spawn the API on 127.0.0.1:2222 with a fresh SQLite DB and per-run dev
 *      secrets (JWT_SECRET / DATA_ENCRYPTION_KEYS / ADMIN_TOKEN) in a temp dir,
 *   3. spawn `vite preview` on 127.0.0.1:4173 (its config proxies /v1,/v2,/health
 *      to port 2222, so the browser only ever talks to one origin),
 *   4. register two throw-away accounts, then drive two isolated Chrome contexts
 *      through the real UI: auth error, sign-in, stranger-Direct guard ->
 *      message request -> accept, realtime message, reply, delivery ticks,
 *      image upload, honest calls gating, profile, sign-out,
 *   5. print a PASS/FAIL matrix, write artifacts/e2e-report.json and screenshots,
 *      exit non-zero on failure, and always tear down the processes it spawned.
 *
 * Attach mode (for local iteration against already-running servers):
 *   node runner.mjs --attach
 *   node runner.mjs --api-base http://127.0.0.1:2222 --web-base http://127.0.0.1:4173
 *
 * Self-check for the spawn/env/teardown path without touching 2222/4173:
 *   node runner.mjs --api-only-check
 *
 * Never logs tokens or passwords. Set CHROME_PATH to override Chrome detection.
 */
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import {
  DEFAULT_API_BASE,
  DEFAULT_WEB_BASE,
  TOOL_ROOT,
  assertProcessRunning,
  chromeLaunchArgs,
  createRunDirectories,
  findChromeExecutable,
  generateDevSecrets,
  log,
  normalizeBaseUrl,
  removeRunDirectory,
  sleep,
  startApi,
  startWebPreview,
  stopAllSpawnedProcesses,
  tailFile,
  waitForApiReady,
  waitForWebReady,
  warn
} from "./lib/environment.mjs";

const HONEST_CALLS_PATTERN = /(calls? (are )?not connected|not connected|звонк[а-яё]* не подключен)/iu;
const MAX_CONSOLE_ERRORS_REPORTED = 5;

/* --------------------------------------------------------------- CLI args */

const argv = process.argv.slice(2);

function argValue(name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? "" : value;
}

const attachMode = argv.includes("--attach");
const apiOnlyCheck = argv.includes("--api-only-check");
const keepTemp = argv.includes("--keep-temp") || process.env["E2E_KEEP_TEMP"] === "1";
const explicitApiBase = argValue("--api-base");
const explicitWebBase = argValue("--web-base");
const apiPort = Number(argValue("--api-port") ?? process.env["E2E_API_PORT"] ?? 2222);
const webPort = Number(argValue("--web-port") ?? process.env["E2E_WEB_PORT"] ?? 4173);

if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65_535) throw new Error(`invalid --api-port: ${String(apiPort)}`);
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65_535) throw new Error(`invalid --web-port: ${String(webPort)}`);

/* ------------------------------------------------------------- reporting */

const runStartedAt = Date.now();
const results = [];
const screenshots = [];
const consoleErrors = [];

function truncate(value, max = 300) {
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function record(step, ok, detail = "") {
  results.push({ step, ok, detail, atMs: Date.now() - runStartedAt });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail === "" ? "" : ` — ${detail}`}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Reject as soon as a spawned service exits during startup instead of polling a
 * dead port for the whole readiness timeout. The catch keeps the losing promise
 * from becoming an unhandled rejection after the race resolves.
 */
function failOnProcessExit(spawned, label) {
  const watcher = new Promise((_resolve, reject) => {
    spawned.child.once("exit", (code, signal) => {
      reject(new Error(`${label} exited during startup (code=${String(code)} signal=${String(signal)})\n${tailFile(spawned.logPath)}`));
    });
  });
  watcher.catch(() => undefined);
  return watcher;
}

/* -------------------------------------------------------------- API helpers */

async function apiRequest(apiBase, method, path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(20_000),
    redirect: "follow"
  });
  const text = await response.text();
  let json = null;
  try {
    json = text.length === 0 ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  let retryAfterMs = 0;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) retryAfterMs = Math.ceil(seconds * 1_000);
  }
  return { status: response.status, json, retryAfterMs };
}

function makeUsername(prefix, suffix) {
  return `${prefix}${suffix}`.toLowerCase().replace(/[^a-z0-9_]/gu, "").slice(0, 32);
}

/** CSPRNG-backed token used for account uniqueness and message stamps. */
function randomToken(bytes = 6) {
  return randomBytes(bytes).toString("hex");
}

/** CSPRNG-backed throw-away account password (32 chars; API accepts 12-128). */
function randomPassword() {
  return randomBytes(24).toString("base64url");
}

/**
 * Register a fresh throw-away account. New usernames keep runs independent even
 * against a long-lived local database (attach mode); the bounded 429 loop keeps
 * repeated local runs inside the server register rate limit.
 */
async function registerAccount(apiBase, account, attempts = 4) {
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await apiRequest(apiBase, "POST", "/v1/auth/register", {
      body: {
        username: account.username,
        displayName: account.displayName,
        password: account.password,
        deviceName: "Luxora web E2E"
      }
    });
    if (response.status === 201) return response.json;
    if (response.status === 429) {
      const waitMs = response.retryAfterMs > 0 ? response.retryAfterMs : 20_000;
      log(`register rate-limited; retrying in ${Math.round(waitMs / 1_000)}s (attempt ${attempt}/${attempts})`);
      await sleep(waitMs);
      continue;
    }
    if (response.status === 409) {
      lastError = "username already taken";
      account.username = makeUsername("e2e", randomToken(6));
      continue;
    }
    lastError = `HTTP ${response.status} ${truncate(JSON.stringify(response.json ?? {}), 200)}`;
    break;
  }
  throw new Error(`could not register the E2E account: ${lastError}`);
}

/* ---------------------------------------------------------------- browser */

async function waitForSelector(page, selector, timeout = 30_000, visible = true) {
  await page.waitForSelector(selector, { visible, timeout });
}

async function waitForSelectorAbsent(page, selector, timeout = 20_000) {
  await page.waitForFunction(
    (query) => document.querySelector(query) === null,
    { timeout },
    selector
  );
}

/**
 * Poll body text with an arbitrary predicate (kept in Node so the predicate can
 * be a JS closure rather than a serialized regexp).
 */
async function waitForBodyText(page, predicate, label, timeout = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    if (predicate(text)) return text;
    await sleep(200);
  }
  throw new Error(`timed out after ${timeout}ms waiting for body text: ${label}`);
}

async function waitForEnabled(page, selector, timeout = 20_000) {
  await page.waitForFunction(
    (query) => {
      const element = document.querySelector(query);
      return element !== null && !(element instanceof HTMLButtonElement && element.disabled);
    },
    { timeout, polling: 100 },
    selector
  );
}

/**
 * Set an input/textarea value the way React expects: use the native prototype
 * value setter then dispatch a bubbling `input` event. This replaces typing so
 * values are always exact (no triple-click selection races or duplicated text)
 * and the controlled React state follows.
 */
async function fillTestId(page, testId, value) {
  const selector = `[data-testid="${testId}"]`;
  await waitForSelector(page, selector);
  await page.evaluate((query, nextValue) => {
    const element = document.querySelector(query);
    if (element === null || !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      throw new Error(`not an input/textarea: ${query}`);
    }
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter === undefined) throw new Error(`no native value setter for ${query}`);
    element.focus();
    setter.call(element, nextValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector, value);
  await page.waitForFunction(
    (query, expected) => {
      const element = document.querySelector(query);
      return element !== null && element.value === expected;
    },
    { timeout: 10_000, polling: 100 },
    selector,
    value
  );
}

async function clickTestId(page, testId) {
  const selector = `[data-testid="${testId}"]`;
  await waitForSelector(page, selector);
  await page.click(selector);
}

async function bodyText(page) {
  return page.evaluate(() => document.body?.innerText ?? "");
}

async function screenshot(page, name) {
  try {
    const file = join(runDirectories.screenshotsDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    screenshots.push(file);
    return file;
  } catch (error) {
    warn(`screenshot ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function openChatRow(page, titlePart) {
  const rows = await page.$$('[data-testid^="chat-row-"]');
  for (const row of rows) {
    const text = await row.evaluate((node) => node.textContent ?? "");
    if (text.includes(titlePart)) {
      const testId = await row.evaluate((node) => node.getAttribute("data-testid"));
      await page.click(`[data-testid="${testId}"]`);
      return testId;
    }
  }
  return null;
}

async function gotoAuth(page, webBase) {
  await page.goto(`${webBase}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForSelector(page, '[data-testid="auth-username"]', 40_000);
}

async function signIn(page, account) {
  await fillTestId(page, "auth-username", account.username);
  await fillTestId(page, "auth-password", account.password);
  await waitForEnabled(page, '[data-testid="auth-submit"]');
  await clickTestId(page, "auth-submit");
  try {
    await waitForSelector(page, '[data-testid="app-shell"]', 40_000);
  } catch (error) {
    const authError = await page
      .$eval('[data-testid="auth-error"]', (node) => (node.textContent ?? "").trim())
      .catch(() => "");
    throw new Error(
      `sign-in did not reach the app shell (auth error: ${truncate(authError, 160) || "none"}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/* --------------------------------------------------------------- processes */

let runDirectories = null;
let browser = null;
let pageA = null;
let pageB = null;
let cleanedUp = false;

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (browser !== null) {
    try {
      await browser.close();
    } catch {
      // Chrome may already be gone after a crash/SIGTERM.
    }
    browser = null;
  }
  try {
    await stopAllSpawnedProcesses();
  } catch (error) {
    warn(`process cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (runDirectories !== null && !keepTemp) {
    removeRunDirectory(runDirectories.runDir);
  } else if (runDirectories !== null) {
    log(`keeping temp directory: ${runDirectories.runDir}`);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    log(`received ${signal}; cleaning up child processes`);
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

/* -------------------------------------------------------------- self-check */

async function runApiOnlyCheck() {
  log("API-only self-check: spawn a throw-away API and tear it down");
  const apiCheckPort = Number(argValue("--api-port") ?? 2232);
  const api = startApi({
    apiPort: apiCheckPort,
    runDir: runDirectories.runDir,
    secrets: generateDevSecrets(),
    logsDir: runDirectories.logsDir,
    webPort
  });
  await Promise.race([waitForApiReady(api.baseUrl), failOnProcessExit(api.spawned, "Luxora API")]);
  assertProcessRunning(api.spawned, "Luxora API");
  const capabilities = await apiRequest(api.baseUrl, "GET", "/v1/capabilities");
  assert(capabilities.status === 200, `capabilities answered HTTP ${capabilities.status}`);
  assert(capabilities.json?.features?.passwordAuthentication === true, "password authentication is not enabled");
  assert(capabilities.json?.features?.messaging === true, "messaging is not enabled");
  assert(capabilities.json?.features?.calls === false, "self-check expected calls=false (no media plane)");
  record("API-only self-check (fresh DB + generated secrets)", true, `features ok, calls=${String(capabilities.json.features.calls)}`);
  await stopAllSpawnedProcesses();
  log(`API self-check log: ${api.logPath}`);
}

/* ------------------------------------------------------------------- suite */

async function runBrowserSuite({ apiBase, webBase, accountA, accountB }) {
  const chromePath = findChromeExecutable();
  log(`Chrome: ${chromePath}`);
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: chromeLaunchArgs(),
    protocolTimeout: 120_000
  });
  log(`Chrome version: ${await browser.version()}`);

  const contextA = await browser.createBrowserContext();
  const contextB = await browser.createBrowserContext();
  pageA = await contextA.newPage();
  pageB = await contextB.newPage();
  for (const [label, page] of [["A", pageA], ["B", pageB]]) {
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(60_000);
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    page.on("pageerror", (error) => {
      consoleErrors.push(`${label} pageerror: ${error instanceof Error ? error.message : String(error)}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`${label} console: ${message.text()}`);
    });
  }

  // 1. Auth screen + honest wrong-password error.
  await gotoAuth(pageA, webBase);
  await screenshot(pageA, "01-auth");
  await fillTestId(pageA, "auth-username", accountA.username);
  await fillTestId(pageA, "auth-password", "definitely-wrong-password");
  await clickTestId(pageA, "auth-submit");
  // The auth-error container always occupies layout; wait for real text so the
  // check cannot pass on an empty placeholder.
  await pageA.waitForFunction(
    () => {
      const element = document.querySelector('[data-testid="auth-error"]');
      return element !== null && (element.textContent ?? "").trim().length > 0;
    },
    { timeout: 25_000, polling: 150 }
  );
  const authErrorText = await pageA.$eval('[data-testid="auth-error"]', (node) => node.textContent ?? "");
  record("wrong password shows an honest auth error", authErrorText.trim().length > 0, truncate(authErrorText.trim(), 120));
  await screenshot(pageA, "02-auth-error");

  // 2. Sign in both accounts through the real UI.
  await signIn(pageA, accountA);
  record("account A signs in through the UI", true);
  await screenshot(pageA, "03-shell-A");
  await gotoAuth(pageB, webBase);
  await signIn(pageB, accountB);
  record("account B signs in through the UI", true);
  await screenshot(pageB, "03-shell-B");

  // 3. A stranger Direct is guarded by the server; the UI falls back to a
  //    message request. Fresh accounts always take this branch in CI.
  await clickTestId(pageA, "new-chat-button");
  await fillTestId(pageA, "new-chat-username", accountB.username);
  await clickTestId(pageA, "new-chat-lookup");
  await waitForSelector(pageA, '[data-testid="new-chat-start"]', 30_000);
  await screenshot(pageA, "04-lookup");
  await clickTestId(pageA, "new-chat-start");
  const requestComposerVisible = await waitForSelector(pageA, '[data-testid="message-request-text"]', 25_000)
    .then(() => true)
    .catch(() => false);
  assert(requestComposerVisible, "stranger Direct was not guarded: message-request composer never appeared");
  await fillTestId(pageA, "message-request-text", "Hi! This is a real message request sent by the E2E gate.");
  await clickTestId(pageA, "message-request-send");
  await waitForSelectorAbsent(pageA, '[data-testid="message-request-send"]', 25_000);
  record("stranger Direct guarded; A sends a message request", true, "request composer shown after server FORBIDDEN");
  await screenshot(pageA, "05-a-request-sent");

  // 4. B accepts the request; the accepted Direct opens for B.
  await pageB.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForSelector(pageB, '[data-testid="app-shell"]', 40_000);
  await clickTestId(pageB, "requests-button");
  await waitForSelector(pageB, '[data-testid="request-accept"]', 30_000);
  await screenshot(pageB, "06-b-requests");
  await clickTestId(pageB, "request-accept");
  await waitForSelector(pageB, '[data-testid="message-input"]', 40_000);
  record("B accepts the message request and the Direct opens", true);
  await screenshot(pageB, "07-b-accepted-chat");

  // 5. B can reopen the chat after a reload (chat-list projection).
  await pageB.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForSelector(pageB, '[data-testid="app-shell"]', 40_000);
  const reopenedB = await openChatRow(pageB, accountA.displayName);
  assert(reopenedB !== null, "B could not find the Direct chat row after reload");
  await waitForSelector(pageB, '[data-testid="message-input"]', 30_000);
  record("B reopens the Direct chat after reload", true, reopenedB);
  await screenshot(pageB, "08-b-reopened-chat");

  // 6. A opens the accepted Direct.
  await pageA.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForSelector(pageA, '[data-testid="app-shell"]', 40_000);
  const openedA = await openChatRow(pageA, accountB.displayName);
  assert(openedA !== null, "A could not find the Direct chat row after acceptance");
  await waitForSelector(pageA, '[data-testid="message-input"]', 30_000);
  record("A opens the accepted Direct chat", true, openedA);
  await screenshot(pageA, "09-a-chat");

  // 7. Realtime delivery A -> B (B's conversation is open, no reload).
  const realtimeText = `E2E realtime hello ${accountA.stamp}`;
  await fillTestId(pageA, "message-input", realtimeText);
  await clickTestId(pageA, "message-send");
  await waitForBodyText(pageA, (body) => body.includes(realtimeText), "A's own message rendered", 25_000);
  await waitForBodyText(pageB, (body) => body.includes(realtimeText), "B received the realtime message", 30_000);
  record("B receives A's message in realtime without reload", true);
  await screenshot(pageA, "10-realtime-A");
  await screenshot(pageB, "10-realtime-B");

  // 8. Reply through the message action menu, delivered back over realtime.
  const rows = await pageB.$$('[data-testid^="message-row-"]');
  assert(rows.length > 0, "B's message list is empty; cannot exercise reply");
  const lastRow = rows[rows.length - 1];
  await lastRow.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const menuOpened = await lastRow.evaluate((node) => {
    const buttons = [...node.querySelectorAll(".bubble__action")];
    if (buttons.length === 0) return false;
    buttons[buttons.length - 1].click();
    return true;
  });
  assert(menuOpened, "message action menu button is missing");
  await pageB.waitForFunction(
    () => [...document.querySelectorAll('[role="menuitem"]')].some((node) => /^(reply|ответить)\b/iu.test((node.textContent ?? "").trim())),
    { timeout: 15_000, polling: 150 }
  );
  const replyClicked = await pageB.evaluate(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const target = items.find((node) => /^(reply|ответить)\b/iu.test((node.textContent ?? "").trim()));
    if (!target) return false;
    target.click();
    return true;
  });
  assert(replyClicked, "reply menu item could not be clicked");
  await waitForSelector(pageB, '[data-testid="reply-preview"]', 15_000);
  const replyText = `E2E reply from B ${accountA.stamp}`;
  await fillTestId(pageB, "message-input", replyText);
  await clickTestId(pageB, "message-send");
  await waitForBodyText(pageA, (body) => body.includes(replyText), "A received B's reply", 30_000);
  record("reply from B reaches A over realtime", true);
  await screenshot(pageA, "11-reply-A");

  // 9. Delivery ticks only from real receipt state (sent is the honest floor).
  const deliveryStates = await pageA.evaluate(() => {
    return [...document.querySelectorAll(".delivery")].map((node) => {
      const match = [...node.classList].find((name) => name.startsWith("delivery--"));
      return match === undefined ? "unknown" : match.replace("delivery--", "");
    });
  });
  const honestTick = deliveryStates.some((state) => ["sent", "delivered", "read"].includes(state));
  const failedTick = deliveryStates.includes("failed");
  record(
    "own message shows an honest delivery tick",
    honestTick && !failedTick,
    `states=${JSON.stringify(deliveryStates).slice(0, 160)}`
  );
  await screenshot(pageA, "12-delivery-ticks");

  // 10. Image upload -> attachment message rendered from the authenticated blob.
  const rowsBeforeUpload = await pageA.$$eval('[data-testid^="message-row-"]', (nodes) => nodes.length);
  const fileChooserPromise = pageA.waitForFileChooser({ timeout: 15_000 });
  await clickTestId(pageA, "attach-button");
  const fileChooser = await fileChooserPromise;
  await fileChooser.accept([join(TOOL_ROOT, "fixtures", "pixel.png")]);
  await pageA.waitForFunction(
    (count) => document.querySelectorAll('[data-testid^="message-row-"]').length > count,
    { timeout: 45_000, polling: 250 },
    rowsBeforeUpload
  );
  await pageA.waitForFunction(
    () => document.querySelector(".attachment--image, .attachment--file, .attachment--image-placeholder") !== null,
    { timeout: 30_000, polling: 250 }
  );
  record("image attachment uploads and renders", true);
  await screenshot(pageA, "13-attachment");

  // 11. Calls stay honestly gated (this server advertises calls=false).
  const capabilities = await apiRequest(apiBase, "GET", "/v1/capabilities");
  const callsAvailable = capabilities.json?.features?.calls === true;
  const aBody = await bodyText(pageA);
  if (callsAvailable) {
    const callControls = await pageA.$$('[data-testid*="call"]');
    record("calls advertised; call controls present", callControls.length > 0, `${callControls.length} call testids`);
  } else {
    const honest = HONEST_CALLS_PATTERN.test(aBody);
    record("calls unavailable and honestly labelled", honest, honest ? "honest call copy present" : "no honest call copy found");
  }
  await screenshot(pageA, "14-calls-honest");

  // Informational mobile layout screenshot (not an assertion step).
  await pageA.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await sleep(500);
  const needsOpenChat = await pageA.evaluate(() => !document.querySelector('[data-testid="message-input"]'));
  if (needsOpenChat) {
    const row = await openChatRow(pageA, accountB.displayName);
    void row;
    await sleep(500);
  }
  await screenshot(pageA, "15-mobile-conversation");
  await pageA.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  // 12. Profile + sign-out returns to the auth screen.
  await clickTestId(pageA, "profile-menu");
  await waitForSelector(pageA, '[data-testid="sign-out-button"]', 20_000);
  record("profile menu opens", true);
  await screenshot(pageA, "16-profile");
  await clickTestId(pageA, "sign-out-button");
  await waitForSelector(pageA, '[data-testid="auth-username"]', 30_000);
  record("sign out returns to the auth screen", true);
  await screenshot(pageA, "17-signed-out");
}

/* --------------------------------------------------------------- main flow */

async function main() {
  runDirectories = createRunDirectories();
  log(`artifacts: ${runDirectories.artifactsDir}`);

  if (apiOnlyCheck) {
    await runApiOnlyCheck();
    record("suite", results.every((entry) => entry.ok), "API-only self-check");
    return;
  }

  const attach = attachMode || (explicitApiBase !== undefined && explicitWebBase !== undefined);
  let apiBase;
  let webBase;
  let mode;

  if (attach) {
    apiBase = normalizeBaseUrl(explicitApiBase, DEFAULT_API_BASE);
    webBase = normalizeBaseUrl(explicitWebBase, DEFAULT_WEB_BASE);
    mode = "attach";
    log(`attach mode: api=${apiBase} web=${webBase}`);
    await waitForApiReady(apiBase);
    await waitForWebReady(webBase);
  } else {
    mode = "orchestrated";
    apiBase = `http://127.0.0.1:${apiPort}`;
    webBase = `http://127.0.0.1:${webPort}`;
    if (apiPort !== 2222) {
      warn("the vite preview proxy in apps/web/vite.config.ts targets port 2222; orchestrated mode expects --api-port 2222");
    }
    const api = startApi({
      apiPort,
      runDir: runDirectories.runDir,
      secrets: generateDevSecrets(),
      logsDir: runDirectories.logsDir,
      webPort
    });
    await Promise.race([waitForApiReady(api.baseUrl), failOnProcessExit(api.spawned, "Luxora API")]);
    assertProcessRunning(api.spawned, "Luxora API");
    const preview = startWebPreview({ webPort, logsDir: runDirectories.logsDir, apiPort });
    await Promise.race([waitForWebReady(webBase), failOnProcessExit(preview.spawned, "vite preview")]);
    assertProcessRunning(preview.spawned, "vite preview");
  }

  const capabilities = await apiRequest(apiBase, "GET", "/v1/capabilities");
  assert(capabilities.status === 200, `capabilities answered HTTP ${capabilities.status}`);
  assert(capabilities.json?.features?.passwordAuthentication === true, "password authentication is disabled on this API");
  assert(capabilities.json?.features?.messaging === true, "messaging is disabled on this API");

  const stamp = randomToken(4);
  const accountA = {
    stamp,
    username: makeUsername("e2e", `${stamp}a`),
    displayName: "E2E Alice",
    password: randomPassword()
  };
  const accountB = {
    stamp,
    username: makeUsername("e2e", `${stamp}b`),
    displayName: "E2E Bob",
    password: randomPassword()
  };
  await registerAccount(apiBase, accountA);
  await registerAccount(apiBase, accountB);
  record("E2E accounts registered against a live API", true, "fresh A/B accounts (credentials never logged)");

  await runBrowserSuite({ apiBase, webBase, accountA, accountB });

  // Page/console hygiene: deliberate 401/403 probes and favicon noise are
  // expected; anything else is a real client error.
  const nonNoise = consoleErrors.filter((entry) => {
    return !/favicon/iu.test(entry)
      && !/404 \(Not Found\)/iu.test(entry)
      && !/401 \(Unauthorized\)/iu.test(entry)
      && !/403 \(Forbidden\)/iu.test(entry)
      && !/net::ERR_ABORTED/iu.test(entry);
  });
  record("no unexpected page/console errors", nonNoise.length === 0, nonNoise.slice(0, MAX_CONSOLE_ERRORS_REPORTED).join(" | "));
}

async function writeReport(extra = {}) {
  if (runDirectories === null) return;
  const passed = results.filter((entry) => entry.ok).length;
  const failed = results.filter((entry) => !entry.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - runStartedAt,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    mode: extra.mode ?? (attachMode ? "attach" : "orchestrated"),
    chromePath: process.env["CHROME_PATH"] ?? null,
    passed,
    failed: failed.length,
    total: results.length,
    results,
    consoleErrors,
    screenshots,
    ...(extra.fatalError === undefined ? {} : { fatalError: extra.fatalError })
  };
  try {
    await writeFile(join(runDirectories.artifactsDir, "e2e-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log(`report: ${join(runDirectories.artifactsDir, "e2e-report.json")}`);
  } catch (error) {
    warn(`could not write e2e-report.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  return report;
}

function printMatrix(report) {
  console.log("\n=== Luxora web messenger E2E ===");
  for (const entry of report?.results ?? results) {
    console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.step}${entry.detail === "" ? "" : ` — ${entry.detail}`}`);
  }
  const failed = (report?.results ?? results).filter((entry) => !entry.ok);
  if (failed.length === 0) {
    console.log(`\n${(report?.results ?? results).length}/${(report?.results ?? results).length} checks passed`);
    return;
  }
  console.log(`\n${(report?.passed ?? 0)}/${(report?.total ?? results.length)} checks passed; ${failed.length} failed`);
  for (const entry of failed) console.log(`FAILED: ${entry.step} — ${entry.detail}`);
}

let fatalError;
try {
  await main();
} catch (error) {
  fatalError = error instanceof Error ? `${error.message}` : String(error);
  record("suite aborted", false, truncate(fatalError, 500));
  console.error(`\nE2E suite aborted: ${fatalError}`);
  if (pageA !== null) await screenshot(pageA, "failure-A");
  if (pageB !== null) await screenshot(pageB, "failure-B");
  process.exitCode = 1;
} finally {
  if (results.length === 0) record("suite", false, "no checks executed");
  const report = await writeReport(fatalError === undefined ? {} : { fatalError });
  printMatrix(report ?? null);
  if ((report?.failed ?? 1) > 0) process.exitCode = 1;
  await cleanup();
  log(`done in ${((Date.now() - runStartedAt) / 1_000).toFixed(1)}s`);
}
