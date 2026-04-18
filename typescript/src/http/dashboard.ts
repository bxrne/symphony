import type { Orchestrator } from "../orchestrator/orchestrator.js";

type Snapshot = ReturnType<Orchestrator["getSnapshotForApi"]>;

export function renderDashboard(snapshot: Snapshot): string {
  const rows = snapshot.running
    .map(
      (r) => `
      <tr>
        <td>${escape(r.identifier)}</td>
        <td>${escape(r.issue.state)}</td>
        <td>${escape(r.session_id ?? "")}</td>
        <td>${r.turn_count}</td>
        <td>${escape(r.last_codex_event ?? "")}</td>
        <td>${r.codex_total_tokens}</td>
        <td>${escape(r.host ?? "local")}</td>
      </tr>`,
    )
    .join("\n");

  const retryRows = snapshot.retrying
    .map(
      (r) => `
      <tr>
        <td>${escape(r.identifier)}</td>
        <td>${r.attempt}</td>
        <td>${new Date(r.due_at_ms).toISOString()}</td>
        <td>${escape(r.error ?? "")}</td>
      </tr>`,
    )
    .join("\n");

  const totals = snapshot.state.codex_totals;
  const now = Date.now();
  const liveSeconds =
    totals.seconds_running +
    snapshot.running.reduce((sum, r) => sum + Math.max(0, (now - r.started_at_ms) / 1000), 0);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Symphony</title>
  <meta http-equiv="refresh" content="5" />
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 24px; color: #1a1a1a; }
    h1 { margin-bottom: 4px; }
    .subtle { color: #555; font-size: 12px; margin-bottom: 16px; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #eee; font-size: 13px; }
    th { background: #f7f7f7; }
    .totals { display: flex; gap: 24px; margin-bottom: 24px; }
    .totals div { background: #f4f4f5; padding: 8px 12px; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>Symphony</h1>
  <div class="subtle">${new Date().toISOString()} &middot; running=${snapshot.running.length} retrying=${snapshot.retrying.length}</div>

  <div class="totals">
    <div><strong>input</strong>: ${totals.input_tokens}</div>
    <div><strong>output</strong>: ${totals.output_tokens}</div>
    <div><strong>total</strong>: ${totals.total_tokens}</div>
    <div><strong>runtime (s)</strong>: ${liveSeconds.toFixed(1)}</div>
  </div>

  <h2>Running</h2>
  <table>
    <thead><tr><th>issue</th><th>state</th><th>session</th><th>turn</th><th>last event</th><th>tokens</th><th>host</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7"><em>no active sessions</em></td></tr>'}</tbody>
  </table>

  <h2>Retry queue</h2>
  <table>
    <thead><tr><th>issue</th><th>attempt</th><th>due</th><th>error</th></tr></thead>
    <tbody>${retryRows || '<tr><td colspan="4"><em>empty</em></td></tr>'}</tbody>
  </table>

  <p class="subtle">JSON API: <code>/api/v1/state</code> &middot; <code>/api/v1/&lt;identifier&gt;</code> &middot; <code>POST /api/v1/refresh</code></p>
</body>
</html>`;
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
