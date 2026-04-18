import type { Issue, ServiceConfig } from "../types.js";
import { TrackerError, type TrackerClient } from "./types.js";
import { normalizeLinearIssue } from "./normalize.js";
import { rootLogger } from "../logger.js";

const NETWORK_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 50;

export class LinearTracker implements TrackerClient {
  private log = rootLogger.child({ component: "tracker_linear" });
  constructor(private readonly getConfig: () => ServiceConfig) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    return await this.fetchIssuesByStates(this.getConfig().tracker.active_states);
  }

  async describeProject(): Promise<{
    viewer: { name: string | null; email: string | null } | null;
    matching_projects: Array<{ id: string; name: string; slug_id: string; team_keys: string[]; state_names: string[] }>;
    nearby_projects: Array<{ id: string; name: string; slug_id: string }>;
    matching_teams: Array<{ id: string; name: string; key: string; state_names: string[] }>;
    nearby_teams: Array<{ id: string; name: string; key: string }>;
  }> {
    const cfg = this.getConfig();
    const slug = cfg.tracker.project_slug ?? "";
    const wantTeamKey = (cfg.tracker.team_key ?? "").toUpperCase();
    const data = await this.request<{
      viewer: { name: string | null; email: string | null } | null;
      projects: {
        nodes: Array<{
          id: string;
          name: string;
          slugId: string;
          teams: { nodes: Array<{ key: string; states: { nodes: Array<{ name: string }> } }> };
        }>;
      };
      teams: {
        nodes: Array<{
          id: string;
          name: string;
          key: string;
          states: { nodes: Array<{ name: string }> };
        }>;
      };
    }>(DESCRIBE_QUERY, { first: 50 });

    const matchingProjects = data.projects.nodes.filter((p) => p.slugId === slug);
    const projectStateNames = new Set<string>();
    const projectTeamKeys = new Set<string>();
    for (const project of matchingProjects) {
      for (const team of project.teams.nodes) {
        projectTeamKeys.add(team.key);
        for (const s of team.states.nodes) projectStateNames.add(s.name);
      }
    }

    const matchingTeams = wantTeamKey
      ? data.teams.nodes.filter((t) => t.key.toUpperCase() === wantTeamKey)
      : [];

    return {
      viewer: data.viewer,
      matching_projects: matchingProjects.map((p) => ({
        id: p.id,
        name: p.name,
        slug_id: p.slugId,
        team_keys: Array.from(projectTeamKeys),
        state_names: Array.from(projectStateNames),
      })),
      nearby_projects: data.projects.nodes
        .filter((p) => p.slugId !== slug)
        .slice(0, 20)
        .map((p) => ({ id: p.id, name: p.name, slug_id: p.slugId })),
      matching_teams: matchingTeams.map((t) => ({
        id: t.id,
        name: t.name,
        key: t.key,
        state_names: t.states.nodes.map((s) => s.name),
      })),
      nearby_teams: data.teams.nodes
        .filter((t) => t.key.toUpperCase() !== wantTeamKey)
        .slice(0, 20)
        .map((t) => ({ id: t.id, name: t.name, key: t.key })),
    };
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    if (states.length === 0) return [];
    const cfg = this.getConfig();
    const projectSlug = cfg.tracker.project_slug;
    const teamKey = cfg.tracker.team_key;
    if (!projectSlug && !teamKey) {
      throw new TrackerError(
        "missing_tracker_scope",
        "tracker.project_slug or tracker.team_key is required",
      );
    }
    const query = buildCandidateQuery({ hasProject: !!projectSlug, hasTeam: !!teamKey });
    const all: Issue[] = [];
    const rawTotal: number[] = [];
    let endCursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const variables: Record<string, unknown> = {
        stateNames: states,
        first: PAGE_SIZE,
        after: endCursor,
      };
      if (projectSlug) variables["projectSlug"] = projectSlug;
      if (teamKey) variables["teamKey"] = teamKey;
      const data = await this.request<{
        issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Record<string, unknown>[] };
      }>(query, variables);
      rawTotal.push(data.issues.nodes.length);
      for (const node of data.issues.nodes) {
        const issue = normalizeLinearIssue(node);
        if (issue) all.push(issue);
      }
      if (!data.issues.pageInfo.hasNextPage) break;
      if (!data.issues.pageInfo.endCursor) {
        throw new TrackerError(
          "linear_missing_end_cursor",
          "pagination returned hasNextPage=true without endCursor",
        );
      }
      endCursor = data.issues.pageInfo.endCursor;
    }
    const rawCount = rawTotal.reduce((a, b) => a + b, 0);
    this.log.debug("linear_fetch", {
      project_slug: projectSlug,
      team_key: teamKey,
      states: states.join(","),
      pages: rawTotal.length,
      raw_nodes: rawCount,
      normalized: all.length,
    });
    if (rawCount === 0) {
      this.log.info("linear_zero_results", {
        project_slug: projectSlug,
        team_key: teamKey,
        states: states.join(","),
        hint: "verify scope matches Linear (team_key is the short prefix like BXR; project_slug is the trailing segment of a project URL) and that active_states match the exact state names Linear shows",
      });
    }
    return all;
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];
    const data = await this.request<{ issues: { nodes: Record<string, unknown>[] } }>(
      REFRESH_QUERY,
      { ids },
    );
    const out: Issue[] = [];
    for (const node of data.issues.nodes) {
      const issue = normalizeLinearIssue(node);
      if (issue) out.push(issue);
    }
    return out;
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const cfg = this.getConfig();
    const token = cfg.tracker.api_key;
    if (!token) throw new TrackerError("missing_tracker_api_key", "tracker.api_key missing");
    const endpoint = cfg.tracker.endpoint;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
    timer.unref?.();

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new TrackerError(
        "linear_api_request",
        `linear transport failure: ${describe(error)}`,
        error,
      );
    }
    clearTimeout(timer);

    if (!response.ok) {
      const body = await safeText(response);
      throw new TrackerError(
        "linear_api_status",
        `linear http ${response.status}: ${body.slice(0, 500)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new TrackerError(
        "linear_unknown_payload",
        `invalid json from linear: ${describe(error)}`,
        error,
      );
    }

    if (!parsed || typeof parsed !== "object") {
      throw new TrackerError("linear_unknown_payload", "non-object response from linear");
    }

    const record = parsed as { data?: T; errors?: unknown };
    if (record.errors) {
      throw new TrackerError(
        "linear_graphql_errors",
        `linear graphql errors: ${JSON.stringify(record.errors).slice(0, 500)}`,
      );
    }
    if (!record.data) {
      throw new TrackerError("linear_unknown_payload", "linear response missing data field");
    }
    return record.data;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  labels { nodes { name } }
  inverseRelations {
    nodes {
      type
      issue {
        id
        identifier
        state { name }
      }
    }
  }
`;

function buildCandidateQuery(opts: { hasProject: boolean; hasTeam: boolean }): string {
  const params: string[] = [
    "$stateNames: [String!]!",
    "$first: Int!",
    "$after: String",
  ];
  const filters: string[] = ["state: { name: { in: $stateNames } }"];
  if (opts.hasProject) {
    params.unshift("$projectSlug: String!");
    filters.push("project: { slugId: { eq: $projectSlug } }");
  }
  if (opts.hasTeam) {
    params.push("$teamKey: String!");
    filters.push("team: { key: { eq: $teamKey } }");
  }
  return `
    query SymphonyCandidates(${params.join(", ")}) {
      issues(
        first: $first,
        after: $after,
        filter: { ${filters.join(", ")} }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {${ISSUE_FIELDS}}
      }
    }
  `;
}

const REFRESH_QUERY = `
  query SymphonyRefresh($ids: [ID!]!) {
    issues(filter: { id: { in: $ids } }, first: 250) {
      nodes {${ISSUE_FIELDS}}
    }
  }
`;

const DESCRIBE_QUERY = `
  query SymphonyDescribe($first: Int!) {
    viewer { name email }
    projects(first: $first) {
      nodes {
        id
        name
        slugId
        teams {
          nodes {
            key
            states { nodes { name } }
          }
        }
      }
    }
    teams(first: $first) {
      nodes {
        id
        name
        key
        states { nodes { name } }
      }
    }
  }
`;
