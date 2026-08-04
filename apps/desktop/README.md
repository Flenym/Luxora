# Luxora Desktop

Secure Electron shell for the local Luxora web build on Windows, Linux, and macOS.

- Product release: **Beta-0.1**
- Developer and owner: **Flenym**
- Renderer sandboxing and context isolation are mandatory.
- Node integration is disabled; preload exposes immutable product metadata only.
- External navigation is denied unless a host is explicitly allowlisted.

Run `npm run start` after building `../web`. Distribution commands are available for Linux and Windows in `package.json`.
