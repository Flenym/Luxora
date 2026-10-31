/// <reference types="vite/client" />

interface LuxoraDesktopBridge {
  release: string;
  owner: string;
  platform: string;
  /** Loopback API origin injected by the Electron shell, e.g. http://127.0.0.1:2222. */
  apiBaseUrl?: string;
  onMenuAction(callback: (action: "search" | "new-message" | string) => void): (() => void) | void;
}

interface Window {
  luxoraDesktop?: LuxoraDesktopBridge;
}
