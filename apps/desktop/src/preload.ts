import { contextBridge, ipcRenderer } from "electron";

const product = Object.freeze({
  name: "Luxora",
  release: "Beta-0.1",
  owner: "Flenym",
  platform: process.platform,
  onMenuAction: (callback: (action: "new-message" | "search") => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      if (value === "new-message" || value === "search") callback(value);
    };
    ipcRenderer.on("luxora:menu-action", listener);
    return () => ipcRenderer.removeListener("luxora:menu-action", listener);
  },
});

contextBridge.exposeInMainWorld("luxoraDesktop", product);
