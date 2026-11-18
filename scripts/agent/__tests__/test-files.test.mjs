/** Tests for the named test-file runner. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { planTestRuns } from "../test-files.mjs";

const ROOT = NodePath.resolve("/repo");
const WORKSPACES = [
  { dir: "apps/web", name: "@mcode/web", scripts: { test: "vitest run" }, dependsOn: [] },
  { dir: "apps/server", name: "@mcode/server", scripts: { test: "bun --bun ./node_modules/vitest/vitest.mjs run" }, dependsOn: [] },
  { dir: "packages/no-tests", name: "@mcode/no-tests", scripts: {}, dependsOn: [] },
  {
    dir: "packages/oxlint-plugin",
    name: "@mcode/oxlint-plugin",
    scripts: { test: "bun run build && node --input-type=module --eval \"const { startVitest } = await import('vitest/node'); await startVitest('test', [], { run: true })\"" },
    dependsOn: [],
  },
];
const everyPathExists = () => true;
const SCRIPT = NodePath.resolve(import.meta.dirname, "..", "test-files.mjs");
const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..", "..", "..");

function plan(paths, exists = everyPathExists) {
  return planTestRuns({ paths, root: ROOT, workspaces: WORKSPACES, exists });
}

function runScript(cwd, args) {
  const result = NodeChildProcess.spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

/**
 * A two-workspace repository whose test scripts record the arguments they receive. The recorder is named so the
 * script reads as a Vitest CLI call, and it fails when asked for a file named `failing`.
 */
function makeFixtureRepo() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "test-files-"));
  const recorder = NodePath.join(root, "fake-vitest.mjs");
  NodeFS.writeFileSync(
    recorder,
    [
      "import * as NodeFS from 'node:fs';",
      "const args = process.argv.slice(3);",
      "NodeFS.appendFileSync(process.env.RECORD_FILE, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');",
      "process.exit(args.some((arg) => arg.includes('failing')) ? 1 : 0);",
    ].join("\n"),
  );
  NodeFS.writeFileSync(NodePath.join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
  for (const name of ["web", "server"]) {
    const dir = NodePath.join(root, "apps", name);
    NodeFS.mkdirSync(NodePath.join(dir, "src"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "package.json"), JSON.stringify({ name, scripts: { test: "node ../../fake-vitest.mjs run" } }));
    for (const file of ["a.test.ts", "failing.test.ts"]) NodeFS.writeFileSync(NodePath.join(dir, "src", file), "");
  }
  return root;
}

function recordedRuns(recordFile) {
  if (!NodeFS.existsSync(recordFile)) return [];
  return NodeFS.readFileSync(recordFile, "utf8").trim().split("\n").map((line) => {
    const { cwd, args } = JSON.parse(line);
    return [NodePath.basename(cwd), args];
  });
}

NodeTest.test("groups paths by the workspace that owns them, keeping workspace-relative paths", () => {
  const runs = plan(["apps/web/src/a.test.ts", "apps/server/src/b.test.ts", "apps/web/src/c"]);

  NodeAssertStrict.deepEqual(
    runs.map((run) => [run.cwd, run.files]),
    [["apps/web", ["src/a.test.ts", "src/c"]], ["apps/server", ["src/b.test.ts"]]],
  );
});

NodeTest.test("refuses an empty list, a missing path, and a path that would select a whole suite", () => {
  NodeAssertStrict.throws(() => plan([]), /No test files given/);
  NodeAssertStrict.throws(() => plan([""]), /No test files given/);
  NodeAssertStrict.throws(() => plan(["apps/web/src/a.test.ts", "apps/web/src/gone.test.ts"], (path) => !path.endsWith("gone.test.ts")), /No such file or folder: apps\/web\/src\/gone.test.ts/);
  NodeAssertStrict.throws(() => plan(["apps/web"]), /not inside a workspace/);
  NodeAssertStrict.throws(() => plan(["packages/no-tests/src/a.test.ts"]), /not inside a workspace with a test script/);
  NodeAssertStrict.throws(() => plan(["packages/oxlint-plugin/src/a.test.ts"]), /packages\/oxlint-plugin's test script cannot run named files/);
});

NodeTest.test("the command exits 1 without starting Vitest when a failed pipeline leaves the list empty or partial", () => {
  for (const args of [[], [""], ["apps/web/src/__tests__/does-not-exist.test.ts"]]) {
    const { status, output } = runScript(REPO_ROOT, args);

    NodeAssertStrict.equal(status, 1);
    NodeAssertStrict.doesNotMatch(output, /RUN\s+v\d|Test Files/);
  }
});

NodeTest.test("runs each workspace's named files with short output and passes a test failure through", (context) => {
  const root = makeFixtureRepo();
  context.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const recordFile = NodePath.join(root, "record.jsonl");
  process.env.RECORD_FILE = recordFile;
  context.after(() => { delete process.env.RECORD_FILE; });

  const passing = runScript(root, ["apps/web/src/a.test.ts", "apps/server/src/a.test.ts"]);
  NodeAssertStrict.equal(passing.status, 0);
  NodeAssertStrict.match(passing.output, /Before you commit, run bun run check:changed/);
  NodeAssertStrict.deepEqual(recordedRuns(recordFile), [
    ["web", ["--reporter=dot", "--silent=passed-only", "src/a.test.ts"]],
    ["server", ["--reporter=dot", "--silent=passed-only", "src/a.test.ts"]],
  ]);

  NodeFS.rmSync(recordFile);
  const failing = runScript(root, ["apps/web/src/failing.test.ts", "apps/server/src/a.test.ts"]);
  NodeAssertStrict.equal(failing.status, 1);
  NodeAssertStrict.equal(recordedRuns(recordFile).length, 2, "a failure in one workspace still runs the next");
});
