import type { OrchestratorState, RetryEntry, ServiceConfig } from "../types.js";

export const CONTINUATION_DELAY_MS = 1000;
const BASE_FAILURE_DELAY_MS = 10_000;

export function computeFailureDelay(attempt: number, cfg: ServiceConfig): number {
  const attemptIdx = Math.max(1, attempt);
  const raw = BASE_FAILURE_DELAY_MS * 2 ** (attemptIdx - 1);
  return Math.min(raw, cfg.agent.max_retry_backoff_ms);
}

export function scheduleRetry(
  state: OrchestratorState,
  issueId: string,
  attempt: number,
  opts: { identifier: string; delayMs: number; error: string | null },
  onFire: (issueId: string) => void,
): RetryEntry {
  const existing = state.retry_attempts.get(issueId);
  if (existing?.timer_handle) clearTimeout(existing.timer_handle);
  const due = Date.now() + opts.delayMs;
  const timer = setTimeout(() => {
    onFire(issueId);
  }, opts.delayMs);
  timer.unref?.();
  const entry: RetryEntry = {
    issue_id: issueId,
    identifier: opts.identifier,
    attempt,
    due_at_ms: due,
    timer_handle: timer,
    error: opts.error,
  };
  state.retry_attempts.set(issueId, entry);
  state.claimed.add(issueId);
  return entry;
}

export function cancelRetry(state: OrchestratorState, issueId: string): void {
  const existing = state.retry_attempts.get(issueId);
  if (existing?.timer_handle) clearTimeout(existing.timer_handle);
  state.retry_attempts.delete(issueId);
}
