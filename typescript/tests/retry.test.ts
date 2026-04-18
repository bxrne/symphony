import { describe, it, expect } from "vitest";
import { computeFailureDelay, CONTINUATION_DELAY_MS } from "../src/orchestrator/retry.js";
import type { ServiceConfig } from "../src/types.js";

function cfg(max: number): ServiceConfig {
  return {
    tracker: { kind: "linear", endpoint: "", api_key: "t", project_slug: "p", team_key: null, active_states: [], terminal_states: [] },
    polling: { interval_ms: 1000 },
    workspace: { root: "/tmp" },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 1000 },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_retry_backoff_ms: max, max_concurrent_agents_by_state: {} },
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

describe("retry backoff", () => {
  it("continuation delay is 1s", () => {
    expect(CONTINUATION_DELAY_MS).toBe(1000);
  });

  it("exponential base of 10s", () => {
    expect(computeFailureDelay(1, cfg(300_000))).toBe(10_000);
    expect(computeFailureDelay(2, cfg(300_000))).toBe(20_000);
    expect(computeFailureDelay(3, cfg(300_000))).toBe(40_000);
  });

  it("caps at configured max", () => {
    expect(computeFailureDelay(10, cfg(90_000))).toBe(90_000);
  });
});
