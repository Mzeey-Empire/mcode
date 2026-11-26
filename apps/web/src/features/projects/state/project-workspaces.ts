import type { Workspace } from "@mcode/contracts/models/workspace";

/**
 * Whether a workspace row is a project the user registered. A No project thread lives in a hidden
 * `no_project` row (ADR 0035) that the store keeps for lookups by id but no project list may show.
 */
export function isProjectWorkspace(workspace: Pick<Workspace, "kind">): boolean {
  return workspace.kind === "project";
}

/** The workspace rows that are projects, in the store's order. Use this wherever workspaces are listed to the user. */
export function projectWorkspaces(workspaces: readonly Workspace[]): Workspace[] {
  return workspaces.filter(isProjectWorkspace);
}

/**
 * Moves project `id` to `projectIndex` among the project rows only. Hidden rows keep their array positions, because
 * the server counts project rows alone when it reorders. Returns `workspaces` unchanged for an unknown id.
 */
export function moveProjectRow(workspaces: readonly Workspace[], id: string, projectIndex: number): Workspace[] {
  const projects = projectWorkspaces(workspaces);
  const from = projects.findIndex((workspace) => workspace.id === id);
  if (from < 0) return [...workspaces];
  const [moved] = projects.splice(from, 1);
  projects.splice(projectIndex, 0, moved!);
  let next = 0;
  return workspaces.map((workspace) => (isProjectWorkspace(workspace) ? projects[next++]! : workspace));
}

/** Accepts null and returns false for an id the store has not loaded. */
export function isNoProjectWorkspaceId(workspaces: readonly Workspace[], workspaceId: string | null): boolean {
  if (!workspaceId) return false;
  return workspaces.some((workspace) => workspace.id === workspaceId && workspace.kind === "no_project");
}
