import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { isWithinWorkspaceRoot } from "./workspace-path.js";

const held = new Map<string, string | null>();

/** Serializes moves, their recovery, and workspace deletion in this process. */
export function acquireWorkspaceMoveGate(workspaceId: string, sourcePath: string | null): (() => void) | null {
  if (held.has(workspaceId)) return null;
  held.set(workspaceId, sourcePath);
  return () => { held.delete(workspaceId); };
}

/** Fence by workspace before the intent row reaches the writer. */
export function isWorkspaceMoving(workspaceId: string): boolean {
  return typeof held.get(workspaceId) === "string";
}

function realPathOrMissing(path: string): string {
  try {
    return NodeFS.realpathSync.native(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return NodePath.resolve(path);
    throw error;
  }
}

/** Compare terminal working folders using their real locations when they still exist. */
export function isInsideMoveSource(source: string, cwd: string): boolean {
  return isWithinWorkspaceRoot(realPathOrMissing(source), realPathOrMissing(cwd));
}

export function assertTerminalOutsideMove(cwd: string, recordedSources: readonly string[]): void {
  for (const source of [...held.values(), ...recordedSources]) {
    if (source !== null && isInsideMoveSource(source, cwd)) {
      throw new Error("The terminal's working folder is moving to a project");
    }
  }
}
