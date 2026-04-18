import { spawn } from "node:child_process";
import { rootLogger } from "../logger.js";

export type HookResult = {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
};

export type HookKind = "after_create" | "before_run" | "after_run" | "before_remove";

export type HookOptions = {
  kind: HookKind;
  script: string;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  issueIdentifier?: string;
};

const MAX_CAPTURE = 64 * 1024;

export async function runHook(opts: HookOptions): Promise<HookResult> {
  const log = rootLogger.child({
    component: "hook",
    hook: opts.kind,
    issue_identifier: opts.issueIdentifier,
  });
  log.info("hook_started", { cwd: opts.cwd, timeout_ms: opts.timeoutMs });

  return await new Promise<HookResult>((resolvePromise) => {
    const child = spawn("bash", ["-lc", opts.script], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 2000).unref();
      } catch {
        // ignore
      }
    }, opts.timeoutMs);
    timer.unref();

    child.stdout.on("data", (buf: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += buf.toString("utf8");
    });
    child.stderr.on("data", (buf: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += buf.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      log.error("hook_spawn_error", { error: error.message });
      resolvePromise({
        ok: false,
        code: null,
        signal: null,
        stdout,
        stderr: stderr + `\n[spawn error] ${error.message}`,
        timed_out: false,
      });
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const ok = !timedOut && code === 0;
      if (timedOut) {
        log.warn("hook_timeout", { code, signal });
      } else if (!ok) {
        log.warn("hook_failed", { code, signal });
      } else {
        log.info("hook_completed");
      }
      resolvePromise({ ok, code, signal, stdout, stderr, timed_out: timedOut });
    });
  });
}
