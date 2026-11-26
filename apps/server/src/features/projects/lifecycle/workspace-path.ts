import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Whether an absolute path is the root itself or one of its descendants. */
export function isWithinWorkspaceRoot(root: string, path: string): boolean {
  const relative = NodePath.relative(root, path);
  return relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative);
}

/** Resolve the managed No project root, refusing a link that redirects it. */
export async function resolveNoProjectRoot(root: string): Promise<string> {
  const mcodeDir = await NodeFSPromises.realpath(NodePath.dirname(root));
  const resolved = await NodeFSPromises.realpath(root);
  if (resolved !== NodePath.join(mcodeDir, "no-project")) {
    throw new Error("No project root is redirected outside its managed location");
  }
  return resolved;
}

/**
 * Whether a canonical folder path is too broad to register as a project: the home folder or a
 * filesystem root. Browsing and registration share this rule so the Add chip and the server agree.
 */
export async function isTooBroadFolder(canonicalPath: string): Promise<boolean> {
  if (NodePath.dirname(canonicalPath) === canonicalPath) return true;
  return canonicalPath === (await NodeFSPromises.realpath(NodeOS.homedir()));
}
