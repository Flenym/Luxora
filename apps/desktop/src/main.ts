import { app, BrowserWindow, Menu, session, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const allowedExternalHosts = new Set(["luxora.app", "docs.luxora.app", "support.luxora.app"]);
const developmentURL = process.env.LUXORA_WEB_URL;

app.enableSandbox();
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

function isTrustedRendererURL(value: string): boolean {
  return value.startsWith("file:") || (developmentURL !== undefined && value.startsWith(developmentURL));
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
      preload: join(currentDirectory, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });

  window.once("ready-to-show", () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalIfAllowed(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererURL(url)) {
      event.preventDefault();
      void openExternalIfAllowed(url);
    }
  });

  if (developmentURL && isTrustedDevelopmentURL(developmentURL)) {
    void window.loadURL(developmentURL);
  } else {
    const webRoot = app.isPackaged
      ? join(process.resourcesPath, "web", "index.html")
      : join(currentDirectory, "../../../web/dist/index.html");
    void window.loadFile(webRoot);
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
        "Content-Security-Policy": [
          "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https: wss:; media-src 'self' blob:; font-src 'self'",
        ],
      },
    });
  });

  installApplicationMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
