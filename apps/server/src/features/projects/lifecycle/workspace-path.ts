import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Whether a canonical folder path is too broad to register as a project: the home folder or a
 * filesystem root. Browsing and registration share this rule so the Add chip and the server agree.
 */
export async function isTooBroadFolder(canonicalPath: string): Promise<boolean> {
  if (NodePath.dirname(canonicalPath) === canonicalPath) return true;
  return canonicalPath === (await NodeFSPromises.realpath(NodeOS.homedir()));
}
