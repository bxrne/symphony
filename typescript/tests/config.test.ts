import { describe, it, expect, beforeEach } from "vitest";
import { deriveServiceConfig, resolveEnvString, validateForDispatch } from "../src/workflow/config.js";

describe("config layer", () => {
  beforeEach(() => {
    delete process.env.SYMPHONY_TEST_TOKEN;
  });

  it("applies defaults when sections are missing", () => {
    const cfg = deriveServiceConfig({ config: {}, prompt_template: "" });
    expect(cfg.polling.interval_ms).toBe(30_000);
    expect(cfg.agent.max_concurrent_agents).toBe(10);
    expect(cfg.agent.max_turns).toBe(20);
    expect(cfg.agent.max_retry_backoff_ms).toBe(300_000);
    expect(cfg.codex.command).toBe("codex app-server");
    expect(cfg.codex.turn_timeout_ms).toBe(3_600_000);
    expect(cfg.codex.read_timeout_ms).toBe(5_000);
    expect(cfg.codex.stall_timeout_ms).toBe(300_000);
    expect(cfg.tracker.active_states).toEqual(["Todo", "In Progress"]);
    expect(cfg.tracker.terminal_states).toContain("Done");
    expect(cfg.hooks.timeout_ms).toBe(60_000);
    expect(cfg.worker.ssh_hosts).toEqual([]);
    expect(cfg.worker.max_concurrent_agents_per_host).toBeNull();
    expect(cfg.server.port).toBeNull();
  });

  it("resolves $VAR indirection for api keys", () => {
    process.env.SYMPHONY_TEST_TOKEN = "secret-token";
    const cfg = deriveServiceConfig({
      config: {
        tracker: {
          kind: "linear",
          api_key: "$SYMPHONY_TEST_TOKEN",
          project_slug: "demo",
        },
      },
      prompt_template: "",
    });
    expect(cfg.tracker.api_key).toBe("secret-token");
  });

  it("treats missing env variable as empty", () => {
    expect(resolveEnvString("$SYMPHONY_NOT_SET")).toBe("");
  });

  it("coerces string ints", () => {
    const cfg = deriveServiceConfig({
      config: { polling: { interval_ms: "5000" }, agent: { max_concurrent_agents: "3" } },
      prompt_template: "",
    });
    expect(cfg.polling.interval_ms).toBe(5000);
    expect(cfg.agent.max_concurrent_agents).toBe(3);
  });

  it("normalizes per-state concurrency map", () => {
    const cfg = deriveServiceConfig({
      config: {
        agent: {
          max_concurrent_agents_by_state: {
            "In Progress": 2,
            Rework: "-1",
            Todo: 0,
            BAD: "nope",
          },
        },
      },
      prompt_template: "",
    });
    expect(cfg.agent.max_concurrent_agents_by_state).toEqual({ "in progress": 2 });
  });

  it("validates dispatch preflight", () => {
    const cfg = deriveServiceConfig({
      config: {
        tracker: { kind: "linear", api_key: "tok", project_slug: "demo" },
      },
      prompt_template: "",
    });
    expect(validateForDispatch(cfg)).toEqual({ ok: true });
  });

  it("rejects unsupported tracker kind", () => {
    const cfg = deriveServiceConfig({
      config: { tracker: { kind: "jira", api_key: "tok", project_slug: "p" } },
      prompt_template: "",
    });
    const result = validateForDispatch(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported_tracker_kind");
  });

  it("requires api key after $ resolution", () => {
    const cfg = deriveServiceConfig({
      config: { tracker: { kind: "linear", api_key: "$SYMPHONY_NOT_SET", project_slug: "p" } },
      prompt_template: "",
    });
    const result = validateForDispatch(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_tracker_api_key");
  });

  it("accepts team_key as an alternative to project_slug", () => {
    const cfg = deriveServiceConfig({
      config: { tracker: { kind: "linear", api_key: "tok", team_key: "BXR" } },
      prompt_template: "",
    });
    expect(cfg.tracker.team_key).toBe("BXR");
    expect(cfg.tracker.project_slug).toBeNull();
    expect(validateForDispatch(cfg)).toEqual({ ok: true });
  });

  it("rejects when neither project_slug nor team_key is provided", () => {
    const cfg = deriveServiceConfig({
      config: { tracker: { kind: "linear", api_key: "tok" } },
      prompt_template: "",
    });
    const result = validateForDispatch(cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_tracker_scope");
  });
});
