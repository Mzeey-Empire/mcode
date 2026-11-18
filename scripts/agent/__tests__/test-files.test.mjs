/** Tests for the named test-file runner. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { planTestRuns } from "../test-files.mjs";

const ROOT = NodePath.resolve("/repo");
const WORKSPACES = [
  { dir: "apps/web", name: "@mcode/web", scripts: { test: "vitest run" }, dependsOn: [] },
  { dir: "apps/server", name: "@mcode/server", scripts: { test: "vitest run" }, dependsOn: [] },
  { dir: "packages/no-tests", name: "@mcode/no-tests", scripts: {}, dependsOn: [] },
];
const everyPathExists = () => true;
const SCRIPT = NodePath.resolve(import.meta.dirname, "..", "test-files.mjs");
const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..", "..", "..");

function plan(paths, exists = everyPathExists) {
  return planTestRuns({ paths, root: ROOT, workspaces: WORKSPACES, exists });
}

NodeTest.test("groups paths by the workspace that owns them, keeping workspace-relative paths", () => {
  const runs = plan(["apps/web/src/a.test.ts", "apps/server/src/b.test.ts", "apps/web/src/c"]);

  NodeAssertStrict.deepEqual(
    runs.map((run) => [run.cwd, run.files]),
    [["apps/web", ["src/a.test.ts", "src/c"]], ["apps/server", ["src/b.test.ts"]]],
  );
  NodeAssertStrict.deepEqual(runs[0].args, ["run", "test", "--", "--reporter=dot", "--silent=passed-only", "src/a.test.ts", "src/c"]);
});

NodeTest.test("refuses an empty list, a missing path, and a path that would select a whole suite", () => {
  NodeAssertStrict.throws(() => plan([]), /No test files given/);
  NodeAssertStrict.throws(() => plan(["apps/web/src/a.test.ts", "apps/web/src/gone.test.ts"], (path) => !path.endsWith("gone.test.ts")), /No such file or folder: apps\/web\/src\/gone.test.ts/);
  NodeAssertStrict.throws(() => plan(["apps/web"]), /not inside a workspace/);
  NodeAssertStrict.throws(() => plan(["packages/no-tests/src/a.test.ts"]), /not inside a workspace with a test script/);
});

NodeTest.test("the command exits 1 without starting Vitest when a failed pipeline leaves the list empty or partial", () => {
  for (const args of [[], ["apps/web/src/__tests__/does-not-exist.test.ts"]]) {
    const result = NodeChildProcess.spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8" });

    NodeAssertStrict.equal(result.status, 1);
    NodeAssertStrict.doesNotMatch(result.stdout + result.stderr, /RUN\s+v\d|Test Files/);
  }
});
