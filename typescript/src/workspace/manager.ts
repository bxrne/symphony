import { mkdir, rm, stat } from "node:fs/promises";
import type { ServiceConfig, Workspace } from "../types.js";
import { rootLogger } from "../logger.js";
import { runHook } from "./hooks.js";
import { assertInsideRoot, sanitizeWorkspaceKey, workspacePathFor } from "./safety.js";

export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export type PrepareResult = { workspace: Workspace };

export class WorkspaceManager {
  private log = rootLogger.child({ component: "workspace_manager" });

  constructor(private readonly getConfig: () => ServiceConfig) {}

  pathFor(identifier: string): string {
    const cfg = this.getConfig();
    return workspacePathFor(cfg.workspace.root, identifier);
  }

  async ensure(identifier: string): Promise<Workspace> {
    const cfg = this.getConfig();
    const root = cfg.workspace.root;
    await mkdir(root, { recursive: true });
    const key = sanitizeWorkspaceKey(identifier);
    const target = workspacePathFor(root, identifier);
    assertInsideRoot(root, target);

    let createdNow = false;
    try {
      const info = await stat(target);
      if (!info.isDirectory()) {
        throw new WorkspaceError(
          "invalid_workspace_path",
          `path ${target} exists but is not a directory`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        await mkdir(target, { recursive: true });
        createdNow = true;
      } else {
        throw err;
      }
    }

    if (createdNow && cfg.hooks.after_create) {
      const result = await runHook({
        kind: "after_create",
        script: cfg.hooks.after_create,
        cwd: target,
        timeoutMs: cfg.hooks.timeout_ms,
        issueIdentifier: identifier,
      });
      if (!result.ok) {
        try {
          await rm(target, { recursive: true, force: true });
        } catch (cleanup) {
          this.log.warn("after_create_cleanup_failed", {
            issue_identifier: identifier,
            error: describe(cleanup),
          });
        }
        throw new WorkspaceError(
          "after_create_failed",
          `after_create hook failed${result.timed_out ? " (timeout)" : ""}`,
        );
      }
    }

    this.log.info("workspace_ready", {
      issue_identifier: identifier,
      workspace_key: key,
      path: target,
      created_now: createdNow,
    });

    return { path: target, workspace_key: key, created_now: createdNow };
  }

  async remove(identifier: string): Promise<void> {
    const cfg = this.getConfig();
    const target = workspacePathFor(cfg.workspace.root, identifier);
    assertInsideRoot(cfg.workspace.root, target);
    try {
      await stat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (cfg.hooks.before_remove) {
      const result = await runHook({
        kind: "before_remove",
        script: cfg.hooks.before_remove,
        cwd: target,
        timeoutMs: cfg.hooks.timeout_ms,
        issueIdentifier: identifier,
      });
      if (!result.ok) {
        this.log.warn("before_remove_failed_ignored", { issue_identifier: identifier });
      }
    }
    await rm(target, { recursive: true, force: true });
    this.log.info("workspace_removed", { issue_identifier: identifier, path: target });
  }

  async runBeforeRun(workspacePath: string, identifier: string): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.hooks.before_run) return;
    const result = await runHook({
      kind: "before_run",
      script: cfg.hooks.before_run,
      cwd: workspacePath,
      timeoutMs: cfg.hooks.timeout_ms,
      issueIdentifier: identifier,
    });
    if (!result.ok) {
      throw new WorkspaceError(
        "before_run_failed",
        `before_run hook failed${result.timed_out ? " (timeout)" : ""}`,
      );
    }
  }

  async runAfterRun(workspacePath: string, identifier: string): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.hooks.after_run) return;
    const result = await runHook({
      kind: "after_run",
      script: cfg.hooks.after_run,
      cwd: workspacePath,
      timeoutMs: cfg.hooks.timeout_ms,
      issueIdentifier: identifier,
    });
    if (!result.ok) {
      this.log.warn("after_run_failed_ignored", { issue_identifier: identifier });
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
