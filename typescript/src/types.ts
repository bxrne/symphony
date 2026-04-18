export type BlockerRef = {
  id: string | null;
  identifier: string | null;
  state: string | null;
};

export type Issue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: string | null;
  updated_at: string | null;
};

export type WorkflowDefinition = {
  config: Record<string, unknown>;
  prompt_template: string;
};

export type TrackerConfig = {
  kind: string;
  endpoint: string;
  api_key: string | null;
  project_slug: string | null;
  team_key: string | null;
  active_states: string[];
  terminal_states: string[];
};

export type PollingConfig = {
  interval_ms: number;
};

export type WorkspaceConfig = {
  root: string;
};

export type HooksConfig = {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  timeout_ms: number;
};

export type AgentConfig = {
  max_concurrent_agents: number;
  max_turns: number;
  max_retry_backoff_ms: number;
  max_concurrent_agents_by_state: Record<string, number>;
};

export type CodexConfig = {
  command: string;
  approval_policy: string;
  thread_sandbox: string;
  turn_sandbox_policy: unknown;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
};

export type WorkerExtensionConfig = {
  ssh_hosts: string[];
  max_concurrent_agents_per_host: number | null;
};

export type ServerExtensionConfig = {
  port: number | null;
};

export type ServiceConfig = {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  worker: WorkerExtensionConfig;
  server: ServerExtensionConfig;
};

export type Workspace = {
  path: string;
  workspace_key: string;
  created_now: boolean;
};

export type LiveSession = {
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  codex_app_server_pid: string | null;
  last_codex_event: string | null;
  last_codex_timestamp: string | null;
  last_codex_message: string;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  turn_count: number;
};

export type RunningEntry = LiveSession & {
  identifier: string;
  issue: Issue;
  retry_attempt: number | null;
  started_at: string;
  started_at_ms: number;
  host: string | null;
  stop: () => Promise<void>;
  workspace_path: string | null;
  recent_events: Array<{ at: string; event: string; message: string }>;
  last_error: string | null;
};

export type RetryEntry = {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  timer_handle: NodeJS.Timeout | null;
  error: string | null;
};

export type CodexTotals = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
};

export type RateLimitsSnapshot = Record<string, unknown> | null;

export type OrchestratorState = {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  completed: Set<string>;
  codex_totals: CodexTotals;
  codex_rate_limits: RateLimitsSnapshot;
  host_counts: Map<string, number>;
  restart_counts: Map<string, number>;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export type CodexEvent =
  | { type: "session_started"; thread_id: string; turn_id: string; pid: number | null; timestamp: string }
  | { type: "turn_completed"; timestamp: string; usage?: Record<string, unknown> | null }
  | { type: "turn_failed"; timestamp: string; reason: string }
  | { type: "turn_cancelled"; timestamp: string; reason: string }
  | { type: "turn_input_required"; timestamp: string }
  | { type: "startup_failed"; timestamp: string; reason: string }
  | { type: "turn_ended_with_error"; timestamp: string; reason: string }
  | { type: "approval_auto_approved"; timestamp: string; kind: string }
  | { type: "unsupported_tool_call"; timestamp: string; tool: string }
  | { type: "notification"; timestamp: string; message: string }
  | { type: "other_message"; timestamp: string; message: string; raw?: unknown }
  | { type: "malformed"; timestamp: string; raw: string }
  | { type: "token_usage"; timestamp: string; input_tokens: number; output_tokens: number; total_tokens: number }
  | { type: "rate_limits"; timestamp: string; snapshot: Record<string, unknown> };
