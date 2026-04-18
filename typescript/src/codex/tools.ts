import type { ServiceConfig } from "../types.js";
import { rootLogger } from "../logger.js";

export type ToolCallRequest = {
  name: string;
  arguments: unknown;
};

export type ToolCallResult = {
  success: boolean;
  output?: unknown;
  error?: string;
};

export type ToolHandler = (req: ToolCallRequest) => Promise<ToolCallResult>;

export const LINEAR_GRAPHQL_TOOL_SPEC = {
  name: "linear_graphql",
  description:
    "Execute a raw GraphQL query or mutation against Linear using Symphony's configured tracker auth.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "GraphQL query or mutation (exactly one operation)." },
      variables: { type: "object", description: "Optional variables object." },
    },
    required: ["query"],
  },
};

export function createLinearGraphqlTool(getConfig: () => ServiceConfig): ToolHandler {
  const log = rootLogger.child({ component: "tool_linear_graphql" });
  return async (req) => {
    const cfg = getConfig();
    if (cfg.tracker.kind !== "linear") {
      return { success: false, error: "linear_graphql tool only available when tracker.kind=linear" };
    }
    const token = cfg.tracker.api_key;
    if (!token) return { success: false, error: "missing_tracker_api_key" };

    const { query, variables } = normalizeArgs(req.arguments);
    if (!query) return { success: false, error: "missing or invalid query argument" };

    const count = countOperations(query);
    if (count !== 1) {
      return { success: false, error: `query must contain exactly one GraphQL operation (found ${count})` };
    }

    try {
      const response = await fetch(cfg.tracker.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify({ query, variables }),
      });
      const body = await response.json().catch(() => ({ errors: [{ message: "invalid json" }] }));
      if (!response.ok) {
        return { success: false, output: body, error: `http_${response.status}` };
      }
      const parsed = body as { data?: unknown; errors?: unknown };
      if (parsed.errors) return { success: false, output: parsed };
      return { success: true, output: parsed };
    } catch (error) {
      log.warn("linear_graphql_transport_error", { error: describe(error) });
      return { success: false, error: describe(error) };
    }
  };
}

function normalizeArgs(raw: unknown): { query: string | null; variables: Record<string, unknown> | null } {
  if (typeof raw === "string") return { query: raw, variables: null };
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const query = typeof record.query === "string" ? record.query : null;
    const variables =
      record.variables && typeof record.variables === "object" && !Array.isArray(record.variables)
        ? (record.variables as Record<string, unknown>)
        : null;
    return { query, variables };
  }
  return { query: null, variables: null };
}

function countOperations(query: string): number {
  const stripped = query
    .replace(/#[^\n]*/g, "")
    .replace(/"""[\s\S]*?"""/g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, "");
  const matches = stripped.match(/\b(query|mutation|subscription)\b/gi);
  if (matches && matches.length > 0) return matches.length;
  if (stripped.trim().startsWith("{")) return 1;
  return 0;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
