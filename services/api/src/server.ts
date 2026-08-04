import { buildApp } from "./app.js";

const app = await buildApp();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "Graceful shutdown started");
  try {
    await app.close();
    process.exitCode = 0;
  } catch (error) {
    app.log.error({ err: error }, "Graceful shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

try {
  await app.listen({
    host: app.luxora.config.host,
    port: app.luxora.config.port
  });
} catch (error) {
  app.log.fatal({ err: error }, "Failed to start Luxora API");
  await app.close();
  process.exitCode = 1;
}
