import { describe, it, expect } from "vitest";
import { normalizeLinearIssue } from "../src/tracker/normalize.js";

describe("linear issue normalization", () => {
  it("normalizes labels to lowercase", () => {
    const issue = normalizeLinearIssue({
      id: "id1",
      identifier: "ABC-1",
      title: "Hi",
      state: { name: "Todo" },
      labels: { nodes: [{ name: "BUG" }, { name: "P1" }] },
    });
    expect(issue?.labels).toEqual(["bug", "p1"]);
  });

  it("extracts blockers from inverseRelations where type=blocks", () => {
    const issue = normalizeLinearIssue({
      id: "id1",
      identifier: "ABC-1",
      title: "Hi",
      state: { name: "Todo" },
      inverseRelations: {
        nodes: [
          { type: "blocks", issue: { id: "b1", identifier: "ABC-5", state: { name: "Done" } } },
          { type: "duplicates", issue: { id: "b2", identifier: "ABC-6", state: { name: "Done" } } },
        ],
      },
    });
    expect(issue?.blocked_by).toHaveLength(1);
    expect(issue?.blocked_by[0]).toEqual({ id: "b1", identifier: "ABC-5", state: "Done" });
  });

  it("returns null when required fields missing", () => {
    expect(normalizeLinearIssue({ id: "id1" })).toBeNull();
  });

  it("preserves priority integer and drops non-integers", () => {
    const ok = normalizeLinearIssue({
      id: "id1",
      identifier: "ABC-1",
      title: "Hi",
      state: { name: "Todo" },
      priority: 3,
    });
    expect(ok?.priority).toBe(3);
    const bad = normalizeLinearIssue({
      id: "id1",
      identifier: "ABC-1",
      title: "Hi",
      state: { name: "Todo" },
      priority: "not-a-number",
    });
    expect(bad?.priority).toBeNull();
  });
});
