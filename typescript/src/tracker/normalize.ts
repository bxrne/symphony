import type { BlockerRef, Issue } from "../types.js";

type AnyRecord = Record<string, unknown>;

export function normalizeLinearIssue(raw: AnyRecord): Issue | null {
  const id = typeof raw.id === "string" ? raw.id : null;
  const identifier = typeof raw.identifier === "string" ? raw.identifier : null;
  const title = typeof raw.title === "string" ? raw.title : null;
  const stateObj = raw.state as AnyRecord | null | undefined;
  const state = stateObj && typeof stateObj.name === "string" ? stateObj.name : null;

  if (!id || !identifier || !title || !state) return null;

  const description = typeof raw.description === "string" ? raw.description : null;
  const priority =
    typeof raw.priority === "number" && Number.isFinite(raw.priority)
      ? Math.trunc(raw.priority)
      : null;
  const branchName = typeof raw.branchName === "string" ? raw.branchName : null;
  const url = typeof raw.url === "string" ? raw.url : null;

  const labels: string[] = [];
  const labelsConnection = raw.labels as AnyRecord | null | undefined;
  const labelNodes = labelsConnection?.nodes;
  if (Array.isArray(labelNodes)) {
    for (const node of labelNodes) {
      if (node && typeof (node as AnyRecord).name === "string") {
        labels.push(((node as AnyRecord).name as string).toLowerCase());
      }
    }
  }

  const blockedBy = normalizeBlockedBy(raw);

  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : null;
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : null;

  return {
    id,
    identifier,
    title,
    description,
    priority,
    state,
    branch_name: branchName,
    url,
    labels,
    blocked_by: blockedBy,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function normalizeBlockedBy(raw: AnyRecord): BlockerRef[] {
  const blockers: BlockerRef[] = [];
  const inverse = raw.inverseRelations as AnyRecord | null | undefined;
  const nodes = inverse?.nodes;
  if (!Array.isArray(nodes)) return blockers;
  for (const node of nodes) {
    const rel = node as AnyRecord;
    if (typeof rel.type !== "string" || rel.type.toLowerCase() !== "blocks") continue;
    const blockerIssue = rel.issue as AnyRecord | null | undefined;
    if (!blockerIssue) continue;
    const blockerState = blockerIssue.state as AnyRecord | null | undefined;
    blockers.push({
      id: typeof blockerIssue.id === "string" ? blockerIssue.id : null,
      identifier: typeof blockerIssue.identifier === "string" ? blockerIssue.identifier : null,
      state: blockerState && typeof blockerState.name === "string" ? blockerState.name : null,
    });
  }
  return blockers;
}
