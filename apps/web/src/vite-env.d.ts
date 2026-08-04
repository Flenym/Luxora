/// <reference types="vite/client" />

interface LuxoraDesktopBridge {
  release: string;
  owner: string;
  platform: string;
  onMenuAction(callback: (action: "search" | "new-message" | string) => void): (() => void) | void;
}

interface Window {
  luxoraDesktop?: LuxoraDesktopBridge;
}
