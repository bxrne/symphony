import type { Issue, OrchestratorState, ServiceConfig } from "../types.js";

export function sortForDispatch(issues: Issue[]): Issue[] {
  return issues.slice().sort((a, b) => {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    const ta = a.created_at ?? "";
    const tb = b.created_at ?? "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
  });
}

export function availableGlobalSlots(state: OrchestratorState): number {
  return Math.max(0, state.max_concurrent_agents - state.running.size);
}

export function shouldDispatch(
  issue: Issue,
  state: OrchestratorState,
  cfg: ServiceConfig,
): { ok: true } | { ok: false; reason: string } {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
    return { ok: false, reason: "missing_required_fields" };
  }
  const active = new Set(cfg.tracker.active_states.map((s) => s.toLowerCase()));
  const terminal = new Set(cfg.tracker.terminal_states.map((s) => s.toLowerCase()));
  const stateNorm = issue.state.toLowerCase();
  if (!active.has(stateNorm)) return { ok: false, reason: "not_active" };
  if (terminal.has(stateNorm)) return { ok: false, reason: "terminal" };
  if (state.running.has(issue.id)) return { ok: false, reason: "already_running" };
  if (state.claimed.has(issue.id)) return { ok: false, reason: "already_claimed" };
  if (availableGlobalSlots(state) <= 0) return { ok: false, reason: "no_global_slots" };
  const perState = cfg.agent.max_concurrent_agents_by_state[stateNorm];
  if (typeof perState === "number") {
    let running = 0;
    for (const entry of state.running.values()) {
      if (entry.issue.state.toLowerCase() === stateNorm) running += 1;
    }
    if (running >= perState) return { ok: false, reason: "no_state_slots" };
  }
  if (stateNorm === "todo") {
    for (const blocker of issue.blocked_by) {
      const bs = (blocker.state ?? "").toLowerCase();
      if (bs.length === 0) return { ok: false, reason: "blocked_unknown_state" };
      if (!terminal.has(bs)) return { ok: false, reason: "blocked_non_terminal" };
    }
  }
  return { ok: true };
}

export function pickHost(
  cfg: ServiceConfig,
  state: OrchestratorState,
  preferred: string | null,
): string | null {
  const hosts = cfg.worker.ssh_hosts;
  if (hosts.length === 0) return null;
  const cap = cfg.worker.max_concurrent_agents_per_host;
  const ordered = preferred && hosts.includes(preferred) ? [preferred, ...hosts.filter((h) => h !== preferred)] : hosts;
  for (const host of ordered) {
    if (cap === null) return host;
    const running = state.host_counts.get(host) ?? 0;
    if (running < cap) return host;
  }
  return null;
}
