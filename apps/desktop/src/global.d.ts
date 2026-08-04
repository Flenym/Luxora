export {};

declare global {
  interface Window {
    luxoraDesktop?: Readonly<{
      name: "Luxora";
      release: "Beta-0.1";
      owner: "Flenym";
      platform: NodeJS.Platform;
      onMenuAction: (callback: (action: "new-message" | "search") => void) => () => void;
    }>;
  }
}
