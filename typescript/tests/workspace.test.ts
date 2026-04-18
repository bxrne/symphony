import { describe, it, expect } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertInsideRoot,
  sanitizeWorkspaceKey,
  workspacePathFor,
} from "../src/workspace/safety.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import type { ServiceConfig } from "../src/types.js";

function cfgWithRoot(root: string, hooks: Partial<ServiceConfig["hooks"]> = {}): ServiceConfig {
  return {
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "tok",
      project_slug: "demo",
      team_key: null,
      active_states: ["Todo"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 5000 },
    workspace: { root },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 10_000,
      ...hooks,
    },
    agent: {
      max_concurrent_agents: 2,
      max_turns: 4,
      max_retry_backoff_ms: 60_000,
      max_concurrent_agents_by_state: {},
    },
    codex: {
      command: "codex app-server",
      approval_policy: "never",
      thread_sandbox: "workspace-write",
      turn_sandbox_policy: { type: "workspaceWrite" },
      turn_timeout_ms: 600_000,
      read_timeout_ms: 5000,
      stall_timeout_ms: 60_000,
    },
    worker: { ssh_hosts: [], max_concurrent_agents_per_host: null },
    server: { port: null },
  };
}

describe("workspace safety", () => {
  it("sanitizes identifiers", () => {
    expect(sanitizeWorkspaceKey("ABC-123")).toBe("ABC-123");
    expect(sanitizeWorkspaceKey("bad/name with spaces")).toBe("bad_name_with_spaces");
  });

  it("rejects paths outside root", () => {
    expect(() => assertInsideRoot("/tmp/root", "/tmp/other/thing")).toThrow();
  });

  it("accepts direct child", () => {
    expect(() => assertInsideRoot("/tmp/root", "/tmp/root/child")).not.toThrow();
  });

  it("computes deterministic path", () => {
    expect(workspacePathFor("/tmp/root", "bad/ident")).toBe(path.resolve("/tmp/root/bad_ident"));
  });
});

describe("workspace manager", () => {
  it("creates workspace and marks created_now", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sym-ws-"));
    try {
      const mgr = new WorkspaceManager(() => cfgWithRoot(root));
      const ws1 = await mgr.ensure("ABC-9");
      expect(ws1.created_now).toBe(true);
      expect(ws1.workspace_key).toBe("ABC-9");
      const ws2 = await mgr.ensure("ABC-9");
      expect(ws2.created_now).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs after_create only on fresh directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sym-ws-"));
    try {
      const hook = "touch created.marker";
      const mgr = new WorkspaceManager(() => cfgWithRoot(root, { after_create: hook }));
      const ws = await mgr.ensure("MARK");
      const marker = path.join(ws.path, "created.marker");
      expect((await stat(marker)).isFile()).toBe(true);

      const ws2 = await mgr.ensure("MARK");
      expect(ws2.created_now).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts workspace creation if after_create fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sym-ws-"));
    try {
      const mgr = new WorkspaceManager(() => cfgWithRoot(root, { after_create: "exit 1" }));
      await expect(mgr.ensure("FAIL")).rejects.toMatchObject({ code: "after_create_failed" });
      await expect(stat(path.join(root, "FAIL"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
