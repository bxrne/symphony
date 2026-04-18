---
tracker:
  kind: linear
  # Pick ONE (or both) of these:
  #   team_key   - short team prefix (e.g. BXR, ENG) seen in identifiers like BXR-123
  #   project_slug - trailing segment of a Linear project URL (e.g. symphony-de8602f4f669)
  project_slug: "symphony-de8602f4f669"
  # team_key: BXR
  api_key: $LINEAR_API_KEY
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done
polling:
  interval_ms: 5000
workspace:
  root: ~/Development/symphony-workspaces
hooks:
  after_create: |
    git clone --depth 1 https://github.com/bxrne/symphony .
  timeout_ms: 60000
agent:
  max_concurrent_agents: 4
  max_turns: 20
  max_retry_backoff_ms: 300000
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
server:
  port: 4242
worker:
  ssh_hosts: []
---

You are working on a Linear ticket `{{ issue.identifier }}`.

{% if attempt %}
Continuation context:

- This is retry/continuation attempt #{{ attempt }} because the ticket is still active.
- Resume from the current workspace state instead of restarting from scratch.
{% endif %}

Issue details:

- Title: {{ issue.title }}
- State: {{ issue.state }}
- URL: {{ issue.url }}
- Labels: {% for label in issue.labels %}[{{ label }}]{% endfor %}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
_No description provided._
{% endif %}

Stay inside the provided workspace directory. Keep the Linear workpad comment current. Move the
ticket through states as work progresses.
