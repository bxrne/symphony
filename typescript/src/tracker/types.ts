import type { Issue } from "../types.js";

export interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(states: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>;
}

export class TrackerError extends Error {
  constructor(readonly code: string, message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "TrackerError";
  }
}
