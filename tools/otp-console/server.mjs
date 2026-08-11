import { createServer } from "node:http";

const bindHost = "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "8081", 10);
const publicPort = Number.parseInt(
  process.env.LUXORA_OTP_CONSOLE_PUBLIC_PORT ?? String(port),
  10
);
const code = process.env.PHONE_AUTH_DEVELOPMENT_CODE ?? "";
const provider = process.env.PHONE_AUTH_PROVIDER ?? "disabled";
const explicitlyEnabled = process.env.LUXORA_LOCAL_OTP_CONSOLE === "enabled";

if (
  process.env.NODE_ENV !== "development"
  || provider !== "development"
  || !explicitlyEnabled
  || !Number.isSafeInteger(port)
  || port < 1
  || port > 65_535
  || !Number.isSafeInteger(publicPort)
  || publicPort < 1
  || publicPort > 65_535
  || !/^\d{6}$/u.test(code)
) {
  console.error(
    "Luxora OTP console refused to start: require explicit local development mode, "
    + "the development phone provider, a valid port and one six-digit development code."
  );
  process.exit(1);
}

const securityHeaders = {
  "cache-control": "no-store, max-age=0",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};
const allowedPorts = new Set([port, publicPort]);
const allowedHosts = new Set(
  [...allowedPorts].flatMap((allowedPort) => [
    `127.0.0.1:${allowedPort}`,
    `localhost:${allowedPort}`,
    `[::1]:${allowedPort}`
  ])
);

function send(response, status, contentType, body, headOnly = false) {
  response.writeHead(status, {
    ...securityHeaders,
    "content-type": contentType,
    "content-length": Buffer.byteLength(body)
  });
  response.end(headOnly ? undefined : body);
}

const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Luxora — локальный код входа</title>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050508;color:#f7f5ff;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(92vw,520px);padding:36px;border:1px solid #302a43;border-radius:28px;background:linear-gradient(145deg,#171322,#0b0a10);box-shadow:0 28px 90px #0009;text-align:center}.eyebrow{color:#a79abf;font-size:13px;letter-spacing:.13em;text-transform:uppercase}.code{margin:22px 0;font:700 clamp(42px,12vw,72px)/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;color:#fff;text-shadow:0 0 28px #8b5cf6}.note{margin:0;color:#bcb5c9;line-height:1.5}.warning{margin-top:24px;padding:13px;border-radius:14px;background:#2c1720;color:#ffbbc9;font-size:14px}</style>
</head>
<body><main class="card">
  <div class="eyebrow">Luxora Beta-0.1 · development</div>
  <h1>Код входа</h1>
  <div class="code" aria-label="Код входа ${code.split("").join(" ")}">${code}</div>
  <p class="note">Введите этот код в приложении на iPhone Simulator. Для каждого локального challenge используется один настроенный development-код.</p>
  <p class="warning">Только локальная разработка. Не отправляйте код другим людям и не переносите эту консоль в production.</p>
</main></body></html>`;

const server = createServer((request, response) => {
  const method = request.method ?? "GET";
  const headOnly = method === "HEAD";
  const host = request.headers.host?.toLowerCase() ?? "";
  if (!allowedHosts.has(host)) {
    send(response, 421, "application/json; charset=utf-8", JSON.stringify({ error: "local_host_required" }));
    return;
  }
  if (method !== "GET" && !headOnly) {
    send(response, 405, "application/json; charset=utf-8", JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/health") {
    send(response, 200, "application/json; charset=utf-8", JSON.stringify({ status: "ok" }), headOnly);
    return;
  }
  if (path === "/api/code") {
    send(response, 200, "application/json; charset=utf-8", JSON.stringify({ code }), headOnly);
    return;
  }
  if (path === "/") {
    send(response, 200, "text/html; charset=utf-8", html, headOnly);
    return;
  }
  send(response, 404, "application/json; charset=utf-8", JSON.stringify({ error: "not_found" }), headOnly);
});

server.listen(port, bindHost, () => {
  console.log(`Luxora local OTP console is ready on port ${port}; the code is never written to container logs.`);
});

function shutdown() {
  server.close((error) => {
    if (error) {
      console.error("Luxora OTP console shutdown failed.");
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
