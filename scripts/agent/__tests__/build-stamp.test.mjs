/** Tests for the stamp that tells agent:ready whether the runtime bundles match the source. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { agentSetup, setAgentSetupTestHooks } from "../agent-setup.mjs";
import { captureBuildInputs, checkBuildStamp, describeBuildStamp, writeBuildStamp } from "../build-stamp.mjs";

NodeTest.test("the stamp stays current for edits the bundles do not contain, and when built edits are committed", () => {
  const repo = makeRepo();
  try {
    write(repo, "apps/server/src/index.ts", "export const built = 2;\n");
    writeBuildStamp(repo, captureBuildInputs(repo));

    write(repo, "apps/web/src/main.tsx", "export const web = 2;\n");
    write(repo, "apps/server/src/__tests__/index.test.ts", "it('changed');\n");
    write(repo, "apps/server/dist-tsc/index.js", "exports.built = 3;\n");
    write(repo, "packages/oxlint-plugin/index.js", "export const rule = 2;\n");
    git(repo, "commit", "-qam", "commit the built edit");

    NodeAssertStrict.default.equal(checkBuildStamp(repo).status, "current");
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("the stamp names edited, added, and deleted bundle inputs, tracked or not", () => {
  const repo = makeRepo();
  try {
    writeBuildStamp(repo, captureBuildInputs(repo));

    write(repo, "apps/server/src/index.ts", "export const built = 2;\n");
    write(repo, "packages/shared/src/new.ts", "export const added = 1;\n");
    NodeFS.rmSync(NodePath.join(repo, "apps/desktop/src/main/main.ts"));

    const check = checkBuildStamp(repo);
    NodeAssertStrict.default.equal(check.status, "stale");
    NodeAssertStrict.default.deepEqual(check.changed, [
      "apps/desktop/src/main/main.ts",
      "apps/server/src/index.ts",
      "packages/shared/src/new.ts",
    ]);
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentSetup stamps the inputs from before its build, so an edit during the build reads as stale", async () => {
  const repo = makeRepo();
  const restoreHooks = setAgentSetupTestHooks({
    ensureRuntimeDatabase: () => {},
    isFixtureRepo: () => true,
    rebuildServerDevBundle: async () => write(repo, "apps/server/src/index.ts", "export const built = 2;\n"),
    buildDesktopMain: async () => {},
  });
  try {
    await agentSetup(repo);

    const check = checkBuildStamp(repo);
    NodeAssertStrict.default.equal(check.status, "stale");
    NodeAssertStrict.default.deepEqual(check.changed, ["apps/server/src/index.ts"]);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("a failed agentSetup build removes the earlier stamp instead of vouching for half-built bundles", async () => {
  const repo = makeRepo();
  writeBuildStamp(repo, captureBuildInputs(repo));
  const restoreHooks = setAgentSetupTestHooks({
    ensureRuntimeDatabase: () => {},
    isFixtureRepo: () => true,
    rebuildServerDevBundle: async () => {},
    buildDesktopMain: async () => { throw new Error("main build failed"); },
  });
  try {
    await NodeAssertStrict.default.rejects(() => agentSetup(repo), /main build failed/);

    NodeAssertStrict.default.equal(checkBuildStamp(repo).status, "missing");
    NodeAssertStrict.default.match(describeBuildStamp(checkBuildStamp(repo)), /no readable build stamp/);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("the stale warning lists the first five changed files, counts the rest, and says how to rebuild", () => {
  const changed = ["a", "b", "c", "d", "e", "f", "g"].map((name) => `apps/server/src/${name}.ts`);
  const warning = describeBuildStamp({ status: "stale", head: "0123456789abcdef", builtAt: "2026-11-03T10:00:00.000Z", changed });

  NodeAssertStrict.default.match(warning, /7 source files changed since agent:setup built them \(012345678, 2026-11-03T10:00:00.000Z\)/);
  NodeAssertStrict.default.match(warning, /apps\/server\/src\/e\.ts\n {2}and 2 more\n/);
  NodeAssertStrict.default.doesNotMatch(warning, /f\.ts/);
  NodeAssertStrict.default.match(warning, /agent:down, agent:setup, then agent:up/);
});

function makeRepo() {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "build-stamp-"));
  git(repo, "init", "-q", "-b", "main");
  write(repo, ".gitignore", ".dev/\napps/server/dist-tsc/\n");
  write(repo, "apps/server/src/index.ts", "export const built = 1;\n");
  write(repo, "apps/desktop/src/main/main.ts", "export const main = 1;\n");
  write(repo, "apps/web/src/main.tsx", "export const web = 1;\n");
  write(repo, "packages/oxlint-plugin/index.js", "export const rule = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial");
  return repo;
}

function write(repo, path, content) {
  const file = NodePath.join(repo, path);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, content);
}

function git(repo, ...args) {
  NodeChildProcess.execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: repo });
}

