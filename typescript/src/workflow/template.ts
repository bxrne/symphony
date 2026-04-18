import { Liquid } from "liquidjs";
import type { Issue } from "../types.js";

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  cache: false,
});

export type TemplateVars = {
  issue: Issue;
  attempt: number | null;
};

export class TemplateParseError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "TemplateParseError";
  }
}

export class TemplateRenderError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "TemplateRenderError";
  }
}

const DEFAULT_FALLBACK = "You are working on an issue from Linear.";

export async function renderPrompt(template: string, vars: TemplateVars): Promise<string> {
  const body = template.trim().length === 0 ? DEFAULT_FALLBACK : template;
  const context = { issue: serializeIssue(vars.issue), attempt: vars.attempt };
  let parsed;
  try {
    parsed = engine.parse(body);
  } catch (error) {
    throw new TemplateParseError(`template_parse_error: ${describeError(error)}`, error);
  }
  try {
    const rendered = await engine.render(parsed, context);
    return String(rendered);
  } catch (error) {
    throw new TemplateRenderError(`template_render_error: ${describeError(error)}`, error);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function serializeIssue(issue: Issue): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(issue)) out[k] = v;
  return out;
}
