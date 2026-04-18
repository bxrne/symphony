import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { rootLogger } from "../logger.js";
import { renderDashboard } from "./dashboard.js";

export type HttpServerOptions = {
  port: number;
  host?: string;
  orchestrator: Orchestrator;
};

export class SymphonyHttpServer {
  private server: Server | null = null;
  private log = rootLogger.child({ component: "http_server" });

  constructor(private readonly opts: HttpServerOptions) {}

  async start(): Promise<{ port: number; host: string }> {
    const host = this.opts.host ?? "127.0.0.1";
    return await new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.on("error", reject);
      server.listen(this.opts.port, host, () => {
        const addr = server.address();
        const resolvedPort =
          typeof addr === "object" && addr && "port" in addr ? (addr as { port: number }).port : this.opts.port;
        this.server = server;
        this.log.info("http_listening", { host, port: resolvedPort });
        resolve({ host, port: resolvedPort });
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const method = (req.method ?? "GET").toUpperCase();

    try {
      if (url.pathname === "/" && method === "GET") {
        const html = renderDashboard(this.snapshot());
        send(res, 200, html, "text/html; charset=utf-8");
        return;
      }

      if (url.pathname === "/api/v1/state" && method === "GET") {
        sendJson(res, 200, this.stateResponse());
        return;
      }

      if (url.pathname === "/api/v1/refresh" && method === "POST") {
        const requestedAt = new Date().toISOString();
        const { queued, coalesced } = this.opts.orchestrator.requestRefresh();
        sendJson(res, 202, {
          queued,
          coalesced,
          requested_at: requestedAt,
          operations: ["poll", "reconcile"],
        });
        return;
      }

      if (
        (url.pathname === "/api/v1/state" || url.pathname === "/api/v1/refresh") &&
        method !== "OPTIONS"
      ) {
        sendJson(res, 405, { error: { code: "method_not_allowed", message: `method ${method} not allowed` } });
        return;
      }

      const issueMatch = /^\/api\/v1\/([^/]+)$/.exec(url.pathname);
      if (issueMatch && method === "GET") {
        const identifier = decodeURIComponent(issueMatch[1]!);
        const detail = this.issueResponse(identifier);
        if (!detail) {
          sendJson(res, 404, { error: { code: "issue_not_found", message: `no runtime state for ${identifier}` } });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }

      sendJson(res, 404, { error: { code: "not_found", message: `no route for ${url.pathname}` } });
    } catch (error) {
      this.log.error("http_handler_error", { error: describe(error) });
      sendJson(res, 500, { error: { code: "internal_error", message: describe(error) } });
    }
  }

  private snapshot() {
    return this.opts.orchestrator.getSnapshotForApi();
  }

  private stateResponse() {
    const { state, running, retrying } = this.snapshot();
    return {
      generated_at: new Date().toISOString(),
      counts: { running: running.length, retrying: retrying.length },
      running: running.map((r) => ({
        issue_id: r.issue.id,
        issue_identifier: r.identifier,
        state: r.issue.state,
        session_id: r.session_id,
        turn_count: r.turn_count,
        last_event: r.last_codex_event,
        last_message: r.last_codex_message,
        started_at: r.started_at,
        last_event_at: r.last_codex_timestamp,
        host: r.host,
        tokens: {
          input_tokens: r.codex_input_tokens,
          output_tokens: r.codex_output_tokens,
          total_tokens: r.codex_total_tokens,
        },
      })),
      retrying: retrying.map((r) => ({
        issue_id: r.issue_id,
        issue_identifier: r.identifier,
        attempt: r.attempt,
        due_at: new Date(r.due_at_ms).toISOString(),
        error: r.error,
      })),
      codex_totals: {
        input_tokens: state.codex_totals.input_tokens,
        output_tokens: state.codex_totals.output_tokens,
        total_tokens: state.codex_totals.total_tokens,
        seconds_running:
          state.codex_totals.seconds_running +
          running.reduce((sum, r) => sum + Math.max(0, (Date.now() - r.started_at_ms) / 1000), 0),
      },
      rate_limits: state.codex_rate_limits,
    };
  }

  private issueResponse(identifier: string) {
    const { state, running, retrying } = this.snapshot();
    const running_entry = running.find((r) => r.identifier === identifier);
    const retry_entry = retrying.find((r) => r.identifier === identifier);
    if (!running_entry && !retry_entry) return null;
    const issueId = running_entry?.issue.id ?? retry_entry?.issue_id ?? null;
    return {
      issue_identifier: identifier,
      issue_id: issueId,
      status: running_entry ? "running" : "retrying",
      workspace: running_entry
        ? { path: running_entry.workspace_path }
        : null,
      attempts: {
        restart_count: state.restart_counts.get(issueId ?? "") ?? 0,
        current_retry_attempt: retry_entry?.attempt ?? null,
      },
      running: running_entry
        ? {
            session_id: running_entry.session_id,
            turn_count: running_entry.turn_count,
            state: running_entry.issue.state,
            started_at: running_entry.started_at,
            last_event: running_entry.last_codex_event,
            last_message: running_entry.last_codex_message,
            last_event_at: running_entry.last_codex_timestamp,
            host: running_entry.host,
            tokens: {
              input_tokens: running_entry.codex_input_tokens,
              output_tokens: running_entry.codex_output_tokens,
              total_tokens: running_entry.codex_total_tokens,
            },
          }
        : null,
      retry: retry_entry
        ? {
            attempt: retry_entry.attempt,
            due_at: new Date(retry_entry.due_at_ms).toISOString(),
            error: retry_entry.error,
          }
        : null,
      logs: { codex_session_logs: [] },
      recent_events: running_entry?.recent_events ?? [],
      last_error: running_entry?.last_error ?? retry_entry?.error ?? null,
      tracked: {},
    };
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body, null, 2), "application/json; charset=utf-8");
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
