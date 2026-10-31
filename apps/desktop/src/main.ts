import { app, BrowserWindow, Menu, protocol, session, shell } from "electron";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const allowedExternalHosts = new Set(["luxora.app", "docs.luxora.app", "support.luxora.app"]);
const developmentURL = process.env.LUXORA_WEB_URL;
const smokeMode = process.env.LUXORA_DESKTOP_SMOKE === "1";
const smokeTimeoutMilliseconds = 30_000;

// The renderer is served from a secure standard custom scheme instead of
// `file:` so it has a stable origin (`luxora://app`). That makes a strict CSP
// and a well-defined API CORS origin possible in dev and packaged builds.
const appScheme = "luxora";
const appHost = "app";
const appRenderURL = `${appScheme}://${appHost}/`;
const bridgeApiBaseUrlArgumentPrefix = "--luxora-api-base-url=";

// Default local API used by scripts/start-server.ps1. Only loopback origins
// are accepted, so a compromised environment cannot turn the shell into a
// proxy for a remote API.
const defaultApiBaseUrl = "http://127.0.0.1:2222";
const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);

function normalizeLoopbackOrigin(value: string | undefined): string {
  if (value === undefined) return defaultApiBaseUrl;
  try {
    const url = new URL(value.trim());
    const loopback = loopbackHostnames.has(url.hostname);
    if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:")) return defaultApiBaseUrl;
    if (url.username !== "" || url.password !== "") return defaultApiBaseUrl;
    return url.origin;
  } catch {
    return defaultApiBaseUrl;
  }
}

const apiBaseUrl = normalizeLoopbackOrigin(process.env.LUXORA_API_URL);

function buildContentSecurityPolicy(origin: string): string {
  // Keep the previous directives intact and only add the validated local API
  // origin plus its websocket counterpart; everything else stays deny-by-default.
  const connectSources = ["'self'", "https:", "wss:", origin];
  try {
    const api = new URL(origin);
    connectSources.push(`${api.protocol === "https:" ? "wss:" : "ws:"}//${api.host}`);
  } catch {
    // `origin` is validated before use; https:/wss: above remain the fallback.
  }
  return [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    `connect-src ${connectSources.join(" ")}`,
    "media-src 'self' blob:",
    "font-src 'self'",
  ].join("; ");
}

const contentSecurityPolicy = buildContentSecurityPolicy(apiBaseUrl);

app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: appScheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);
app.setName("Luxora");
app.setAboutPanelOptions({
  applicationName: "Luxora",
  applicationVersion: "Beta-0.1",
  version: "Beta-0.1",
  copyright: "Copyright © 2026 Flenym",
});

function isTrustedDevelopmentURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isAppRendererURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === `${appScheme}:` && url.hostname === appHost;
  } catch {
    return false;
  }
}

function isTrustedRendererURL(value: string): boolean {
  // `file:` remains trusted for the legacy LUXORA_WEB_URL fallback, but the
  // default renderer origin is the secure custom scheme above.
  return isAppRendererURL(value) || value.startsWith("file:") || (developmentURL !== undefined && value.startsWith(developmentURL));
}

async function openExternalIfAllowed(value: string): Promise<void> {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && allowedExternalHosts.has(url.hostname)) {
      await shell.openExternal(url.toString());
    }
  } catch {
    // Invalid or untrusted links are intentionally ignored.
  }
}

const contentTypes = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
]);

function contentTypeFor(filePath: string): string {
  return contentTypes.get(extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function resolveWebRootDirectory(): string {
  // Packaged: electron-builder `extraResources` copies ../web/dist to resources/web.
  return app.isPackaged ? join(process.resourcesPath, "web") : resolve(currentDirectory, "../../../web/dist");
}

function isInsideWebRoot(webRoot: string, candidate: string): boolean {
  const path = relative(webRoot, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function assetHeaders(filePath: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    // Custom-scheme responses are not covered by webRequest.onHeadersReceived,
    // so the same strict policy is attached here for the packaged renderer.
    "Content-Security-Policy": contentSecurityPolicy,
    "X-Content-Type-Options": "nosniff",
  };
  if (filePath !== null) headers["Content-Type"] = contentTypeFor(filePath);
  return headers;
}

async function readAssetFile(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch {
    return undefined;
  }
}

async function handleAppProtocolRequest(webRoot: string, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.protocol !== `${appScheme}:` || url.hostname !== appHost) {
      return new Response("Not Found", { status: 404, headers: assetHeaders(null) });
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad Request", { status: 400, headers: assetHeaders(null) });
    }
    const relativePath = pathname.replace(/^\/+/u, "");
    const requestedRelativePath = relativePath === "" || relativePath.endsWith("/") ? `${relativePath}index.html` : relativePath;
    const requestedPath = resolve(webRoot, requestedRelativePath);
    if (!isInsideWebRoot(webRoot, requestedPath)) {
      return new Response("Forbidden", { status: 403, headers: assetHeaders(null) });
    }
    let assetPath = requestedPath;
    let body = await readAssetFile(assetPath);
    if (body === undefined && extname(requestedRelativePath) === "") {
      // Client-side routes (/app, /docs/...) fall back to the single-page shell.
      assetPath = join(webRoot, "index.html");
      body = await readAssetFile(assetPath);
    }
    if (body === undefined) {
      return new Response("Not Found", { status: 404, headers: assetHeaders(null) });
    }
    return new Response(request.method === "HEAD" ? null : new Uint8Array(body), {
      status: 200,
      headers: assetHeaders(assetPath),
    });
  } catch {
    return new Response("Internal Server Error", { status: 500, headers: assetHeaders(null) });
  }
}

function registerAppProtocol(): void {
  const webRoot = resolveWebRootDirectory();
  protocol.handle(appScheme, (request) => handleAppProtocolRequest(webRoot, request));
}

function finishSmoke(url: string): void {
  process.stdout.write(`LUXORA_DESKTOP_SMOKE_OK ${url}\n`, () => app.exit(0));
  // Never hang CI if the stdout pipe is gone.
  setTimeout(() => app.exit(0), 2_000);
}

function failSmoke(message: string): void {
  process.stderr.write(`LUXORA_DESKTOP_SMOKE_FAIL ${message}\n`, () => app.exit(1));
  setTimeout(() => app.exit(1), 2_000);
}

type SmokeRendererState = Readonly<{ bridgeApiBaseUrl: string | null; rootChildren: number }>;

// The gate must prove the renderer really executed the web bundle: the bridge
// config reached the page and React mounted into #root. A blank or CSP-blocked
// page would still fire did-finish-load, so it is not enough on its own.
const smokeReadinessScript = `(() => {
  const bridge = window.luxoraDesktop;
  const root = document.getElementById("root");
  return {
    bridgeApiBaseUrl: bridge !== undefined && typeof bridge.apiBaseUrl === "string" ? bridge.apiBaseUrl : null,
    rootChildren: root === null ? -1 : root.childElementCount
  };
})()`;

async function waitForSmokeRenderer(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const state = (await window.webContents.executeJavaScript(smokeReadinessScript, true)) as SmokeRendererState;
    if (state.bridgeApiBaseUrl !== apiBaseUrl) {
      throw new Error(`bridge apiBaseUrl ${String(state.bridgeApiBaseUrl)} did not match ${apiBaseUrl}`);
    }
    if (state.rootChildren > 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`web messenger did not mount into #root (rootChildren=${state.rootChildren})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function watchSmokeMode(window: BrowserWindow): void {
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settle = (action: () => void): void => {
    if (settled) return;
    settled = true;
    if (timeout !== undefined) clearTimeout(timeout);
    action();
  };
  timeout = setTimeout(() => {
    settle(() => failSmoke(`timeout after ${smokeTimeoutMilliseconds}ms waiting for the renderer`));
  }, smokeTimeoutMilliseconds);
  window.webContents.once("did-finish-load", () => {
    void (async () => {
      try {
        await waitForSmokeRenderer(window);
        settle(() => finishSmoke(window.webContents.getURL()));
      } catch (error) {
        settle(() => failSmoke(error instanceof Error ? error.message : String(error)));
      }
    })();
  });
  window.webContents.once("did-fail-load", (_event, code, description, validatedURL) => {
    // Chromium still fires did-finish-load for its error page; settle first so
    // the smoke gate reports the real navigation failure exactly once.
    settle(() => failSmoke(`did-fail-load ${code} ${description} ${validatedURL}`));
  });
  window.webContents.once("render-process-gone", (_event, details) => {
    settle(() => failSmoke(`render-process-gone ${details.reason}`));
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "Luxora — Beta-0.1",
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: "#090914",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      // Sandboxed preload scripts cannot be ES modules, so the preload is
      // compiled from preload.cts to CommonJS (preload.cjs) on purpose.
      preload: join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
      // The sandboxed preload re-validates this loopback origin before it
      // exposes it to the web client; it is only a hint, never a trust boundary.
      additionalArguments: [`${bridgeApiBaseUrlArgumentPrefix}${apiBaseUrl}`],
    },
  });

  if (smokeMode) {
    process.stdout.write(`LUXORA_DESKTOP_SMOKE_START ${appRenderURL} apiBaseUrl=${apiBaseUrl}\n`);
    process.stdout.write(`LUXORA_DESKTOP_SMOKE_CSP ${contentSecurityPolicy}\n`);
    watchSmokeMode(window);
  } else {
    window.once("ready-to-show", () => window.show());
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalIfAllowed(url);
    return { action: "deny" };
  });

  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`Preload script failed to load: ${preloadPath}`, error);
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererURL(url)) {
      event.preventDefault();
      void openExternalIfAllowed(url);
    }
  });

  if (developmentURL !== undefined && isTrustedDevelopmentURL(developmentURL)) {
    void window.loadURL(developmentURL);
  } else {
    if (developmentURL !== undefined && !isTrustedDevelopmentURL(developmentURL)) {
      console.warn("LUXORA_WEB_URL is not a trusted loopback http URL; using the packaged renderer instead.");
    }
    void window.loadURL(appRenderURL);
  }

  return window;
}

function installApplicationMenu(): void {
  const sendMenuAction = (window: Electron.BaseWindow | undefined, action: string): void => {
    if (window instanceof BrowserWindow) window.webContents.send("luxora:menu-action", action);
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [{ label: "Luxora", submenu: [{ role: "about" as const }, { type: "separator" as const }, { role: "quit" as const }] }]
      : []),
    {
      label: "Conversation",
      submenu: [
        { label: "New message", accelerator: "CmdOrCtrl+N", click: (_item, window) => sendMenuAction(window, "new-message") },
        { label: "Search", accelerator: "CmdOrCtrl+F", click: (_item, window) => sendMenuAction(window, "search") },
      ],
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "close" }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const trusted = isTrustedRendererURL(webContents.getURL());
    callback(trusted && ["media", "notifications"].includes(permission));
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicy],
      },
    });
  });

  registerAppProtocol();
  installApplicationMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
