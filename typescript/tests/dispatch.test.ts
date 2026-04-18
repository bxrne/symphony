import { describe, it, expect } from "vitest";
import { shouldDispatch, sortForDispatch } from "../src/orchestrator/dispatch.js";
import { createInitialState } from "../src/orchestrator/state.js";
import type { Issue, ServiceConfig } from "../src/types.js";

function cfg(overrides: Partial<ServiceConfig["agent"]> = {}): ServiceConfig {
  return {
    tracker: {
      kind: "linear",
      endpoint: "x",
      api_key: "t",
      project_slug: "p",
      team_key: null,
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done", "Closed"],
    },
    polling: { interval_ms: 5000 },
    workspace: { root: "/tmp/xyz" },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 60_000,
    },
    agent: {
      max_concurrent_agents: 3,
      max_turns: 5,
      max_retry_backoff_ms: 60_000,
      max_concurrent_agents_by_state: {},
      ...overrides,
    },
    codex: {
      command: "codex",
      approval_policy: "never",
      thread_sandbox: "workspace-write",
      turn_sandbox_policy: {},
      turn_timeout_ms: 1000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 0,
    },
    worker: { ssh_hosts: [], max_concurrent_agents_per_host: null },
    server: { port: null },
  };
}

function issue(partial: Partial<Issue> = {}): Issue {
  return {
    id: "i1",
    identifier: "ABC-1",
    title: "t",
    description: null,
    priority: 2,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: null,
    ...partial,
  };
}

describe("dispatch ordering", () => {
  it("sorts by priority then created_at", () => {
    const a = issue({ id: "a", identifier: "AAA-1", priority: 3, created_at: "2024-01-02T00:00:00Z" });
    const b = issue({ id: "b", identifier: "AAA-2", priority: 1, created_at: "2024-01-01T00:00:00Z" });
    const c = issue({ id: "c", identifier: "AAA-3", priority: null, created_at: "2024-01-01T00:00:00Z" });
    const sorted = sortForDispatch([a, b, c]).map((i) => i.id);
    expect(sorted).toEqual(["b", "a", "c"]);
  });

  it("uses identifier tiebreaker", () => {
    const a = issue({ id: "a", identifier: "AAA-2", priority: 1, created_at: "2024-01-01T00:00:00Z" });
    const b = issue({ id: "b", identifier: "AAA-1", priority: 1, created_at: "2024-01-01T00:00:00Z" });
    const sorted = sortForDispatch([a, b]).map((i) => i.identifier);
    expect(sorted).toEqual(["AAA-1", "AAA-2"]);
  });
});

describe("dispatch eligibility", () => {
  it("rejects Todo with non-terminal blockers", () => {
    const c = cfg();
    const state = createInitialState(c);
    const i = issue({ blocked_by: [{ id: "x", identifier: "XXX-1", state: "In Progress" }] });
    expect(shouldDispatch(i, state, c)).toMatchObject({ ok: false, reason: "blocked_non_terminal" });
  });

  it("accepts Todo with terminal blockers", () => {
    const c = cfg();
    const state = createInitialState(c);
    const i = issue({ blocked_by: [{ id: "x", identifier: "XXX-1", state: "Done" }] });
    expect(shouldDispatch(i, state, c)).toEqual({ ok: true });
  });

  it("rejects terminal state", () => {
    const c = cfg();
    const state = createInitialState(c);
    const i = issue({ state: "Done" });
    expect(shouldDispatch(i, state, c).ok).toBe(false);
  });

  it("respects global concurrency", () => {
    const c = cfg({ max_concurrent_agents: 1 });
    const state = createInitialState(c);
    state.running.set("other", {
      issue: issue({ id: "other", identifier: "X", state: "In Progress" }),
    } as unknown as never);
    const i = issue({ state: "In Progress" });
    expect(shouldDispatch(i, state, c)).toMatchObject({ ok: false, reason: "no_global_slots" });
  });

  it("respects per-state concurrency", () => {
    const c = cfg({ max_concurrent_agents_by_state: { "in progress": 1 } });
    const state = createInitialState(c);
    state.running.set("r1", {
      issue: issue({ id: "r1", identifier: "X", state: "In Progress" }),
    } as unknown as never);
    const i = issue({ state: "In Progress" });
    expect(shouldDispatch(i, state, c)).toMatchObject({ ok: false, reason: "no_state_slots" });
  });
});
