import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import type { CodexEvent, Issue, ServiceConfig } from "../types.js";
import { rootLogger, type Logger } from "../logger.js";
import {
  extractRateLimits,
  extractUsageTotals,
  summarizeMessage,
} from "./events.js";
import { LINEAR_GRAPHQL_TOOL_SPEC, type ToolHandler } from "./tools.js";
import type { JsonRpcResponse, ProtocolMessage } from "./protocol.js";

export type CodexError = {
  code: string;
  message: string;
};

export type TurnResult =
  | { ok: true; usage: Record<string, unknown> | null }
  | { ok: false; error: CodexError };

export type CodexClientOptions = {
  config: ServiceConfig;
  workspacePath: string;
  issue: Issue;
  remoteHost?: string | null;
  linearGraphqlTool?: ToolHandler | null;
  onEvent: (event: CodexEvent) => void;
  onLog?: (line: string) => void;
  logger?: Logger;
};

type PendingRequest = {
  resolve: (value: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
};

const MAX_LINE_BYTES = 10 * 1024 * 1024;

export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutReader: ReadlineInterface | null = null;
  private stderrReader: ReadlineInterface | null = null;
  private pending = new Map<number | string, PendingRequest>();
  private nextId = 1;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private turnResolver: ((result: TurnResult) => void) | null = null;
  private turnTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private log: Logger;

  constructor(private readonly opts: CodexClientOptions) {
    super();
    this.log = opts.logger ?? rootLogger.child({
      component: "codex_client",
      issue_identifier: opts.issue.identifier,
    });
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get currentThreadId(): string | null {
    return this.threadId;
  }

  async launch(): Promise<void> {
    if (this.child) throw new Error("codex client already launched");
    const { config, workspacePath, remoteHost } = this.opts;

    const [cmd, args] = buildLaunchCommand(config.codex.command, workspacePath, remoteHost ?? null);
    this.log.info("codex_launch", { cmd, remote_host: remoteHost ?? null });

    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    this.stdoutReader = createInterface({
      input: child.stdout as Readable,
      crlfDelay: Infinity,
    });
    this.stderrReader = createInterface({
      input: child.stderr as Readable,
      crlfDelay: Infinity,
    });

    this.stdoutReader.on("line", (line) => {
      if (line.length > MAX_LINE_BYTES) {
        this.emitEvent({ type: "malformed", timestamp: isoNow(), raw: line.slice(0, 200) });
        return;
      }
      if (line.trim().length === 0) return;
      this.handleLine(line);
    });

    this.stderrReader.on("line", (line) => {
      this.opts.onLog?.(line);
      this.log.debug("codex_stderr", { line: line.slice(0, 500) });
    });

    child.on("error", (error) => {
      this.log.error("codex_spawn_error", { error: error.message });
      this.failAllPending(error);
      this.emitEvent({
        type: "startup_failed",
        timestamp: isoNow(),
        reason: error.message,
      });
      if (this.turnResolver) {
        const resolver = this.turnResolver;
        this.turnResolver = null;
        resolver({ ok: false, error: { code: "codex_not_found", message: error.message } });
      }
    });

    child.on("exit", (code, signal) => {
      const reason = `codex exited (code=${code ?? "null"} signal=${signal ?? "null"})`;
      this.log.info("codex_exit", { code, signal });
      this.closed = true;
      this.failAllPending(new Error(reason));
      if (this.turnResolver) {
        const resolver = this.turnResolver;
        this.turnResolver = null;
        resolver({ ok: false, error: { code: "port_exit", message: reason } });
      }
      this.emit("exit", { code, signal });
    });
  }

  async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      clientInfo: { name: "symphony", version: "0.1" },
      capabilities: {},
    });
    this.sendNotification("initialized", {});
  }

  async startThread(): Promise<string> {
    const cfg = this.opts.config;
    const tools: Array<Record<string, unknown>> = [];
    if (this.opts.linearGraphqlTool) tools.push(LINEAR_GRAPHQL_TOOL_SPEC);
    const response = await this.sendRequest("thread/start", {
      approvalPolicy: cfg.codex.approval_policy,
      sandbox: cfg.codex.thread_sandbox,
      cwd: this.opts.workspacePath,
      tools,
    });
    const result = (response.result ?? {}) as { thread?: { id?: string } };
    const threadId = result.thread?.id;
    if (!threadId) throw new Error("thread/start did not return thread.id");
    this.threadId = threadId;
    return threadId;
  }

  async runTurn(prompt: string, title: string): Promise<TurnResult> {
    const cfg = this.opts.config;
    if (!this.threadId) throw new Error("cannot run turn before thread/start");
    this.turnResolver = null;
    this.turnId = null;

    return await new Promise<TurnResult>((resolve) => {
      this.turnResolver = resolve;
      const timeoutMs = cfg.codex.turn_timeout_ms;
      this.turnTimer = setTimeout(() => {
        if (this.turnResolver) {
          const resolver = this.turnResolver;
          this.turnResolver = null;
          resolver({ ok: false, error: { code: "turn_timeout", message: `turn timed out after ${timeoutMs}ms` } });
        }
      }, timeoutMs);
      this.turnTimer.unref?.();

      this.sendRequest("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: prompt }],
        cwd: this.opts.workspacePath,
        title,
        approvalPolicy: cfg.codex.approval_policy,
        sandboxPolicy: cfg.codex.turn_sandbox_policy,
      })
        .then((response) => {
          const result = (response.result ?? {}) as { turn?: { id?: string } };
          const turnId = result.turn?.id;
          if (turnId) {
            this.turnId = turnId;
            const sessionId = `${this.threadId}-${turnId}`;
            this.emitEvent({
              type: "session_started",
              thread_id: this.threadId!,
              turn_id: turnId,
              pid: this.child?.pid ?? null,
              timestamp: isoNow(),
            });
            this.log.info("session_started", { session_id: sessionId });
          }
        })
        .catch((error) => {
          if (this.turnResolver) {
            const resolver = this.turnResolver;
            this.turnResolver = null;
            this.clearTurnTimer();
            resolver({ ok: false, error: { code: "response_error", message: describe(error) } });
          }
        });
    });
  }

  async shutdown(): Promise<void> {
    this.clearTurnTimer();
    if (!this.child || this.closed) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      if (!this.child) return resolve();
      const timer = setTimeout(() => {
        try {
          this.child?.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 5000).unref?.();
      this.child.once("exit", () => {
        if (timer && typeof timer === "object" && "unref" in timer) clearTimeout(timer as NodeJS.Timeout);
        resolve();
      });
    });
    this.closed = true;
  }

  // ----- internals -----

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emitEvent({ type: "malformed", timestamp: isoNow(), raw: line.slice(0, 500) });
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as ProtocolMessage;

    if (typeof (msg as JsonRpcResponse).id !== "undefined" && !(msg as { method?: string }).method) {
      this.handleResponse(msg as JsonRpcResponse);
      return;
    }

    if (typeof (msg as { method?: string }).method === "string" && typeof (msg as { id?: unknown }).id === "undefined") {
      this.handleNotification((msg as { method: string; params?: unknown }));
      return;
    }

    if (typeof (msg as { method?: string }).method === "string") {
      void this.handleIncomingRequest(msg as { id: number | string; method: string; params?: unknown });
      return;
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new Error(msg.error.message ?? `response_error for ${entry.method}`));
      return;
    }
    entry.resolve(msg);
  }

  private handleNotification(msg: { method: string; params?: unknown }): void {
    const params = msg.params as Record<string, unknown> | undefined;
    const timestamp = isoNow();

    const totals = extractUsageTotals(params);
    if (totals) {
      this.emitEvent({ type: "token_usage", timestamp, ...totals });
    }
    const rate = extractRateLimits(params);
    if (rate) this.emitEvent({ type: "rate_limits", timestamp, snapshot: rate });

    switch (msg.method) {
      case "turn/completed":
      case "turn.completed":
        this.completeTurn({ ok: true, usage: (params?.usage as Record<string, unknown>) ?? null });
        this.emitEvent({ type: "turn_completed", timestamp, usage: (params?.usage as Record<string, unknown>) ?? null });
        break;
      case "turn/failed":
      case "turn.failed": {
        const reason = summarizeMessage(params) || "turn_failed";
        this.completeTurn({ ok: false, error: { code: "turn_failed", message: reason } });
        this.emitEvent({ type: "turn_failed", timestamp, reason });
        break;
      }
      case "turn/cancelled":
      case "turn.cancelled": {
        const reason = summarizeMessage(params) || "turn_cancelled";
        this.completeTurn({ ok: false, error: { code: "turn_cancelled", message: reason } });
        this.emitEvent({ type: "turn_cancelled", timestamp, reason });
        break;
      }
      case "turn/endedWithError":
      case "turn.endedWithError":
      case "turn.ended_with_error": {
        const reason = summarizeMessage(params) || "turn_ended_with_error";
        this.completeTurn({ ok: false, error: { code: "turn_failed", message: reason } });
        this.emitEvent({ type: "turn_ended_with_error", timestamp, reason });
        break;
      }
      case "turn/inputRequired":
      case "item/tool/requestUserInput": {
        this.completeTurn({
          ok: false,
          error: { code: "turn_input_required", message: "agent requested user input" },
        });
        this.emitEvent({ type: "turn_input_required", timestamp });
        break;
      }
      case "notification": {
        this.emitEvent({ type: "notification", timestamp, message: summarizeMessage(params) });
        break;
      }
      default: {
        this.emitEvent({
          type: "other_message",
          timestamp,
          message: summarizeMessage(params),
          raw: msg,
        });
        break;
      }
    }
  }

  private async handleIncomingRequest(msg: { id: number | string; method: string; params?: unknown }): Promise<void> {
    const timestamp = isoNow();
    try {
      if (msg.method === "approval/request" || msg.method === "item/tool/requestApproval") {
        this.sendResponse(msg.id, { approved: true });
        this.emitEvent({
          type: "approval_auto_approved",
          timestamp,
          kind: ((msg.params as Record<string, unknown> | undefined)?.type as string) ?? "generic",
        });
        return;
      }
      if (msg.method === "item/tool/call") {
        const params = msg.params as Record<string, unknown> | undefined;
        const name = typeof params?.name === "string" ? params!.name : "";
        if (name === "linear_graphql" && this.opts.linearGraphqlTool) {
          const result = await this.opts.linearGraphqlTool({ name, arguments: params!.arguments });
          this.sendResponse(msg.id, result);
          return;
        }
        this.sendResponse(msg.id, { success: false, error: "unsupported_tool_call" });
        this.emitEvent({ type: "unsupported_tool_call", timestamp, tool: name });
        return;
      }
      if (msg.method === "item/tool/requestUserInput") {
        this.sendResponse(msg.id, { success: false, error: "user_input_unsupported" });
        this.completeTurn({
          ok: false,
          error: { code: "turn_input_required", message: "agent requested user input" },
        });
        this.emitEvent({ type: "turn_input_required", timestamp });
        return;
      }
      this.sendResponse(msg.id, null);
    } catch (error) {
      this.sendResponseError(msg.id, describe(error));
    }
  }

  private completeTurn(result: TurnResult): void {
    if (!this.turnResolver) return;
    const resolver = this.turnResolver;
    this.turnResolver = null;
    this.clearTurnTimer();
    resolver(result);
  }

  private clearTurnTimer(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }

  private failAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private emitEvent(event: CodexEvent): void {
    try {
      this.opts.onEvent(event);
    } catch (error) {
      this.log.warn("codex_event_consumer_error", { error: describe(error) });
    }
  }

  private sendRequest(method: string, params: unknown): Promise<JsonRpcResponse> {
    if (!this.child) return Promise.reject(new Error("codex process not launched"));
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0" as const, id, method, params };
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`response_timeout for ${method}`));
      }, this.opts.config.codex.read_timeout_ms);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.child!.stdin.write(JSON.stringify(payload) + "\n");
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.child) return;
    const payload = { jsonrpc: "2.0" as const, method, params };
    try {
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    } catch (error) {
      this.log.warn("codex_notification_write_error", { error: describe(error) });
    }
  }

  private sendResponse(id: number | string, result: unknown): void {
    if (!this.child) return;
    const payload = { jsonrpc: "2.0" as const, id, result };
    try {
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    } catch (error) {
      this.log.warn("codex_response_write_error", { error: describe(error) });
    }
  }

  private sendResponseError(id: number | string, message: string): void {
    if (!this.child) return;
    const payload = {
      jsonrpc: "2.0" as const,
      id,
      error: { code: -32000, message },
    };
    try {
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    } catch {
      // ignore
    }
  }
}

function buildLaunchCommand(
  codexCommand: string,
  workspacePath: string,
  remoteHost: string | null,
): [string, string[]] {
  const innerScript = `cd ${shellQuote(workspacePath)} && ${codexCommand}`;
  if (remoteHost) {
    return ["ssh", [remoteHost, "bash", "-lc", innerScript]];
  }
  return ["bash", ["-lc", innerScript]];
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isoNow(): string {
  return new Date().toISOString();
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
