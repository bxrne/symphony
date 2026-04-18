import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLinearGraphqlTool } from "../src/codex/tools.js";
import type { ServiceConfig } from "../src/types.js";

function baseCfg(): ServiceConfig {
  return {
    tracker: {
      kind: "linear",
      endpoint: "https://linear.example/graphql",
      api_key: "tok",
      project_slug: "p",
      team_key: null,
      active_states: [],
      terminal_states: [],
    },
    polling: { interval_ms: 1000 },
    workspace: { root: "/tmp" },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 1000 },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_retry_backoff_ms: 1000, max_concurrent_agents_by_state: {} },
    codex: {
      command: "codex",
      approval_policy: "never",
      thread_sandbox: "ws",
      turn_sandbox_policy: {},
      turn_timeout_ms: 1000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 0,
    },
    worker: { ssh_hosts: [], max_concurrent_agents_per_host: null },
    server: { port: null },
  };
}

describe("linear_graphql tool", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects multi-operation queries", async () => {
    const tool = createLinearGraphqlTool(baseCfg);
    const res = await tool({ name: "linear_graphql", arguments: { query: "query A { viewer { id } } query B { viewer { id } }" } });
    expect(res.success).toBe(false);
    expect(res.error).toContain("exactly one");
  });

  it("rejects when tracker is not linear", async () => {
    const cfg = baseCfg();
    cfg.tracker.kind = "jira";
    const tool = createLinearGraphqlTool(() => cfg);
    const res = await tool({ name: "linear_graphql", arguments: { query: "{ viewer { id } }" } });
    expect(res.success).toBe(false);
  });

  it("returns success with parsed body", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: { viewer: { id: "1" } } }), { status: 200 }),
    ) as typeof fetch;
    const tool = createLinearGraphqlTool(baseCfg);
    const res = await tool({ name: "linear_graphql", arguments: { query: "{ viewer { id } }" } });
    expect(res.success).toBe(true);
    expect(res.output).toEqual({ data: { viewer: { id: "1" } } });
  });

  it("marks graphql errors as failure but preserves body", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: "bad" }] }), { status: 200 }),
    ) as typeof fetch;
    const tool = createLinearGraphqlTool(baseCfg);
    const res = await tool({ name: "linear_graphql", arguments: { query: "{ viewer { id } }" } });
    expect(res.success).toBe(false);
    expect(res.output).toEqual({ errors: [{ message: "bad" }] });
  });
});
