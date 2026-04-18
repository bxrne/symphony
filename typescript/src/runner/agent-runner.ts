import { EventEmitter } from "node:events";
import type { CodexEvent, Issue, ServiceConfig, WorkflowDefinition } from "../types.js";
import { CodexAppServerClient, type TurnResult } from "../codex/client.js";
import { createLinearGraphqlTool } from "../codex/tools.js";
import type { TrackerClient } from "../tracker/types.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { assertInsideRoot } from "../workspace/safety.js";
import { buildTurnPrompt } from "./prompt.js";
import { rootLogger, type Logger } from "../logger.js";

export type AgentRunnerOptions = {
  issue: Issue;
  attempt: number | null;
  workflow: () => { workflow: WorkflowDefinition; config: ServiceConfig };
  workspaceManager: WorkspaceManager;
  tracker: TrackerClient;
  remoteHost?: string | null;
  onEvent: (event: CodexEvent) => void;
  stopSignal: AbortSignal;
};

export type AgentRunOutcome =
  | { ok: true; reason: "completed" | "no_longer_active" | "max_turns"; turns: number; workspacePath: string }
  | { ok: false; code: string; message: string; turns: number; workspacePath: string | null };

export class AgentRunner extends EventEmitter {
  private log: Logger;
  private client: CodexAppServerClient | null = null;

  constructor(private readonly opts: AgentRunnerOptions) {
    super();
    this.log = rootLogger.child({
      component: "agent_runner",
      issue_id: opts.issue.id,
      issue_identifier: opts.issue.identifier,
    });
  }

  async run(): Promise<AgentRunOutcome> {
    const { workflow, workspaceManager, tracker, onEvent, stopSignal } = this.opts;
    let issue = this.opts.issue;
    const snapshot = workflow();
    const config = snapshot.config;

    let workspacePath: string;
    try {
      const workspace = await workspaceManager.ensure(issue.identifier);
      workspacePath = workspace.path;
    } catch (error) {
      return fail("workspace_error", describe(error), 0, null);
    }
    assertInsideRoot(config.workspace.root, workspacePath);

    try {
      await workspaceManager.runBeforeRun(workspacePath, issue.identifier);
    } catch (error) {
      await workspaceManager.runAfterRun(workspacePath, issue.identifier).catch(() => undefined);
      return fail("before_run_failed", describe(error), 0, workspacePath);
    }

    const linearTool = createLinearGraphqlTool(() => workflow().config);

    const client = new CodexAppServerClient({
      config,
      workspacePath,
      issue,
      remoteHost: this.opts.remoteHost ?? null,
      linearGraphqlTool: linearTool,
      onEvent,
      logger: this.log,
    });
    this.client = client;

    const abortHandler = () => {
      void client.shutdown();
    };
    stopSignal.addEventListener("abort", abortHandler, { once: true });

    try {
      await client.launch();
      await client.initialize();
      await client.startThread();
    } catch (error) {
      stopSignal.removeEventListener("abort", abortHandler);
      await client.shutdown();
      await workspaceManager.runAfterRun(workspacePath, issue.identifier).catch(() => undefined);
      return fail("startup_failed", describe(error), 0, workspacePath);
    }

    const maxTurns = Math.max(1, config.agent.max_turns);
    let turnNumber = 1;
    let turns = 0;
    let outcome: AgentRunOutcome | null = null;

    while (true) {
      if (stopSignal.aborted) {
        outcome = fail("cancelled", "cancelled_by_reconciliation", turns, workspacePath);
        break;
      }

      let prompt: string;
      try {
        prompt = await buildTurnPrompt({
          template: workflow().workflow.prompt_template,
          issue,
          attempt: this.opts.attempt,
          turnNumber,
          maxTurns,
        });
      } catch (error) {
        outcome = fail("template_render_error", describe(error), turns, workspacePath);
        break;
      }

      const title = `${issue.identifier}: ${issue.title}`;
      const turnResult: TurnResult = await client.runTurn(prompt, title);
      turns += 1;
      if (!turnResult.ok) {
        outcome = fail(turnResult.error.code, turnResult.error.message, turns, workspacePath);
        break;
      }

      if (turnNumber >= maxTurns) {
        outcome = { ok: true, reason: "max_turns", turns, workspacePath };
        break;
      }

      try {
        const refreshed = await tracker.fetchIssueStatesByIds([issue.id]);
        if (refreshed.length === 0) {
          outcome = { ok: true, reason: "no_longer_active", turns, workspacePath };
          break;
        }
        issue = refreshed[0] ?? issue;
        const activeStates = new Set(workflow().config.tracker.active_states.map((s) => s.toLowerCase()));
        if (!activeStates.has(issue.state.toLowerCase())) {
          outcome = { ok: true, reason: "no_longer_active", turns, workspacePath };
          break;
        }
      } catch (error) {
        outcome = fail("tracker_refresh_error", describe(error), turns, workspacePath);
        break;
      }

      turnNumber += 1;
    }

    stopSignal.removeEventListener("abort", abortHandler);
    await client.shutdown();
    await workspaceManager.runAfterRun(workspacePath, issue.identifier).catch(() => undefined);
    return outcome ?? fail("unknown", "runner ended without outcome", turns, workspacePath);
  }
}

function fail(code: string, message: string, turns: number, workspacePath: string | null): AgentRunOutcome {
  return { ok: false, code, message, turns, workspacePath };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
