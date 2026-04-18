import path from "node:path";

export function sanitizeWorkspaceKey(identifier: string): string {
  if (!identifier) throw new Error("cannot sanitize empty identifier");
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function workspacePathFor(root: string, identifier: string): string {
  const key = sanitizeWorkspaceKey(identifier);
  return path.resolve(root, key);
}

export function assertInsideRoot(root: string, workspacePath: string): void {
  const absRoot = path.resolve(root);
  const absPath = path.resolve(workspacePath);
  const rel = path.relative(absRoot, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
    if (absPath !== absRoot) {
      throw new Error(`workspace path ${absPath} is outside root ${absRoot}`);
    }
  }
  if (absPath === absRoot) {
    throw new Error("workspace path must be a subdirectory of workspace root");
  }
}
