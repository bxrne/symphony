import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import type { WorkflowDefinition } from "../types.js";

export class WorkflowLoadError extends Error {
  constructor(readonly code: string, message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "WorkflowLoadError";
  }
}

export async function loadWorkflow(path: string): Promise<WorkflowDefinition> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new WorkflowLoadError(
      "missing_workflow_file",
      `Unable to read workflow at ${path}: ${describeError(error)}`,
      error,
    );
  }
  return parseWorkflow(raw);
}

export function parseWorkflow(raw: string): WorkflowDefinition {
  const { frontMatter, body } = splitFrontMatter(raw);
  const promptTemplate = body.trim();

  if (frontMatter === null) {
    return { config: {}, prompt_template: promptTemplate };
  }

  let decoded: unknown;
  try {
    decoded = yaml.load(frontMatter);
  } catch (error) {
    throw new WorkflowLoadError(
      "workflow_parse_error",
      `Failed to parse YAML front matter: ${describeError(error)}`,
      error,
    );
  }

  if (decoded === null || decoded === undefined) {
    return { config: {}, prompt_template: promptTemplate };
  }

  if (typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new WorkflowLoadError(
      "workflow_front_matter_not_a_map",
      "YAML front matter must decode to a map/object",
    );
  }

  return { config: decoded as Record<string, unknown>, prompt_template: promptTemplate };
}

function splitFrontMatter(raw: string): { frontMatter: string | null; body: string } {
  if (!raw.startsWith("---")) return { frontMatter: null, body: raw };
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return { frontMatter: null, body: raw };
  let endIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new WorkflowLoadError(
      "workflow_parse_error",
      "Front matter block is not terminated by `---`",
    );
  }
  const frontMatter = lines.slice(1, endIdx).join("\n");
  const body = lines.slice(endIdx + 1).join("\n");
  return { frontMatter, body };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
