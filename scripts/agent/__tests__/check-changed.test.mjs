/** Tests for the changed-scope check runner. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { agentTestFiles, gitChangedFiles, parseCheckArgs, planChecks, summarize } from "../check-changed.mjs";

const WORKSPACES = [
  { dir: "packages/shared", name: "@mcode/shared", scripts: { test: "vitest run", typecheck: "tsc" }, dependsOn: [] },
  { dir: "packages/contracts", name: "@mcode/contracts", scripts: { test: "vitest run", typecheck: "tsc" }, dependsOn: ["@mcode/shared"] },
  { dir: "apps/web", name: "@mcode/web", scripts: { test: "vitest run", typecheck: "tsc" }, dependsOn: ["@mcode/contracts", "react"] },
  { dir: "apps/server", name: "@mcode/server", scripts: { test: "vitest run", typecheck: "tsc" }, dependsOn: [] },
];
const everyFileExists = () => true;

function labels(plan) {
  return plan.jobs.map((job) => job.label);
}

NodeTest.test("a shared package change checks every workspace that depends on it, and no other", () => {
  const plan = planChecks({ files: ["packages/shared/src/id.ts"], workspaces: WORKSPACES, since: null, exists: everyFileExists });

  NodeAssertStrict.deepEqual(labels(plan), [
    "test packages/shared",
    "test packages/contracts",
    "test apps/web",
    "typecheck packages/shared",
    "typecheck packages/contracts",
    "typecheck apps/web",
    "lint 1 file",
  ]);
  NodeAssertStrict.deepEqual(plan.notes, []);
});

NodeTest.test("a deleted file still selects its workspace but never reaches the linter, and docs are not linted", () => {
  const plan = planChecks({
    files: ["apps/server/src/gone.ts", "apps/server/README.md"],
    workspaces: WORKSPACES,
    since: null,
    exists: (file) => file !== "apps/server/src/gone.ts",
  });

  NodeAssertStrict.deepEqual(labels(plan), ["test apps/server", "typecheck apps/server"]);
});

NodeTest.test("a shared config change says the scoped run cannot vouch for it", () => {
  const plan = planChecks({ files: ["tsconfig.base.json"], workspaces: WORKSPACES, since: null, exists: everyFileExists });

  NodeAssertStrict.deepEqual(plan.jobs, []);
  NodeAssertStrict.match(plan.notes[0], /tsconfig\.base\.json/);
});

NodeTest.test("--since hands its ref to Vitest, and other arguments are refused", () => {
  NodeAssertStrict.deepEqual(parseCheckArgs(["--since", "origin/main"]), { since: "origin/main" });
  NodeAssertStrict.throws(() => parseCheckArgs(["--since"]));
  NodeAssertStrict.throws(() => parseCheckArgs(["apps/web"]));

  const plan = planChecks({ files: ["apps/server/src/a.ts"], workspaces: WORKSPACES, since: "origin/main", exists: everyFileExists });
  NodeAssertStrict.ok(plan.jobs[0].args.includes("--changed=origin/main"));
});

NodeTest.test("an agent script change runs its own test file, and a changed test runs itself", () => {
  const present = new Set(["scripts/agent/__tests__/agent-up.test.mjs", "scripts/agent/__tests__/fixture-repo.test.mjs"]);
  const files = ["scripts/agent/agent-up.mjs", "scripts/agent/__tests__/fixture-repo.test.mjs", "scripts/agent/no-test.mjs"];

  NodeAssertStrict.deepEqual(agentTestFiles(files, (file) => present.has(file)), [
    "scripts/agent/__tests__/agent-up.test.mjs",
    "scripts/agent/__tests__/fixture-repo.test.mjs",
  ]);
});

NodeTest.test("a test summary line says when no test imports the change", () => {
  const job = { label: "test apps/web" };

  NodeAssertStrict.equal(
    summarize({ job, code: 0, output: " Test Files  2 passed (2)\n      Tests  34 passed (34)\n", seconds: 4.21 }),
    "PASS  test apps/web  (4.2s)  34 passed (34)",
  );
  NodeAssertStrict.equal(
    summarize({ job, code: 0, output: "No test files found, exiting with code 0\n", seconds: 1 }),
    "PASS  test apps/web  (1.0s)  no affected tests",
  );
});

// Each git call spawns a process. check:changed runs this beside a workspace's whole Vitest suite, and under that
// load the dozen calls here outlast Bun's 5 second default.
NodeTest.test("change detection reads staged, unstaged, untracked, and with --since the branch's commits", { timeout: 60_000 }, () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "check-changed-"));
  const git = (...args) => NodeChildProcess.execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const write = (file, text) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(repo, file), text);
  };
  try {
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    write("base.ts", "1");
    write("edited.ts", "1");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    git("switch", "--quiet", "-c", "feature");
    write("committed.ts", "1");
    git("add", ".");
    git("commit", "--quiet", "-m", "feature");
    write("edited.ts", "2");
    write("staged.ts", "1");
    git("add", "staged.ts");
    write("untracked.ts", "1");

    NodeAssertStrict.deepEqual(gitChangedFiles(repo, null), ["edited.ts", "staged.ts", "untracked.ts"]);
    NodeAssertStrict.deepEqual(gitChangedFiles(repo, "main"), ["committed.ts", "edited.ts", "staged.ts", "untracked.ts"]);
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});
