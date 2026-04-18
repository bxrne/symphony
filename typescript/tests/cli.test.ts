import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli.js";

describe("cli parsing", () => {
  it("returns defaults when empty", () => {
    expect(parseArgs([])).toEqual({ workflowPath: null, port: null, help: false });
  });

  it("accepts positional workflow path", () => {
    expect(parseArgs(["./WORKFLOW.md"]).workflowPath).toBe("./WORKFLOW.md");
  });

  it("accepts --port with value", () => {
    expect(parseArgs(["--port", "4242"]).port).toBe(4242);
    expect(parseArgs(["--port=4243"]).port).toBe(4243);
  });

  it("rejects unknown flag", () => {
    expect(() => parseArgs(["--nope"])).toThrow();
  });

  it("rejects invalid port", () => {
    expect(() => parseArgs(["--port", "abc"])).toThrow();
  });

  it("rejects multiple workflow paths", () => {
    expect(() => parseArgs(["a.md", "b.md"])).toThrow();
  });

  it("supports -h/--help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });
});
