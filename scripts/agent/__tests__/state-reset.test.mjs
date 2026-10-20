/** Tests which directories `state:reset` is willing to delete. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { resolveResetTarget } from "../../state-reset.mjs";

const repoRoot = NodePath.join(NodeOS.tmpdir(), "mcode-state-reset-repo");
const devDir = NodePath.join(repoRoot, ".dev");

NodeTest.test("state:reset targets <repo>/.dev when no data dir is set", () => {
  NodeAssertStrict.default.equal(resolveResetTarget(repoRoot, {}), devDir);
});

NodeTest.test("state:reset accepts MCODE_DATA_DIR only when it is <repo>/.dev", () => {
  NodeAssertStrict.default.equal(resolveResetTarget(repoRoot, { MCODE_DATA_DIR: devDir }), devDir);
});

NodeTest.test("state:reset refuses a data dir outside <repo>/.dev", () => {
  const refused = [
    NodePath.join(NodeOS.homedir(), ".mcode"),
    NodePath.join(repoRoot, ".dev", "db"),
    NodePath.join(repoRoot, ".dev-other"),
    repoRoot,
  ];
  for (const dataDir of refused) {
    NodeAssertStrict.default.throws(
      () => resolveResetTarget(repoRoot, { MCODE_DATA_DIR: dataDir }),
      /Refusing to reset/,
      dataDir,
    );
  }
});
