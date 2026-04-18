#!/usr/bin/env node
import { access, constants } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { parseArgs, usage } from "./cli.js";
import { rootLogger } from "./logger.js";
import { WorkflowStore } from "./workflow/store.js";
import { validateForDispatch } from "./workflow/config.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { LinearTracker } from "./tracker/linear.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { SymphonyHttpServer } from "./http/server.js";

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`symphony: ${describe(error)}\n${usage()}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const workflowPath = resolvePath(args.workflowPath ?? "WORKFLOW.md");
  try {
    await access(workflowPath, constants.R_OK);
  } catch {
    process.stderr.write(`symphony: cannot read workflow at ${workflowPath}\n`);
    return 2;
  }

  const log = rootLogger;
  const store = new WorkflowStore(workflowPath);
  try {
    await store.load();
  } catch (error) {
    log.error("workflow_load_failed", { error: describe(error) });
    return 2;
  }

  const preflight = validateForDispatch(store.current().config);
  if (!preflight.ok) {
    log.error("startup_preflight_failed", { code: preflight.code, message: preflight.message });
    return 2;
  }

  store.startWatching();

  const workspaceManager = new WorkspaceManager(() => store.current().config);
  const tracker = new LinearTracker(() => store.current().config);

  try {
    const info = await tracker.describeProject();
    const cfg = store.current().config.tracker;

    if (cfg.project_slug) {
      if (info.matching_projects.length === 0) {
        log.warn("linear_project_not_found", {
          configured_slug: cfg.project_slug,
          hint: "no Linear project has that slugId; example nearby projects below",
          nearby: info.nearby_projects.slice(0, 10),
        });
      } else {
        for (const p of info.matching_projects) {
          log.info("linear_project_matched", {
            name: p.name,
            slug_id: p.slug_id,
            team_keys: p.team_keys,
            state_names: p.state_names,
          });
        }
      }
    }

    if (cfg.team_key) {
      if (info.matching_teams.length === 0) {
        log.warn("linear_team_not_found", {
          configured_key: cfg.team_key,
          hint: "no Linear team has that key (e.g. BXR); example nearby teams below",
          nearby: info.nearby_teams.slice(0, 10),
        });
      } else {
        for (const t of info.matching_teams) {
          log.info("linear_team_matched", {
            name: t.name,
            key: t.key,
            state_names: t.state_names,
          });
        }
      }
    }
  } catch (error) {
    log.warn("linear_describe_failed", { error: describe(error) });
  }

  const orchestrator = new Orchestrator({
    getSnapshot: () => store.current(),
    workspaceManager,
    tracker,
  });

  store.subscribe(() => orchestrator.applyConfigChanges());

  await orchestrator.runStartupTerminalCleanup();
  await orchestrator.start();

  const effectivePort = args.port ?? store.current().config.server.port;
  let httpServer: SymphonyHttpServer | null = null;
  if (effectivePort !== null) {
    httpServer = new SymphonyHttpServer({ port: effectivePort, orchestrator });
    try {
      await httpServer.start();
    } catch (error) {
      log.error("http_start_failed", { error: describe(error) });
      await orchestrator.stop();
      return 1;
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown", { signal });
    await store.stopWatching();
    if (httpServer) await httpServer.stop();
    await orchestrator.stop();
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT").then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM").then(() => process.exit(0));
  });

  log.info("symphony_started", { workflow: workflowPath, port: effectivePort });
  await new Promise(() => undefined);
  return 0;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

main().then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (error) => {
    rootLogger.error("unhandled_fatal", { error: describe(error) });
    process.exit(1);
  },
);
