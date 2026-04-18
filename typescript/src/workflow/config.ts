import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentConfig,
  CodexConfig,
  HooksConfig,
  PollingConfig,
  ServerExtensionConfig,
  ServiceConfig,
  TrackerConfig,
  ValidationResult,
  WorkerExtensionConfig,
  WorkflowDefinition,
  WorkspaceConfig,
} from "../types.js";

const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;
const DEFAULT_CODEX_COMMAND = "codex app-server";
const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const DEFAULT_STALL_TIMEOUT_MS = 300_000;

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

export function deriveServiceConfig(workflow: WorkflowDefinition): ServiceConfig {
  const cfg = workflow.config ?? {};
  return {
    tracker: deriveTracker(readObject(cfg, "tracker")),
    polling: derivePolling(readObject(cfg, "polling")),
    workspace: deriveWorkspace(readObject(cfg, "workspace")),
    hooks: deriveHooks(readObject(cfg, "hooks")),
    agent: deriveAgent(readObject(cfg, "agent")),
    codex: deriveCodex(readObject(cfg, "codex")),
    worker: deriveWorker(readObject(cfg, "worker")),
    server: deriveServer(readObject(cfg, "server")),
  };
}

function deriveTracker(tracker: Record<string, unknown>): TrackerConfig {
  const kind = readString(tracker, "kind") ?? "";
  const endpointRaw = readString(tracker, "endpoint");
  const endpoint = endpointRaw ?? (kind === "linear" ? DEFAULT_LINEAR_ENDPOINT : "");
  const apiKeyRaw = readString(tracker, "api_key") ?? (kind === "linear" ? "$LINEAR_API_KEY" : null);
  const apiKey = resolveEnvString(apiKeyRaw);
  const projectSlug = resolveEnvString(readString(tracker, "project_slug"));
  const teamKey = resolveEnvString(readString(tracker, "team_key"));
  const activeStates = readStringList(tracker, "active_states") ?? DEFAULT_ACTIVE_STATES.slice();
  const terminalStates =
    readStringList(tracker, "terminal_states") ?? DEFAULT_TERMINAL_STATES.slice();
  return {
    kind,
    endpoint,
    api_key: apiKey && apiKey.length > 0 ? apiKey : null,
    project_slug: projectSlug && projectSlug.length > 0 ? projectSlug : null,
    team_key: teamKey && teamKey.length > 0 ? teamKey : null,
    active_states: activeStates,
    terminal_states: terminalStates,
  };
}

function derivePolling(polling: Record<string, unknown>): PollingConfig {
  return { interval_ms: readPositiveInt(polling, "interval_ms", DEFAULT_POLL_MS) };
}

function deriveWorkspace(workspace: Record<string, unknown>): WorkspaceConfig {
  const raw = readString(workspace, "root");
  const defaultRoot = path.join(tmpdir(), "symphony_workspaces");
  const resolved = raw ? normalizePath(resolveEnvString(raw) ?? raw) : defaultRoot;
  return { root: resolved };
}

function deriveHooks(hooks: Record<string, unknown>): HooksConfig {
  const timeout = readPositiveInt(hooks, "timeout_ms", DEFAULT_HOOK_TIMEOUT_MS);
  return {
    after_create: readOptionalString(hooks, "after_create"),
    before_run: readOptionalString(hooks, "before_run"),
    after_run: readOptionalString(hooks, "after_run"),
    before_remove: readOptionalString(hooks, "before_remove"),
    timeout_ms: timeout > 0 ? timeout : DEFAULT_HOOK_TIMEOUT_MS,
  };
}

function deriveAgent(agent: Record<string, unknown>): AgentConfig {
  const perState = readObject(agent, "max_concurrent_agents_by_state");
  const normalized: Record<string, number> = {};
  for (const [k, v] of Object.entries(perState)) {
    const parsed = coerceInt(v);
    if (parsed !== null && parsed > 0) normalized[k.toLowerCase()] = parsed;
  }
  return {
    max_concurrent_agents: readPositiveInt(agent, "max_concurrent_agents", DEFAULT_MAX_CONCURRENT_AGENTS),
    max_turns: readPositiveInt(agent, "max_turns", DEFAULT_MAX_TURNS),
    max_retry_backoff_ms: readPositiveInt(agent, "max_retry_backoff_ms", DEFAULT_MAX_RETRY_BACKOFF_MS),
    max_concurrent_agents_by_state: normalized,
  };
}

function deriveCodex(codex: Record<string, unknown>): CodexConfig {
  const turnSandbox = codex["turn_sandbox_policy"] ?? null;
  return {
    command: readString(codex, "command") ?? DEFAULT_CODEX_COMMAND,
    approval_policy: readString(codex, "approval_policy") ?? "never",
    thread_sandbox: readString(codex, "thread_sandbox") ?? "workspace-write",
    turn_sandbox_policy: turnSandbox ?? { type: "workspaceWrite" },
    turn_timeout_ms: readPositiveInt(codex, "turn_timeout_ms", DEFAULT_TURN_TIMEOUT_MS),
    read_timeout_ms: readPositiveInt(codex, "read_timeout_ms", DEFAULT_READ_TIMEOUT_MS),
    stall_timeout_ms: coerceInt(codex["stall_timeout_ms"]) ?? DEFAULT_STALL_TIMEOUT_MS,
  };
}

function deriveWorker(worker: Record<string, unknown>): WorkerExtensionConfig {
  const hostsRaw = worker["ssh_hosts"];
  const hosts: string[] = [];
  if (Array.isArray(hostsRaw)) {
    for (const entry of hostsRaw) {
      if (typeof entry === "string" && entry.trim().length > 0) hosts.push(entry.trim());
    }
  }
  const perHost = coerceInt(worker["max_concurrent_agents_per_host"]);
  return {
    ssh_hosts: hosts,
    max_concurrent_agents_per_host: perHost !== null && perHost > 0 ? perHost : null,
  };
}

function deriveServer(server: Record<string, unknown>): ServerExtensionConfig {
  const port = coerceInt(server["port"]);
  return { port: port !== null && port >= 0 ? port : null };
}

// ---- helpers -----

function readObject(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = source[key];
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const v = source[key];
  if (typeof v === "string") return v;
  return null;
}

function readOptionalString(source: Record<string, unknown>, key: string): string | null {
  const v = source[key];
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function readStringList(source: Record<string, unknown>, key: string): string[] | null {
  const v = source[key];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry === "string") out.push(entry);
  }
  return out;
}

function readPositiveInt(source: Record<string, unknown>, key: string, fallback: number): number {
  const parsed = coerceInt(source[key]);
  if (parsed !== null && parsed > 0) return parsed;
  return fallback;
}

function coerceInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

export function resolveEnvString(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw.startsWith("$")) {
    const name = raw.slice(1);
    const value = process.env[name];
    if (value === undefined) return "";
    return value;
  }
  return raw;
}

export function normalizePath(raw: string): string {
  if (raw.length === 0) return raw;
  let expanded = raw;
  if (expanded.startsWith("~")) {
    expanded = path.join(homedir(), expanded.slice(1));
  }
  if (!expanded.includes(path.sep) && !expanded.includes("/")) {
    return expanded;
  }
  return path.resolve(expanded);
}

export function validateForDispatch(config: ServiceConfig): ValidationResult {
  if (!config.tracker.kind) {
    return { ok: false, code: "missing_tracker_kind", message: "tracker.kind is required" };
  }
  if (config.tracker.kind !== "linear") {
    return {
      ok: false,
      code: "unsupported_tracker_kind",
      message: `tracker.kind '${config.tracker.kind}' is not supported`,
    };
  }
  if (!config.tracker.api_key) {
    return {
      ok: false,
      code: "missing_tracker_api_key",
      message: "tracker.api_key must resolve to a non-empty value",
    };
  }
  if (!config.tracker.project_slug && !config.tracker.team_key) {
    return {
      ok: false,
      code: "missing_tracker_scope",
      message:
        "tracker.project_slug or tracker.team_key is required for tracker.kind=linear (team_key is the short prefix like BXR; project_slug is the trailing slug in a project URL)",
    };
  }
  if (!config.codex.command || config.codex.command.trim().length === 0) {
    return {
      ok: false,
      code: "missing_codex_command",
      message: "codex.command must be non-empty",
    };
  }
  return { ok: true };
}
