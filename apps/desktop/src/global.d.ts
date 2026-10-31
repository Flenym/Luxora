export {};

declare global {
  interface Window {
    luxoraDesktop?: Readonly<{
      name: "Luxora";
      release: "Beta-0.1";
      owner: "Flenym";
      platform: NodeJS.Platform;
      /** Validated loopback API origin (for example http://127.0.0.1:2222). */
      apiBaseUrl: string;
      onMenuAction: (callback: (action: "new-message" | "search") => void) => () => void;
    }>;
  }
}
