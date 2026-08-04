function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export type RealtimeGuardReason =
  | "auth_rate"
  | "backpressure"
  | "frame_rate"
  | "pending_connections"
  | "session_connections"
  | "typing_rate";

export class Metrics {
  readonly #startedAt = Date.now();
  readonly #requests = new Map<string, number>();
  readonly #errors = new Map<string, number>();
  readonly #realtimeGuards = new Map<RealtimeGuardReason, number>();
  #websocketConnections = 0;

  recordRequest(method: string, route: string, statusCode: number): void {
    const key = JSON.stringify([method, route, String(statusCode)]);
    this.#requests.set(key, (this.#requests.get(key) ?? 0) + 1);
  }

  recordError(code: string): void {
    this.#errors.set(code, (this.#errors.get(code) ?? 0) + 1);
  }

  websocketOpened(): void {
    this.#websocketConnections += 1;
  }

  websocketClosed(): void {
    this.#websocketConnections = Math.max(0, this.#websocketConnections - 1);
  }

  recordRealtimeGuard(reason: RealtimeGuardReason): void {
    this.#realtimeGuards.set(reason, (this.#realtimeGuards.get(reason) ?? 0) + 1);
  }

  render(): string {
    const lines = [
      "# HELP luxora_uptime_seconds Process uptime in seconds.",
      "# TYPE luxora_uptime_seconds gauge",
      `luxora_uptime_seconds ${Math.floor((Date.now() - this.#startedAt) / 1000)}`,
      "# HELP luxora_websocket_connections Active authenticated realtime connections.",
      "# TYPE luxora_websocket_connections gauge",
      `luxora_websocket_connections ${this.#websocketConnections}`,
      "# HELP luxora_http_requests_total HTTP requests by route and status.",
      "# TYPE luxora_http_requests_total counter"
    ];
    for (const [key, value] of this.#requests) {
      const [method, route, status] = JSON.parse(key) as [string, string, string];
      lines.push(`luxora_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${escapeLabel(status)}"} ${value}`);
    }
    lines.push(
      "# HELP luxora_errors_total Application errors by public code.",
      "# TYPE luxora_errors_total counter"
    );
    for (const [code, value] of this.#errors) {
      lines.push(`luxora_errors_total{code="${escapeLabel(code)}"} ${value}`);
    }
    lines.push(
      "# HELP luxora_realtime_guard_total Realtime frames or connections rejected by a local safety bound.",
      "# TYPE luxora_realtime_guard_total counter"
    );
    for (const [reason, value] of this.#realtimeGuards) {
      lines.push(`luxora_realtime_guard_total{reason="${escapeLabel(reason)}"} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
