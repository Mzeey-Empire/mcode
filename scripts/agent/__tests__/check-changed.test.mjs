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

function planWithFiles(files, contents) {
  return planChecks({
    files,
    workspaces: WORKSPACES,
    since: null,
    exists: everyFileExists,
    listFiles: (dir) => Object.keys(contents).filter((file) => file.startsWith(`${dir}/`)),
    readFile: (file) => contents[file],
  });
}

function selectedTests(plan) {
  return plan.jobs
    .filter((job) => job.label.startsWith("test "))
    .flatMap((job) => job.args.slice(3).filter((arg) => !arg.startsWith("-")));
}

NodeTest.test("a shared package change runs tests in its workspace and typechecks its dependents", () => {
  const plan = planWithFiles(["packages/shared/src/id.ts"], {
    "packages/shared/src/id.test.ts": "",
    "packages/contracts/src/id.test.ts": "import { id } from '@mcode/shared/id';",
    "apps/web/src/id.test.ts": "",
  });

  NodeAssertStrict.deepEqual(labels(plan), [
    "test packages/shared (1 file)",
    "typecheck packages/shared",
    "typecheck packages/contracts",
    "typecheck apps/web",
    "lint 1 file",
  ]);
  NodeAssertStrict.deepEqual(selectedTests(plan), ["src/id.test.ts"]);
  NodeAssertStrict.deepEqual(plan.notes, []);
});

NodeTest.test("a changed test runs itself when it still exists", () => {
  const plan = planChecks({
    files: ["apps/web/src/live.test.tsx", "apps/web/src/deleted.test.ts"],
    workspaces: WORKSPACES,
    exists: (file) => file !== "apps/web/src/deleted.test.ts",
  });

  NodeAssertStrict.deepEqual(selectedTests(plan), ["src/live.test.tsx"]);
});

NodeTest.test("a changed source runs its named tests in other folders", () => {
  const plan = planWithFiles(["apps/web/src/stores/threadStore.ts"], {
    "apps/web/src/__tests__/threadStore.test.ts": "",
    "apps/web/src/features/threadStore-reasoning.test.ts": "",
    "apps/web/src/features/threadStoreMore.test.ts": "",
  });

  NodeAssertStrict.deepEqual(selectedTests(plan), [
    "src/__tests__/threadStore.test.ts",
    "src/features/threadStore-reasoning.test.ts",
  ]);
});

NodeTest.test("a changed source runs tests that import, re-export, or mock it as well as named tests", () => {
  const plan = planWithFiles(["apps/web/src/stores/threadStore.ts"], {
    "apps/web/src/__tests__/comment.test.ts": "// import '../stores/threadStore';",
    "apps/web/src/__tests__/dynamic.test.ts": "await import('../stores/threadStore');",
    "apps/web/src/__tests__/mock.test.ts": "vi.mock(\"@/stores/threadStore.ts\", () => ({}));",
    "apps/web/src/__tests__/reexport.test.ts": "export { threadStore } from '../stores/threadStore.js';",
    "apps/web/src/__tests__/static.test.ts": "import {\n  threadStore,\n} from '../stores/threadStore';",
    "apps/web/src/__tests__/threadStore.test.ts": "",
  });

  NodeAssertStrict.deepEqual(selectedTests(plan), [
    "src/__tests__/dynamic.test.ts",
    "src/__tests__/mock.test.ts",
    "src/__tests__/reexport.test.ts",
    "src/__tests__/static.test.ts",
    "src/__tests__/threadStore.test.ts",
  ]);
});

NodeTest.test("an import of a different module with the same file name does not select the test", () => {
  const plan = planWithFiles(["apps/web/src/features/narrative/types.ts"], {
    "apps/web/src/__tests__/narrative.test.ts": "import type { Segment } from '@/features/narrative/types';",
    "apps/web/src/__tests__/transport.test.ts": "import type { Call } from '../transport/types';",
    "apps/web/src/features/narrative/__tests__/local.test.ts": "import type { Segment } from '../types.js';",
    "apps/web/src/__tests__/folder.test.ts": "import { Segment } from '@/features/narrative';",
  });

  NodeAssertStrict.deepEqual(selectedTests(plan), [
    "src/__tests__/narrative.test.ts",
    "src/features/narrative/__tests__/local.test.ts",
  ]);
});

NodeTest.test("a changed index module is reached through its folder", () => {
  const plan = planWithFiles(["apps/web/src/features/narrative/index.ts"], {
    "apps/web/src/__tests__/folder.test.ts": "import { Segment } from '@/features/narrative';",
    "apps/web/src/__tests__/other.test.ts": "import { Row } from '@/features/other';",
  });

  NodeAssertStrict.deepEqual(selectedTests(plan), ["src/__tests__/folder.test.ts"]);
});

NodeTest.test("a source without direct tests runs only the named tests of its immediate importers", () => {
  const plan = planWithFiles(["apps/web/src/internal/projection.ts"], {
    "apps/web/src/stores/threadStore.ts": "import { project } from '../internal/projection';",
    "apps/web/src/features/consumer.ts": "import { threadStore } from '../stores/threadStore';",
    "apps/web/src/__tests__/threadStore-reasoning.test.ts": "",
    "apps/web/src/__tests__/consumer.test.ts": "",
    "apps/web/src/__tests__/view.test.ts": "import { threadStore } from '../stores/threadStore';",
  });

  NodeAssertStrict.deepEqual(selectedTests(plan), ["src/__tests__/threadStore-reasoning.test.ts"]);
  NodeAssertStrict.deepEqual(plan.notes, []);
});

NodeTest.test("a source without related tests reports the gap and starts no test job", () => {
  const plan = planWithFiles(["apps/web/src/internal/uncovered.ts"], {
    "apps/web/src/__tests__/unrelated.test.ts": "",
  });

  NodeAssertStrict.deepEqual(labels(plan), ["typecheck apps/web", "lint 1 file"]);
  NodeAssertStrict.deepEqual(plan.notes, ["no direct tests for apps/web/src/internal/uncovered.ts"]);
});

NodeTest.test("a deleted file still selects its workspace but never reaches the linter, and docs are not linted", () => {
  const plan = planChecks({
    files: ["apps/server/src/gone.ts", "apps/server/README.md"],
    workspaces: WORKSPACES,
    since: null,
    exists: (file) => file !== "apps/server/src/gone.ts",
    listFiles: () => [],
  });

  NodeAssertStrict.deepEqual(labels(plan), ["typecheck apps/server"]);
  NodeAssertStrict.deepEqual(plan.notes, ["no direct tests for apps/server/src/gone.ts"]);
});

NodeTest.test("a shared config change says the scoped run cannot vouch for it", () => {
  const plan = planChecks({ files: ["tsconfig.base.json"], workspaces: WORKSPACES, since: null, exists: everyFileExists });

  NodeAssertStrict.deepEqual(plan.jobs, []);
  NodeAssertStrict.match(plan.notes[0], /tsconfig\.base\.json/);
  NodeAssertStrict.match(plan.notes[0], /bun run check:changed --full/);
});

NodeTest.test("--full restores Vitest changed jobs for touched and dependent workspaces in either flag order", () => {
  for (const [argv, changed] of [
    [["--full"], "--changed"],
    [["--full", "--since", "origin/main"], "--changed=origin/main"],
    [["--since", "origin/main", "--full"], "--changed=origin/main"],
  ]) {
    const plan = planChecks({
      files: ["packages/shared/src/id.ts"],
      workspaces: WORKSPACES,
      exists: everyFileExists,
      ...parseCheckArgs(argv),
    });

    const jobs = plan.jobs.filter((job) => job.label.startsWith("test "));
    NodeAssertStrict.deepEqual(jobs.map((job) => job.cwd), ["packages/shared", "packages/contracts", "apps/web"]);
    for (const job of jobs) {
      NodeAssertStrict.deepEqual(job.args, [
        "run", "test", "--", changed, "--passWithNoTests", "--reporter=dot", "--silent=passed-only",
      ]);
    }
  }
});

NodeTest.test("--since alone keeps direct selection and invalid arguments are refused", () => {
  const options = parseCheckArgs(["--since", "origin/main"]);
  NodeAssertStrict.deepEqual(options, { since: "origin/main", full: false });
  NodeAssertStrict.throws(() => parseCheckArgs(["--since"]));
  NodeAssertStrict.throws(() => parseCheckArgs(["--full", "apps/web"]));

  const plan = planChecks({
    files: ["apps/server/src/a.test.ts"],
    workspaces: WORKSPACES,
    exists: everyFileExists,
    ...options,
  });
  NodeAssertStrict.deepEqual(selectedTests(plan), ["src/a.test.ts"]);
});

NodeTest.test("an agent script change runs its own test file, and a changed test runs itself", () => {
  const present = new Set(["scripts/agent/__tests__/agent-up.test.mjs", "scripts/agent/__tests__/fixture-repo.test.mjs"]);
  const files = ["scripts/agent/agent-up.mjs", "scripts/agent/__tests__/fixture-repo.test.mjs", "scripts/agent/no-test.mjs"];

  NodeAssertStrict.deepEqual(agentTestFiles(files, (file) => present.has(file)), [
    "scripts/agent/__tests__/agent-up.test.mjs",
    "scripts/agent/__tests__/fixture-repo.test.mjs",
  ]);
});

NodeTest.test("harness changes select the sibling test or the changed test itself", () => {
  const directory = ".agents/skills/electorn-live-testing/scripts";
  const files = [
    `${directory}/electron-session.mjs`,
    `${directory}/record-video.test.mjs`,
    `${directory}/no-test.mjs`,
  ];
  const tests = [`${directory}/electron-session.test.mjs`, `${directory}/record-video.test.mjs`];

  const plan = planChecks({
    files,
    workspaces: WORKSPACES,
    exists: (file) => files.includes(file) || tests.includes(file),
  });

  const agentTests = plan.jobs.find((job) => job.args[0] === "scripts/agent/test-scripts.mjs");
  NodeAssertStrict.deepEqual(agentTests?.args.slice(1), tests);
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

// Each git call spawns a process. On a shared machine the dozen calls here can outlast Bun's 5 second default.
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
