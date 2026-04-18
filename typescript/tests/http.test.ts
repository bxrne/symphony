import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { SymphonyHttpServer } from "../src/http/server.js";
import type { Issue, ServiceConfig, WorkflowDefinition } from "../src/types.js";
import type { TrackerClient } from "../src/tracker/types.js";

function cfg(): ServiceConfig {
  return {
    tracker: {
      kind: "linear",
      endpoint: "x",
      api_key: "t",
      project_slug: "p",
      team_key: null,
      active_states: ["Todo"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 60_000 },
    workspace: { root: "/tmp/sym-http-tests" },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 60_000 },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_retry_backoff_ms: 60_000, max_concurrent_agents_by_state: {} },
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

function makeTracker(): TrackerClient {
  return {
    async fetchCandidateIssues() {
      return [];
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return [];
    },
  };
}

describe("http server", () => {
  let server: SymphonyHttpServer | null = null;
  let orchestrator: Orchestrator | null = null;

  beforeEach(async () => {
    const wf: WorkflowDefinition = { config: {}, prompt_template: "body" };
    const c = cfg();
    orchestrator = new Orchestrator({
      getSnapshot: () => ({ workflow: wf, config: c }),
      workspaceManager: new WorkspaceManager(() => c),
      tracker: makeTracker(),
    });
    server = new SymphonyHttpServer({ port: 0, orchestrator });
  });

  afterEach(async () => {
    await server?.stop();
    await orchestrator?.stop();
  });

  it("serves state endpoint", async () => {
    const { port } = await server!.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/state`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toEqual({ running: 0, retrying: 0 });
    expect(body.running).toEqual([]);
    expect(body.retrying).toEqual([]);
  });

  it("returns 404 for unknown issue", async () => {
    const { port } = await server!.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/UNKNOWN-99`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("issue_not_found");
  });

  it("accepts refresh POST with 202", async () => {
    const { port } = await server!.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/refresh`, { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.queued).toBe(true);
    expect(body.operations).toEqual(["poll", "reconcile"]);
  });

  it("rejects wrong methods with 405", async () => {
    const { port } = await server!.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/state`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("serves dashboard html", async () => {
    const { port } = await server!.start();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Symphony");
  });

  it("unused: issue seen as retrying", async () => {
    const _issue: Issue = {
      id: "i1",
      identifier: "ABC-1",
      title: "t",
      description: null,
      priority: null,
      state: "Todo",
      branch_name: null,
      url: null,
      labels: [],
      blocked_by: [],
      created_at: null,
      updated_at: null,
    };
    // ensure Issue type import is used
    expect(_issue.identifier).toBe("ABC-1");
  });
});
