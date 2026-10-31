import { contextBridge, ipcRenderer } from "electron";

// Passed by the main process through webPreferences.additionalArguments so the
// sandboxed preload can hand a validated loopback API origin to the web client.
// Re-validate here: the preload is the boundary the web app trusts.
const defaultApiBaseUrl = "http://127.0.0.1:2222";
const apiBaseUrlArgumentPrefix = "--luxora-api-base-url=";
const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);

function readApiBaseUrl(): string {
  const argv: readonly string[] = Array.isArray(process.argv) ? process.argv : [];
  const argument = argv.find((value) => value.startsWith(apiBaseUrlArgumentPrefix));
  if (argument === undefined) return defaultApiBaseUrl;
  try {
    const url = new URL(argument.slice(apiBaseUrlArgumentPrefix.length));
    const loopback = loopbackHostnames.has(url.hostname);
    if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:")) return defaultApiBaseUrl;
    if (url.username !== "" || url.password !== "") return defaultApiBaseUrl;
    return url.origin;
  } catch {
    return defaultApiBaseUrl;
  }
}

const product = Object.freeze({
  name: "Luxora",
  release: "Beta-0.1",
  owner: "Flenym",
  platform: process.platform,
  apiBaseUrl: readApiBaseUrl(),
  onMenuAction: (callback: (action: "new-message" | "search") => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      if (value === "new-message" || value === "search") callback(value);
    };
    ipcRenderer.on("luxora:menu-action", listener);
    return () => ipcRenderer.removeListener("luxora:menu-action", listener);
  },
});

contextBridge.exposeInMainWorld("luxoraDesktop", product);
