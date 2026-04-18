# Symphony (TypeScript)

A Node.js/TypeScript reference implementation of the [Symphony service specification](../SPEC.md).

Symphony is a long-running automation service that continuously reads work from an issue tracker
(Linear), creates an isolated per-issue workspace, and runs a coding-agent session for each issue
inside that workspace.

## Status

Implements all mandatory behaviors from `SPEC.md` Section 18.1 (Core Conformance) plus the
recommended extensions from Section 18.2:

- Optional HTTP server with `/` dashboard and `/api/v1/*` JSON API (Section 13.7)
- `linear_graphql` client-side tool extension (Section 10.5)
- SSH worker extension (Appendix A) via `worker.ssh_hosts`

## Requirements

- Node.js 20+ (tested on Node 22)
- pnpm 9+
- `bash` available on `PATH` (used for workspace hooks and launching the coding agent)
- A Codex app-server compatible binary reachable via the configured `codex.command`
- A Linear API key with access to the configured project

## Install

```bash
cd typescript
pnpm install
pnpm build
```

## Run

```bash
export LINEAR_API_KEY=lin_api_xxx
node dist/index.js WORKFLOW.md --port 4242
```

Or run against sources with `tsx`:

```bash
pnpm dev -- WORKFLOW.md --port 4242
```

CLI:

```
Usage: symphony [path-to-WORKFLOW.md] [--port <port>]
```

- Defaults to `./WORKFLOW.md` when no path is provided.
- `--port` overrides `server.port` in the workflow front matter.
- Exits with a non-zero status on startup validation or fatal failures.

## Layout

```
typescript/
├── src/
│   ├── index.ts            # CLI entry
│   ├── cli.ts              # argv parsing
│   ├── logger.ts           # Structured key=value logger
│   ├── types.ts            # Core domain types
│   ├── workflow/           # Loader, config layer, template engine, watcher
│   ├── workspace/          # Safety invariants, hook execution, workspace manager
│   ├── tracker/            # Linear GraphQL client + normalization
│   ├── codex/              # app-server stdio client, tools (linear_graphql)
│   ├── runner/             # Agent runner: workspace + prompt + session loop
│   ├── orchestrator/       # Dispatch, retry, reconciliation, state
│   └── http/               # Dashboard + /api/v1 endpoints
└── tests/                  # Vitest unit tests
```

## Tests

```bash
pnpm test
pnpm typecheck
```

## Observability

- Structured logs on stdout/stderr with `key=value` fields including
  `issue_id`, `issue_identifier`, and `session_id`.
- JSON API at `/api/v1/state`, `/api/v1/<issue_identifier>`, and `POST /api/v1/refresh`.
- Human dashboard at `/` (auto-refreshes every 5 seconds).

## Safety posture

- The workspace path is always validated to stay under the configured `workspace.root`.
- Workspace directory names are sanitized to `[A-Za-z0-9._-]`.
- Coding-agent launch command always runs with the per-issue workspace as `cwd`.
- Agent approvals are auto-approved by default (`codex.approval_policy: never`) matching the
  Elixir reference posture. Tighten this in `WORKFLOW.md` for stricter environments.
- User-input-required events terminate the current run attempt (retry scheduled).
- Unsupported dynamic tool calls return a structured failure but keep the session alive.

## Hot-reload

The workflow file is watched with `chokidar`. Changes to `WORKFLOW.md` apply to future dispatch,
retry scheduling, reconciliation, hook execution, and agent launches without a restart. The HTTP
server port is the only setting that requires a restart.

## Extensions

- **HTTP server**: Set `server.port` in the workflow front matter or pass `--port`. CLI overrides
  config. `0` binds an ephemeral port.
- **SSH worker**: Set `worker.ssh_hosts` to a list of SSH destinations. Each run is launched with
  `ssh <host> bash -lc '...'`. Optional `worker.max_concurrent_agents_per_host` caps per host.
- **linear_graphql tool**: Advertised to the Codex session automatically when `tracker.kind=linear`.
  The agent can issue raw Linear GraphQL operations reusing Symphony's tracker auth.

## License

Apache-2.0 (inherits the root repository license).
