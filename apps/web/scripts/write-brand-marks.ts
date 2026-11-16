import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { staticMarkFiles } from "../src/components/brand/mark/mark-svg";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");

for (const [path, text] of Object.entries(staticMarkFiles())) {
  NodeFS.writeFileSync(NodePath.join(repoRoot, path), text);
  console.log(`wrote ${path}`);
}
