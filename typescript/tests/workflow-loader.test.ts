import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadWorkflow, parseWorkflow, WorkflowLoadError } from "../src/workflow/loader.js";

describe("workflow loader", () => {
  it("parses front matter + body", () => {
    const source = `---\npolling:\n  interval_ms: 1234\n---\nhello {{ issue.identifier }}`;
    const wf = parseWorkflow(source);
    expect(wf.config).toEqual({ polling: { interval_ms: 1234 } });
    expect(wf.prompt_template).toBe("hello {{ issue.identifier }}");
  });

  it("treats missing front matter as empty config", () => {
    const wf = parseWorkflow("just a prompt body");
    expect(wf.config).toEqual({});
    expect(wf.prompt_template).toBe("just a prompt body");
  });

  it("rejects non-map YAML front matter", () => {
    const source = `---\n- one\n- two\n---\nbody`;
    expect(() => parseWorkflow(source)).toThrowError(WorkflowLoadError);
  });

  it("rejects unterminated front matter", () => {
    expect(() => parseWorkflow("---\npolling: {}\nno terminator")).toThrowError(WorkflowLoadError);
  });

  it("returns missing_workflow_file when absent", async () => {
    await expect(loadWorkflow("/tmp/definitely-does-not-exist-xyz")).rejects.toMatchObject({
      code: "missing_workflow_file",
    });
  });

  it("loads from disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "symphony-wf-"));
    try {
      const file = path.join(dir, "WORKFLOW.md");
      await writeFile(file, "---\npolling:\n  interval_ms: 42\n---\nbody");
      const wf = await loadWorkflow(file);
      expect(wf.config).toEqual({ polling: { interval_ms: 42 } });
      expect(wf.prompt_template).toBe("body");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
