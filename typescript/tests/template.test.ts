import { describe, it, expect } from "vitest";
import { renderPrompt, TemplateRenderError } from "../src/workflow/template.js";
import type { Issue } from "../src/types.js";

const baseIssue: Issue = {
  id: "id1",
  identifier: "ABC-123",
  title: "Do the thing",
  description: "A description",
  priority: 2,
  state: "Todo",
  branch_name: null,
  url: "https://linear.app/abc/issue/ABC-123",
  labels: ["bug", "p1"],
  blocked_by: [],
  created_at: null,
  updated_at: null,
};

describe("template renderer", () => {
  it("renders issue fields and attempt", async () => {
    const out = await renderPrompt(
      "hello {{ issue.identifier }} attempt={{ attempt }} state={{ issue.state }}",
      { issue: baseIssue, attempt: 3 },
    );
    expect(out).toBe("hello ABC-123 attempt=3 state=Todo");
  });

  it("fails strictly on unknown variables", async () => {
    await expect(
      renderPrompt("hello {{ issue.bogus_field }}", { issue: baseIssue, attempt: null }),
    ).rejects.toBeInstanceOf(TemplateRenderError);
  });

  it("uses fallback prompt for empty body", async () => {
    const out = await renderPrompt("   \n  ", { issue: baseIssue, attempt: null });
    expect(out).toContain("You are working on an issue from Linear.");
  });

  it("iterates labels", async () => {
    const out = await renderPrompt(
      "{% for label in issue.labels %}[{{ label }}]{% endfor %}",
      { issue: baseIssue, attempt: null },
    );
    expect(out).toBe("[bug][p1]");
  });
});
