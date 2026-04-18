import type { OrchestratorState, ServiceConfig } from "../types.js";

export function createInitialState(cfg: ServiceConfig): OrchestratorState {
  return {
    poll_interval_ms: cfg.polling.interval_ms,
    max_concurrent_agents: cfg.agent.max_concurrent_agents,
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    completed: new Set(),
    codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
    codex_rate_limits: null,
    host_counts: new Map(),
    restart_counts: new Map(),
  };
}
