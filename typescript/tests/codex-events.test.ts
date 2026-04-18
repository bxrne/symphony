import { describe, it, expect } from "vitest";
import { extractRateLimits, extractUsageTotals } from "../src/codex/events.js";

describe("codex event helpers", () => {
  it("prefers thread-level absolute totals", () => {
    const totals = extractUsageTotals({
      total_token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
    expect(totals).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
  });

  it("falls back to usage field when absolute absent", () => {
    const totals = extractUsageTotals({ usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } });
    expect(totals).toEqual({ input_tokens: 1, output_tokens: 2, total_tokens: 3 });
  });

  it("derives total from components when missing", () => {
    const totals = extractUsageTotals({ inputTokens: 5, outputTokens: 7 });
    expect(totals).toEqual({ input_tokens: 5, output_tokens: 7, total_tokens: 12 });
  });

  it("extracts rate limits from various keys", () => {
    expect(extractRateLimits({ rate_limits: { a: 1 } })).toEqual({ a: 1 });
    expect(extractRateLimits({ rateLimit: { b: 2 } })).toEqual({ b: 2 });
    expect(extractRateLimits({})).toBeNull();
  });
});
