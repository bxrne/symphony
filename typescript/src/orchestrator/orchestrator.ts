import { EventEmitter } from "node:events";
import type {
  CodexEvent,
  Issue,
  OrchestratorState,
  RunningEntry,
  ServiceConfig,
  ValidationResult,
  WorkflowDefinition,
} from "../types.js";
import { rootLogger, type Logger } from "../logger.js";
import { WorkspaceManager } from "../workspace/manager.js";
import type { TrackerClient } from "../tracker/types.js";
import { AgentRunner } from "../runner/agent-runner.js";
import { availableGlobalSlots, pickHost, shouldDispatch, sortForDispatch } from "./dispatch.js";
import { cancelRetry, computeFailureDelay, CONTINUATION_DELAY_MS, scheduleRetry } from "./retry.js";
import { createInitialState } from "./state.js";
import { validateForDispatch } from "../workflow/config.js";

export type OrchestratorDeps = {
  getSnapshot: () => { workflow: WorkflowDefinition; config: ServiceConfig };
  workspaceManager: WorkspaceManager;
  tracker: TrackerClient;
  logger?: Logger;
};

const MAX_RECENT_EVENTS = 25;

export class Orchestrator extends EventEmitter {
  readonly state: OrchestratorState;
  private log: Logger;
  private pollTimer: NodeJS.Timeout | null = null;
  private runningAborts = new Map<string, AbortController>();
  private refreshPending = false;
  private stopped = false;

  constructor(private readonly deps: OrchestratorDeps) {
    super();
    this.state = createInitialState(this.deps.getSnapshot().config);
    this.log = deps.logger ?? rootLogger.child({ component: "orchestrator" });
  }

  getSnapshotForApi() {
    return {
      state: this.state,
      running: Array.from(this.state.running.values()),
      retrying: Array.from(this.state.retry_attempts.values()),
    };
  }

  async start(): Promise<void> {
    this.applyConfigChanges();
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    for (const [, controller] of this.runningAborts) controller.abort();
    for (const entry of this.state.retry_attempts.values()) {
      if (entry.timer_handle) clearTimeout(entry.timer_handle);
    }
    await Promise.all(
      Array.from(this.state.running.values()).map((r) => r.stop().catch(() => undefined)),
    );
  }

  requestRefresh(): { queued: boolean; coalesced: boolean } {
    if (this.refreshPending) return { queued: true, coalesced: true };
    this.refreshPending = true;
    queueMicrotask(() => {
      this.refreshPending = false;
      if (!this.stopped) {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        void this.tick();
      }
    });
    return { queued: true, coalesced: false };
  }

  applyConfigChanges(): void {
    const cfg = this.deps.getSnapshot().config;
    this.state.poll_interval_ms = cfg.polling.interval_ms;
    this.state.max_concurrent_agents = cfg.agent.max_concurrent_agents;
  }

  async runStartupTerminalCleanup(): Promise<void> {
    const cfg = this.deps.getSnapshot().config;
    try {
      const terminals = await this.deps.tracker.fetchIssuesByStates(cfg.tracker.terminal_states);
      for (const issue of terminals) {
        try {
          await this.deps.workspaceManager.remove(issue.identifier);
        } catch (error) {
          this.log.warn("startup_cleanup_failed", {
            issue_identifier: issue.identifier,
            error: describe(error),
          });
        }
      }
    } catch (error) {
      this.log.warn("startup_terminal_fetch_failed", { error: describe(error) });
    }
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      void this.tick();
    }, Math.max(0, delayMs));
    this.pollTimer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.applyConfigChanges();
    try {
      await this.reconcileRunningIssues();
      const validation: ValidationResult = validateForDispatch(this.deps.getSnapshot().config);
      if (!validation.ok) {
        this.log.warn("dispatch_preflight_failed", { code: validation.code, message: validation.message });
        this.emit("state_changed");
        return;
      }
      let candidates: Issue[];
      try {
        candidates = await this.deps.tracker.fetchCandidateIssues();
      } catch (error) {
        this.log.warn("candidate_fetch_failed", { error: describe(error) });
        this.emit("state_changed");
        return;
      }
      const cfg = this.deps.getSnapshot().config;
      this.log.info("poll_tick", {
        candidates: candidates.length,
        running: this.state.running.size,
        retrying: this.state.retry_attempts.size,
        active_states: cfg.tracker.active_states.join(","),
        project_slug: cfg.tracker.project_slug,
        team_key: cfg.tracker.team_key,
      });
      const sorted = sortForDispatch(candidates);
      const skipped: Array<{ identifier: string; reason: string; state: string }> = [];
      for (const issue of sorted) {
        if (availableGlobalSlots(this.state) <= 0) break;
        const decision = shouldDispatch(issue, this.state, cfg);
        if (!decision.ok) {
          skipped.push({ identifier: issue.identifier, reason: decision.reason, state: issue.state });
          continue;
        }
        this.log.info("dispatching", { issue_id: issue.id, issue_identifier: issue.identifier, state: issue.state });
        this.dispatch(issue, null);
      }
      if (skipped.length > 0) {
        this.log.debug("dispatch_skipped", { skipped });
      }
      this.emit("state_changed");
    } finally {
      this.scheduleTick(this.state.poll_interval_ms);
    }
  }

  private dispatch(issue: Issue, attempt: number | null): void {
    const snapshot = this.deps.getSnapshot();
    const cfg = snapshot.config;
    const preferredHost = this.state.running.get(issue.id)?.host ?? null;
    const host = pickHost(cfg, this.state, preferredHost);
    if (cfg.worker.ssh_hosts.length > 0 && host === null) {
      scheduleRetry(
        this.state,
        issue.id,
        (attempt ?? 0) + 1,
        { identifier: issue.identifier, delayMs: CONTINUATION_DELAY_MS, error: "no_ssh_host_slots" },
        (id) => this.onRetryFire(id),
      );
      return;
    }

    const abortController = new AbortController();
    this.runningAborts.set(issue.id, abortController);

    const startedAtMs = Date.now();
    const running: RunningEntry = {
      session_id: null,
      thread_id: null,
      turn_id: null,
      codex_app_server_pid: null,
      last_codex_event: null,
      last_codex_timestamp: null,
      last_codex_message: "",
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      turn_count: 0,
      identifier: issue.identifier,
      issue,
      retry_attempt: attempt,
      started_at: new Date(startedAtMs).toISOString(),
      started_at_ms: startedAtMs,
      host,
      stop: async () => {
        abortController.abort();
      },
      workspace_path: null,
      recent_events: [],
      last_error: null,
    };
    this.state.running.set(issue.id, running);
    this.state.claimed.add(issue.id);
    cancelRetry(this.state, issue.id);
    if (host) this.state.host_counts.set(host, (this.state.host_counts.get(host) ?? 0) + 1);
    this.emit("state_changed");

    const runner = new AgentRunner({
      issue,
      attempt,
      workflow: this.deps.getSnapshot,
      workspaceManager: this.deps.workspaceManager,
      tracker: this.deps.tracker,
      remoteHost: host,
      onEvent: (event) => this.handleCodexEvent(issue.id, event),
      stopSignal: abortController.signal,
    });

    void runner
      .run()
      .then((outcome) => {
        running.workspace_path = outcome.workspacePath;
        running.turn_count = outcome.turns;
        this.handleWorkerExit(issue.id, outcome);
      })
      .catch((error) => {
        this.log.error("agent_runner_crashed", {
          issue_identifier: issue.identifier,
          error: describe(error),
        });
        this.handleWorkerExit(issue.id, {
          ok: false,
          code: "runner_crashed",
          message: describe(error),
          turns: running.turn_count,
          workspacePath: null,
        });
      });
  }

  private handleCodexEvent(issueId: string, event: CodexEvent): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;
    entry.last_codex_event = event.type;
    entry.last_codex_timestamp = event.timestamp;
    entry.recent_events.push({
      at: event.timestamp,
      event: event.type,
      message: "message" in event && typeof event.message === "string" ? event.message : "",
    });
    if (entry.recent_events.length > MAX_RECENT_EVENTS) {
      entry.recent_events.splice(0, entry.recent_events.length - MAX_RECENT_EVENTS);
    }

    switch (event.type) {
      case "session_started": {
        entry.thread_id = event.thread_id;
        entry.turn_id = event.turn_id;
        entry.session_id = `${event.thread_id}-${event.turn_id}`;
        entry.codex_app_server_pid = event.pid !== null ? String(event.pid) : null;
        entry.turn_count = Math.max(entry.turn_count, 1);
        break;
      }
      case "turn_completed":
        entry.turn_count += 1;
        break;
      case "notification":
      case "other_message":
        if ("message" in event && typeof event.message === "string" && event.message.length > 0) {
          entry.last_codex_message = event.message;
        }
        break;
      case "token_usage": {
        const inputDelta = Math.max(0, event.input_tokens - entry.last_reported_input_tokens);
        const outputDelta = Math.max(0, event.output_tokens - entry.last_reported_output_tokens);
        const totalDelta = Math.max(0, event.total_tokens - entry.last_reported_total_tokens);
        entry.codex_input_tokens += inputDelta;
        entry.codex_output_tokens += outputDelta;
        entry.codex_total_tokens += totalDelta;
        entry.last_reported_input_tokens = event.input_tokens;
        entry.last_reported_output_tokens = event.output_tokens;
        entry.last_reported_total_tokens = event.total_tokens;
        this.state.codex_totals.input_tokens += inputDelta;
        this.state.codex_totals.output_tokens += outputDelta;
        this.state.codex_totals.total_tokens += totalDelta;
        break;
      }
      case "rate_limits":
        this.state.codex_rate_limits = event.snapshot;
        break;
      case "turn_failed":
      case "turn_cancelled":
      case "turn_ended_with_error":
      case "startup_failed":
        entry.last_error = "reason" in event ? event.reason : null;
        break;
    }
    this.emit("state_changed");
  }

  private handleWorkerExit(
    issueId: string,
    outcome:
      | { ok: true; reason: string; turns: number; workspacePath: string }
      | { ok: false; code: string; message: string; turns: number; workspacePath: string | null },
  ): void {
    const entry = this.state.running.get(issueId);
    this.state.running.delete(issueId);
    this.runningAborts.delete(issueId);
    if (entry) {
      const secs = Math.max(0, (Date.now() - entry.started_at_ms) / 1000);
      this.state.codex_totals.seconds_running += secs;
      if (entry.host) {
        const next = (this.state.host_counts.get(entry.host) ?? 1) - 1;
        if (next <= 0) this.state.host_counts.delete(entry.host);
        else this.state.host_counts.set(entry.host, next);
      }
    }

    if (!entry) {
      this.emit("state_changed");
      return;
    }

    if (outcome.ok) {
      this.state.completed.add(issueId);
      scheduleRetry(
        this.state,
        issueId,
        1,
        { identifier: entry.identifier, delayMs: CONTINUATION_DELAY_MS, error: null },
        (id) => this.onRetryFire(id),
      );
    } else {
      const nextAttempt = (entry.retry_attempt ?? 0) + 1;
      const delay = computeFailureDelay(nextAttempt, this.deps.getSnapshot().config);
      this.state.restart_counts.set(issueId, (this.state.restart_counts.get(issueId) ?? 0) + 1);
      scheduleRetry(
        this.state,
        issueId,
        nextAttempt,
        { identifier: entry.identifier, delayMs: delay, error: `${outcome.code}: ${outcome.message}` },
        (id) => this.onRetryFire(id),
      );
    }
    this.emit("state_changed");
  }

  private async onRetryFire(issueId: string): Promise<void> {
    const retry = this.state.retry_attempts.get(issueId);
    if (!retry) return;
    this.state.retry_attempts.delete(issueId);

    try {
      const candidates = await this.deps.tracker.fetchCandidateIssues();
      const issue = candidates.find((c) => c.id === issueId);
      if (!issue) {
        this.state.claimed.delete(issueId);
        this.emit("state_changed");
        return;
      }
      if (availableGlobalSlots(this.state) <= 0) {
        scheduleRetry(
          this.state,
          issueId,
          retry.attempt + 1,
          {
            identifier: issue.identifier,
            delayMs: computeFailureDelay(retry.attempt + 1, this.deps.getSnapshot().config),
            error: "no available orchestrator slots",
          },
          (id) => this.onRetryFire(id),
        );
        return;
      }
      this.dispatch(issue, retry.attempt);
    } catch (error) {
      scheduleRetry(
        this.state,
        issueId,
        retry.attempt + 1,
        {
          identifier: retry.identifier,
          delayMs: computeFailureDelay(retry.attempt + 1, this.deps.getSnapshot().config),
          error: `retry poll failed: ${describe(error)}`,
        },
        (id) => this.onRetryFire(id),
      );
    }
  }

  private async reconcileRunningIssues(): Promise<void> {
    const cfg = this.deps.getSnapshot().config;
    const now = Date.now();
    if (cfg.codex.stall_timeout_ms > 0) {
      for (const [id, entry] of this.state.running) {
        const last = entry.last_codex_timestamp
          ? Date.parse(entry.last_codex_timestamp)
          : entry.started_at_ms;
        const elapsed = now - last;
        if (elapsed > cfg.codex.stall_timeout_ms) {
          this.log.warn("stall_detected", {
            issue_id: id,
            issue_identifier: entry.identifier,
            elapsed_ms: elapsed,
          });
          const controller = this.runningAborts.get(id);
          controller?.abort();
        }
      }
    }

    const ids = Array.from(this.state.running.keys());
    if (ids.length === 0) return;
    let refreshed: Issue[];
    try {
      refreshed = await this.deps.tracker.fetchIssueStatesByIds(ids);
    } catch (error) {
      this.log.debug("refresh_failed_keep_running", { error: describe(error) });
      return;
    }
    const terminal = new Set(cfg.tracker.terminal_states.map((s) => s.toLowerCase()));
    const active = new Set(cfg.tracker.active_states.map((s) => s.toLowerCase()));
    for (const issue of refreshed) {
      const entry = this.state.running.get(issue.id);
      if (!entry) continue;
      const stateNorm = issue.state.toLowerCase();
      if (terminal.has(stateNorm)) {
        this.runningAborts.get(issue.id)?.abort();
        try {
          await this.deps.workspaceManager.remove(issue.identifier);
        } catch (error) {
          this.log.warn("terminal_cleanup_failed", {
            issue_identifier: issue.identifier,
            error: describe(error),
          });
        }
      } else if (active.has(stateNorm)) {
        entry.issue = issue;
      } else {
        this.runningAborts.get(issue.id)?.abort();
      }
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
