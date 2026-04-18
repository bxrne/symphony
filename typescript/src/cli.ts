export type CliArgs = {
  workflowPath: string | null;
  port: number | null;
  help: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { workflowPath: null, port: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--port") {
      const next = argv[i + 1];
      if (!next) throw new Error("--port requires a value");
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid --port value: ${next}`);
      args.port = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      const raw = arg.slice("--port=".length);
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid --port value: ${raw}`);
      args.port = parsed;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    }
    if (args.workflowPath !== null) {
      throw new Error(`multiple workflow paths provided: ${args.workflowPath}, ${arg}`);
    }
    args.workflowPath = arg;
  }
  return args;
}

export function usage(): string {
  return [
    "Usage: symphony [path-to-WORKFLOW.md] [--port <port>]",
    "",
    "Arguments:",
    "  path-to-WORKFLOW.md   Workflow file (defaults to ./WORKFLOW.md)",
    "",
    "Options:",
    "  --port <port>         Start optional HTTP dashboard/API on <port>",
    "  -h, --help            Show this help and exit",
  ].join("\n");
}
