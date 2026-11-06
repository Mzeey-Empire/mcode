import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Create a Turn working directory and register it with the fixture's cleanup roots. */
export function createTurnWorkingDirForTest(roots: string[]): string {
  // The execution worker runs real git in the Turn's working directory, so it must not be the developer's checkout.
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-agent-turn-"));
  roots.push(root);
  return root;
}
