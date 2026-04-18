import type { CodexEvent } from "../types.js";

type AnyRecord = Record<string, unknown>;

export function extractUsageTotals(payload: unknown): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as AnyRecord;
  const candidates: unknown[] = [
    record.total_token_usage,
    record.totalTokenUsage,
    record.thread_token_usage,
    record.threadTokenUsage,
    record.usage,
    record,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const obj = candidate as AnyRecord;
    const input = coerceNumber(obj.input_tokens ?? obj.inputTokens ?? obj.prompt_tokens);
    const output = coerceNumber(
      obj.output_tokens ?? obj.outputTokens ?? obj.completion_tokens,
    );
    const total = coerceNumber(obj.total_tokens ?? obj.totalTokens);
    if (input !== null || output !== null || total !== null) {
      const inVal = input ?? 0;
      const outVal = output ?? 0;
      const totalVal = total ?? inVal + outVal;
      return { input_tokens: inVal, output_tokens: outVal, total_tokens: totalVal };
    }
  }
  return null;
}

export function extractRateLimits(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as AnyRecord;
  const candidates: unknown[] = [
    record.rate_limits,
    record.rateLimits,
    record.rate_limit,
    record.rateLimit,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return null;
}

export function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function describeEventType(method: string, params: unknown): string {
  const normalized = method.replace(/\//g, ".");
  if (!params || typeof params !== "object") return normalized;
  const p = params as AnyRecord;
  if (typeof p.type === "string") return `${normalized}:${p.type}`;
  return normalized;
}

export function summarizeMessage(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const record = params as AnyRecord;
  if (typeof record.message === "string") return record.message.slice(0, 500);
  const item = record.item as AnyRecord | undefined;
  if (item) {
    if (typeof item.text === "string") return item.text.slice(0, 500);
    if (typeof item.summary === "string") return item.summary.slice(0, 500);
  }
  return "";
}

export { type CodexEvent };
