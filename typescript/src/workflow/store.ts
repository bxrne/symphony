import { resolve } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { deriveServiceConfig } from "./config.js";
import { loadWorkflow, WorkflowLoadError } from "./loader.js";
import type { ServiceConfig, WorkflowDefinition } from "../types.js";
import { rootLogger } from "../logger.js";

export type WorkflowSnapshot = {
  workflow: WorkflowDefinition;
  config: ServiceConfig;
  source: string;
  loaded_at: string;
};

export type ReloadListener = (snapshot: WorkflowSnapshot) => void;

export class WorkflowStore {
  private snapshot: WorkflowSnapshot | null = null;
  private lastError: WorkflowLoadError | Error | null = null;
  private watcher: FSWatcher | null = null;
  private listeners = new Set<ReloadListener>();
  private log = rootLogger.child({ component: "workflow_store" });

  constructor(private readonly sourcePath: string) {}

  get path(): string {
    return resolve(this.sourcePath);
  }

  async load(): Promise<WorkflowSnapshot> {
    const workflow = await loadWorkflow(this.path);
    const config = deriveServiceConfig(workflow);
    this.snapshot = {
      workflow,
      config,
      source: this.path,
      loaded_at: new Date().toISOString(),
    };
    this.lastError = null;
    return this.snapshot;
  }

  current(): WorkflowSnapshot {
    if (!this.snapshot) throw new Error("workflow has not been loaded yet");
    return this.snapshot;
  }

  error(): Error | null {
    return this.lastError;
  }

  subscribe(listener: ReloadListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startWatching(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.path, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    const handler = () => {
      this.reload().catch((error) => {
        this.log.error("workflow_reload_failed", { error: describe(error) });
      });
    };
    this.watcher.on("change", handler);
    this.watcher.on("add", handler);
  }

  async stopWatching(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
  }

  async reload(): Promise<void> {
    try {
      const next = await this.load();
      this.log.info("workflow_reloaded", { source: this.path });
      for (const listener of this.listeners) {
        try {
          listener(next);
        } catch (error) {
          this.log.error("workflow_listener_error", { error: describe(error) });
        }
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      this.log.error("workflow_reload_error", { error: describe(error) });
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
