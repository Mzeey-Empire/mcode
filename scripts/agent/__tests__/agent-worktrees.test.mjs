/**
 * Tests that agent:worktrees removes only worktrees that hold no work, against real git worktrees.
 */
import * as NodeTest from "node:test";
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { listWorktrees, removeWorktrees } from "../agent-worktrees.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(cwd, args) {
  return NodeChildProcess.execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", windowsHide: true }).trim();
}

function commitFile(cwd, name) {
  NodeFS.writeFileSync(NodePath.join(cwd, name), `${name}\n`);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-q", "-m", name]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * Builds a repository with one worktree per case. Each worktree's branch name is its case,
 * so a failing assertion names the case.
 */
function makeRepository() {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-worktrees-")));
  const origin = NodePath.join(root, "origin.git");
  const main = NodePath.join(root, "main");
  const outside = NodePath.join(root, "outside-modules");
  git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  git(root, ["init", "-q", "-b", "main", main]);
  NodeFS.writeFileSync(NodePath.join(main, ".gitignore"), "node_modules\n");
  git(main, ["add", ".gitignore"]);
  const base = commitFile(main, "base.txt");
  git(main, ["remote", "add", "origin", origin]);
  git(main, ["push", "-q", "-u", "origin", "main"]);

  const worktree = (name) => {
    const path = NodePath.join(root, "worktrees", name);
    git(main, ["worktree", "add", "-q", "-b", name, path, "main"]);
    return path;
  };
  const pushThenDeleteRemote = (path, name) => {
    git(path, ["push", "-q", "-u", "origin", name]);
    git(main, ["push", "-q", "origin", "--delete", name]);
    git(main, ["fetch", "-q", "--prune"]);
  };

  worktree("merged");
  const squashed = worktree("squashed");
  const squashedHead = commitFile(squashed, "squashed.txt");
  pushThenDeleteRemote(squashed, "squashed");
  pushThenDeleteRemote(worktree("gone"), "gone");
  NodeFS.writeFileSync(NodePath.join(worktree("uncommitted"), "draft.txt"), "draft\n");
  commitFile(worktree("unpushed"), "local.txt");
  worktree("open");
  NodeFS.mkdirSync(outside);
  NodeFS.writeFileSync(NodePath.join(outside, "keep.txt"), "keep\n");
  NodeFS.symlinkSync(outside, NodePath.join(worktree("linked"), "node_modules"), "junction");
  const current = worktree("current");

  const pullRequests = [
    { headRefName: "merged", headRefOid: base, state: "MERGED" },
    { headRefName: "squashed", headRefOid: squashedHead, state: "MERGED" },
    { headRefName: "uncommitted", headRefOid: base, state: "MERGED" },
    { headRefName: "unpushed", headRefOid: base, state: "MERGED" },
    { headRefName: "open", headRefOid: base, state: "OPEN" },
    { headRefName: "linked", headRefOid: base, state: "MERGED" },
    { headRefName: "current", headRefOid: base, state: "MERGED" },
  ];
  return { root, main, outside, current, pullRequests };
}

function byBranch(entries) {
  return Object.fromEntries(entries.map((entry) => [entry.branch, entry]));
}

// About 40 real git commands per repository; on Windows that exceeds Bun's 5 s default.
const GIT_TEST_TIMEOUT = { timeout: 120_000 };

NodeTest.test("does not count hardlinked files as space freed by removal", GIT_TEST_TIMEOUT, async () => {
  const repository = makeRepository();
  try {
    const source = NodePath.join(repository.outside, "cache.bin");
    NodeFS.writeFileSync(source, Buffer.alloc(1024 * 1024));
    const modules = NodePath.join(repository.root, "worktrees", "merged", "node_modules");
    NodeFS.mkdirSync(modules);
    NodeFS.linkSync(source, NodePath.join(modules, "package.bin"));
    const entries = await listWorktrees({
      cwd: repository.current,
      loadPullRequests: async () => repository.pullRequests,
      warn: () => {},
    });
    const entry = byBranch(entries).merged;
    NodeAssertStrict.default.ok(entry.bytes < 1024 * 1024, `freeable bytes: ${entry.bytes}`);
    NodeAssertStrict.default.deepEqual(entry.keepReasons, []);
  } finally {
    NodeFS.rmSync(repository.root, { recursive: true, force: true });
  }
});

NodeTest.test("skips worktrees that gain an outside junction or a commit after inspection", GIT_TEST_TIMEOUT, async () => {
  const repository = makeRepository();
  try {
    const entries = await listWorktrees({
      cwd: repository.current,
      loadPullRequests: async () => repository.pullRequests,
      warn: () => {},
    });
    const branches = byBranch(entries);
    NodeFS.mkdirSync(NodePath.join(branches.merged.path, "node_modules"));
    NodeFS.symlinkSync(repository.outside, NodePath.join(branches.merged.path, "node_modules", "outside"), "junction");
    commitFile(branches.gone.path, "late.txt");
    const { removed, failed, skipped } = await removeWorktrees(entries, { cwd: repository.current });
    NodeAssertStrict.default.deepEqual(failed, []);
    NodeAssertStrict.default.deepEqual(removed.map((entry) => entry.branch), ["squashed"]);
    NodeAssertStrict.default.deepEqual(skipped.map(({ entry }) => entry.branch).sort(), ["gone", "merged"]);
    NodeAssertStrict.default.match(skipped.find(({ entry }) => entry.branch === "gone").reason, /HEAD moved/);
    NodeAssertStrict.default.match(skipped.find(({ entry }) => entry.branch === "merged").reason, /links outside/);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(NodePath.join(repository.outside, "keep.txt"), "utf8"), "keep\n");
  } finally {
    NodeFS.rmSync(repository.root, { recursive: true, force: true });
  }
});

NodeTest.test("skips a worktree whose commits lose their last remote ref after inspection", GIT_TEST_TIMEOUT, async () => {
  const repository = makeRepository();
  try {
    const carried = NodePath.join(repository.root, "worktrees", "carried");
    git(repository.main, ["worktree", "add", "-q", "-b", "carried", carried, "main"]);
    commitFile(carried, "carried.txt");
    git(carried, ["push", "-q", "-u", "origin", "carried"]);
    git(carried, ["push", "-q", "origin", "HEAD:carrier"]);
    git(repository.main, ["push", "-q", "origin", "--delete", "carried"]);
    git(repository.main, ["fetch", "-q", "--prune"]);
    const entries = await listWorktrees({
      cwd: repository.current,
      loadPullRequests: async () => repository.pullRequests,
      warn: () => {},
    });
    NodeAssertStrict.default.deepEqual(byBranch(entries).carried.keepReasons, []);

    git(repository.main, ["push", "-q", "origin", "--delete", "carrier"]);
    git(repository.main, ["fetch", "-q", "--prune"]);
    const { skipped } = await removeWorktrees(entries, { cwd: repository.current });
    const skippedCarried = skipped.find(({ entry }) => entry.branch === "carried");
    NodeAssertStrict.default.ok(skippedCarried);
    NodeAssertStrict.default.match(skippedCarried.reason, /unpushed commits/);
    NodeAssertStrict.default.ok(NodeFS.existsSync(carried));
  } finally {
    NodeFS.rmSync(repository.root, { recursive: true, force: true });
  }
});

NodeTest.test("keeps a pushed reused branch whose HEAD is newer than its merged pull request", GIT_TEST_TIMEOUT, async () => {
  const repository = makeRepository();
  try {
    const reused = NodePath.join(repository.root, "worktrees", "reused");
    git(repository.main, ["worktree", "add", "-q", "-b", "reused", reused, "main"]);
    const base = git(reused, ["rev-parse", "HEAD"]);
    commitFile(reused, "new-work.txt");
    git(reused, ["push", "-q", "-u", "origin", "reused"]);
    const entries = await listWorktrees({
      cwd: repository.current,
      loadPullRequests: async () => [...repository.pullRequests, { headRefName: "reused", headRefOid: base, state: "MERGED" }],
      warn: () => {},
    });
    NodeAssertStrict.default.deepEqual(byBranch(entries).reused.keepReasons, ["branch is pushed but not merged"]);
  } finally {
    NodeFS.rmSync(repository.root, { recursive: true, force: true });
  }
});

NodeTest.test("removes only clean worktrees with nothing unpushed and a merged or gone branch", GIT_TEST_TIMEOUT, async () => {
  const repository = makeRepository();
  try {
    const entries = await listWorktrees({
      cwd: repository.current,
      loadPullRequests: async () => repository.pullRequests,
      warn: () => {},
    });
    const branches = byBranch(entries);

    const removable = entries.filter((entry) => entry.keepReasons.length === 0).map((entry) => entry.branch).sort();
    NodeAssertStrict.default.deepEqual(removable, ["gone", "merged", "squashed"]);
    NodeAssertStrict.default.deepEqual(branches.uncommitted.keepReasons, ["1 uncommitted files"]);
    NodeAssertStrict.default.deepEqual(branches.unpushed.keepReasons, ["branch was never pushed", "1 unpushed commits"]);
    NodeAssertStrict.default.deepEqual(branches.open.keepReasons, ["branch has an open pull request"]);
    NodeAssertStrict.default.match(branches.linked.keepReasons.join(), /^links outside the worktree/);
    NodeAssertStrict.default.deepEqual(branches.current.keepReasons, ["this command runs from it"]);
    NodeAssertStrict.default.ok(branches.main.keepReasons.includes("main checkout"));

    const { removed, failed } = await removeWorktrees(entries, { cwd: repository.current });
    NodeAssertStrict.default.deepEqual(failed, []);
    NodeAssertStrict.default.deepEqual(removed.map((entry) => entry.branch).sort(), ["gone", "merged", "squashed"]);
    for (const entry of entries) {
      NodeAssertStrict.default.equal(NodeFS.existsSync(entry.path), entry.keepReasons.length > 0, entry.branch);
    }
    NodeAssertStrict.default.ok(NodeFS.existsSync(NodePath.join(repository.outside, "keep.txt")));
  } finally {
    NodeFS.rmSync(repository.root, { recursive: true, force: true });
  }
});

NodeTest.test("keeps squash-merged branches when pull requests cannot be loaded", GIT_TEST_TIMEOUT, async () => {
  const repository = makeRepository();
  try {
    const warnings = [];
    const entries = await listWorktrees({
      cwd: repository.current,
      loadPullRequests: async () => {
        throw new Error("gh is not signed in");
      },
      warn: (message) => warnings.push(message),
    });
    const branches = byBranch(entries);

    NodeAssertStrict.default.equal(warnings.length, 1);
    NodeAssertStrict.default.deepEqual(branches.squashed.keepReasons, ["1 unpushed commits"]);
    NodeAssertStrict.default.deepEqual(branches.merged.keepReasons, ["branch was never pushed"]);
    NodeAssertStrict.default.deepEqual(branches.gone.keepReasons, []);
  } finally {
    NodeFS.rmSync(repository.root, { recursive: true, force: true });
  }
});
