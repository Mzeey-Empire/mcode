import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { afterEach, expect, it } from "vitest";
import "reflect-metadata";
import { FileService } from "../file-service.js";
import { RealGitExecutor } from "../../git/execution/real-git-executor.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-server-audit-8384-"));
  dirs.push(root);
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10000 }).trim();
  git("init", "-b", "main");
  git("config", "commit.gpgSign", "false");
  git("config", "core.hooksPath", root);
  git("config", "user.name", "Audit Fixture");
  git("config", "user.email", "audit@example.invalid");
  const repo = { findById: () => ({ path: root }) };
  const executor = new RealGitExecutor();
  const files = new FileService(
    repo as never,
    { findById: () => null } as never,
    { resolveWorkingDir: () => root } as never,
    executor,
    { platform: process.platform } as never,
  );
  return { root, git, files };
}

it("refresh invalidates files added inside an already untracked directory", async () => {
  const { root, files } = fixture();
  NodeFS.mkdirSync(NodePath.join(root, "new-folder"));
  NodeFS.writeFileSync(NodePath.join(root, "new-folder", "first.ts"), "first");
  await files.refresh("fixture");
  NodeFS.writeFileSync(NodePath.join(root, "new-folder", "second.ts"), "second");
  const delta = await files.refresh("fixture");
  expect(delta).toEqual({ changedPaths: ["new-folder/second.ts"], wholeWorkspace: false });
});

it("refresh invalidates files removed from inside an untracked directory", async () => {
  const { root, files } = fixture();
  NodeFS.mkdirSync(NodePath.join(root, "new-folder"));
  NodeFS.writeFileSync(NodePath.join(root, "new-folder", "first.ts"), "first");
  NodeFS.writeFileSync(NodePath.join(root, "new-folder", "second.ts"), "second");
  await files.refresh("fixture");
  NodeFS.unlinkSync(NodePath.join(root, "new-folder", "second.ts"));
  const delta = await files.refresh("fixture");
  expect(delta).toEqual({ changedPaths: ["new-folder/second.ts"], wholeWorkspace: false });
});

it("refresh invalidates files added inside nested untracked directories", async () => {
  const { root, files } = fixture();
  NodeFS.mkdirSync(NodePath.join(root, "outer", "inner"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "outer", "inner", "first.ts"), "first");
  await files.refresh("fixture");
  NodeFS.mkdirSync(NodePath.join(root, "outer", "inner", "deep"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "outer", "inner", "deep", "second.ts"), "second");
  const delta = await files.refresh("fixture");
  expect(delta).toEqual({ changedPaths: ["outer/inner/deep/second.ts"], wholeWorkspace: false });
});

it("refresh stays silent when the untracked file set is unchanged", async () => {
  const { root, files } = fixture();
  NodeFS.mkdirSync(NodePath.join(root, "new-folder"));
  NodeFS.writeFileSync(NodePath.join(root, "new-folder", "first.ts"), "first");
  await files.refresh("fixture");
  expect(await files.refresh("fixture")).toBeNull();
});

it("refresh stays silent for ignored files inside an untracked directory", async () => {
  const { root, files } = fixture();
  NodeFS.writeFileSync(NodePath.join(root, ".gitignore"), "*.log\n");
  NodeFS.mkdirSync(NodePath.join(root, "new-folder"));
  NodeFS.writeFileSync(NodePath.join(root, "new-folder", "first.ts"), "first");
  await files.refresh("fixture");
  NodeFS.writeFileSync(NodePath.join(root, "new-folder", "debug.log"), "x");
  expect(await files.refresh("fixture")).toBeNull();
});

it("refresh stays silent when an untracked directory is staged", async () => {
  const { root, files, git } = fixture();
  NodeFS.mkdirSync(NodePath.join(root, "new-folder"));
  NodeFS.writeFileSync(NodePath.join(root, "new-folder", "first.ts"), "first");
  await files.refresh("fixture");
  // The fingerprint tracks the dirty path set, not index state: `?? f` -> `A  f`
  // keeps the same path, matching single-file staging which never invalidated.
  git("add", "new-folder");
  expect(await files.refresh("fixture")).toBeNull();
});

it("refresh expands untracked directories even when repo config disables them", async () => {
  const { root, files, git } = fixture();
  git("config", "status.showUntrackedFiles", "no");
  NodeFS.mkdirSync(NodePath.join(root, "new-folder"));
  NodeFS.writeFileSync(NodePath.join(root, "new-folder", "first.ts"), "first");
  await files.refresh("fixture");
  NodeFS.writeFileSync(NodePath.join(root, "new-folder", "second.ts"), "second");
  const delta = await files.refresh("fixture");
  expect(delta).toEqual({ changedPaths: ["new-folder/second.ts"], wholeWorkspace: false });
});
