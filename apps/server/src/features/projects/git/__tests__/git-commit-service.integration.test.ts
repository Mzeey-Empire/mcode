import "reflect-metadata";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCommitFile } from "@mcode/contracts";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { RealGitExecutor } from "../execution/real-git-executor.js";
import { GitPushService } from "../git-push-service.js";
import { RepositoryGitMutationLock } from "../repository-git-mutation-lock.js";
import { GitCommitRequestRepo } from "../commits/persistence/git-commit-request-repo.js";
import {
  GitCommitFaultStop,
  GitCommitService,
  type GitCommitRequest,
} from "../commits/git-commit-service.js";

const TEST_TIMEOUT_MS = 120_000;
const WORKSPACE_ID = "workspace-commit";
const NOW = "2026-10-10T09:00:00.000Z";

const temporaryDirectories: string[] = [];
const openServers: TestServer[] = [];

/** One database file and the services a server process builds around it. */
interface TestServer {
  readonly dbPath: string;
  readonly db: Database;
  readonly writer: ApplicationDatabaseWriter;
  readonly requests: GitCommitRequestRepo;
  readonly commits: GitCommitService;
}

interface Fixture {
  repo: string;
  remote: string;
  server: TestServer;
}

function temporaryDirectory(prefix: string): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(repo: string, path: string, content: string): void {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, path), content);
}

function hook(gitDir: string, name: string, script: string): void {
  NodeFS.mkdirSync(NodePath.join(gitDir, "hooks"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(gitDir, "hooks", name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

function head(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]);
}

function remoteRef(remote: string, ref: string): string | null {
  const line = git(remote, ["for-each-ref", "--format=%(objectname)", ref]);
  return line.length > 0 ? line : null;
}

function committedPaths(repo: string): string[] {
  return git(repo, ["show", "--name-only", "--format=", "-z", "HEAD"]).split("\0").filter(Boolean).sort();
}

/** A repository with one pushed commit, a bare `origin`, and no upstream configured. */
function createRepo(): { repo: string; remote: string } {
  const remote = NodePath.join(temporaryDirectory("mcode-commit-remote-"), "origin.git");
  NodeChildProcess.execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
  const repo = temporaryDirectory("mcode-commit-repo-");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@mcode.test"]);
  git(repo, ["config", "user.name", "Mcode Test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  for (const path of ["a.ts", "b.ts", "lit[1].ts", "lit1.ts", "old.ts", "gone.ts"]) write(repo, path, `export const v = "${path}";\n`);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-q", "origin", "main"]);
  return { repo, remote };
}

async function openServer(dbPath: string): Promise<TestServer> {
  const db = openDatabase({ dbPath });
  const writer = new ApplicationDatabaseWriter(dbPath);
  const executor = new RealGitExecutor();
  const unexpected = () => { throw new Error("Unexpected push dependency call"); };
  const pushes = new GitPushService(
    executor,
    { push: unexpected, getCurrentBranchAt: unexpected },
    { pushPullRequestReviewBranch: unexpected },
    { resolvePushTarget: () => ({ kind: "standard" }) },
    { findByWorkspaceBranch: () => [], scheduleBumpAfterPush: vi.fn() },
    { findById: vi.fn() },
  );
  const requests = new GitCommitRequestRepo(db, writer);
  const server: TestServer = {
    dbPath, db, writer, requests,
    commits: new GitCommitService(executor, new RepositoryGitMutationLock(hostRuntime), requests, pushes),
  };
  openServers.push(server);
  return server;
}

async function closeServer(server: TestServer): Promise<void> {
  const index = openServers.indexOf(server);
  if (index < 0) return;
  openServers.splice(index, 1);
  await server.writer.close();
  server.db.close(true);
}

/** Close the server and reopen the same database file, then reconcile as startup does. */
async function restart(server: TestServer): Promise<TestServer> {
  await closeServer(server);
  const next = await openServer(server.dbPath);
  await next.commits.reconcileAllPrepared();
  return next;
}

async function createFixture(): Promise<Fixture> {
  const { repo, remote } = createRepo();
  const server = await openServer(NodePath.join(temporaryDirectory("mcode-commit-db-"), "app.sqlite"));
  server.db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(WORKSPACE_ID, WORKSPACE_ID, repo, NOW, NOW);
  return { repo, remote, server };
}

function request(repo: string, files: GitCommitFile[], overrides: Partial<GitCommitRequest> = {}): GitCommitRequest {
  return {
    requestId: NodeCrypto.randomUUID(),
    workspaceId: WORKSPACE_ID,
    threadId: null,
    repoPath: repo,
    expectedHead: head(repo),
    files,
    message: "feat: commit selected files",
    push: false,
    ...overrides,
  };
}

function selected(...paths: string[]): GitCommitFile[] {
  return paths.map((path) => ({ path, previousPath: null }));
}

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await server.writer.close();
    server.db.close(true);
  }
  for (const directory of temporaryDirectories.splice(0)) NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("git prerequisites for pathspec commits", () => {
  it("commits an intent-to-add path through --pathspec-from-file and leaves other staged entries staged", () => {
    const { repo } = createRepo();
    const version = /git version (\d+)\.(\d+)/.exec(git(repo, ["--version"]));
    expect(Number(version?.[1]) * 100 + Number(version?.[2])).toBeGreaterThanOrEqual(225);
    write(repo, "new.md", "new\n");
    write(repo, "b.ts", "staged\n");
    git(repo, ["add", "b.ts"]);
    const list = NodePath.join(repo, ".git", "paths");
    NodeFS.writeFileSync(list, "new.md\0");
    git(repo, ["add", "-N", `--pathspec-from-file=${list}`, "--pathspec-file-nul"]);
    git(repo, ["commit", "-q", `--pathspec-from-file=${list}`, "--pathspec-file-nul", "-m", "prove"]);

    expect(committedPaths(repo)).toEqual(["new.md"]);
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("b.ts");
  }, TEST_TIMEOUT_MS);
});

describe("GitCommitService", () => {
  it("commits exactly the selected files, literally, and leaves other staged changes staged", async () => {
    const { repo, server } = await createFixture();
    write(repo, "a.ts", "changed a\n");
    write(repo, "b.ts", "staged b\n");
    git(repo, ["add", "b.ts"]);
    write(repo, "new.md", "# new\n");
    write(repo, "lit[1].ts", "changed literal\n");
    write(repo, "lit1.ts", "changed glob match\n");

    const result = await server.commits.commit(request(repo, selected("a.ts", "new.md", "lit[1].ts")));

    expect(result).toMatchObject({ status: "committed", sha: head(repo), branch: "main", push: { status: "skipped" } });
    expect(committedPaths(repo)).toEqual(["a.ts", "lit[1].ts", "new.md"]);
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("b.ts");
    expect(git(repo, ["status", "--porcelain=v1", "--", "lit1.ts"])).toBe("M lit1.ts");
    expect(NodeFS.readdirSync(NodePath.join(repo, ".git")).filter((name) => name.startsWith("mcode-commit-"))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("commits a rename as both sides and a deletion", async () => {
    const { repo, server } = await createFixture();
    NodeFS.renameSync(NodePath.join(repo, "old.ts"), NodePath.join(repo, "renamed.ts"));
    NodeFS.rmSync(NodePath.join(repo, "gone.ts"));

    const result = await server.commits.commit(request(repo, [
      { path: "renamed.ts", previousPath: "old.ts" },
      { path: "gone.ts", previousPath: null },
    ]));

    expect(result.status).toBe("committed");
    expect(git(repo, ["show", "-M", "--name-status", "--format=", "HEAD"]).split("\n").sort())
      .toEqual(["D\tgone.ts", "R100\told.ts\trenamed.ts"]);
    expect(git(repo, ["status", "--porcelain=v1"])).toBe("");
  }, TEST_TIMEOUT_MS);

  it("makes one commit for a repeated requestId and refuses the id with different inputs", async () => {
    const { repo, server } = await createFixture();
    write(repo, "a.ts", "changed a\n");
    const click = request(repo, selected("a.ts"), { push: true });

    const first = await server.commits.commit(click);
    const second = await server.commits.commit(click);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ status: "committed", push: { status: "pushed", destination: "origin refs/heads/main" } });
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("2");
    await expect(server.commits.commit({ ...click, message: "feat: something else" })).rejects.toThrow("different inputs");
  }, TEST_TIMEOUT_MS);

  it("returns the stored commit to a replay on a fresh service after a lost response", async () => {
    const { repo, server } = await createFixture();
    write(repo, "a.ts", "changed a\n");
    const click = request(repo, selected("a.ts"));
    const first = await server.commits.commit(click);

    const restarted = await restart(server);
    const replay = await restarted.commits.commit(click);

    expect(replay).toEqual(first);
    expect(replay).toMatchObject({ status: "committed", sha: head(repo) });
  }, TEST_TIMEOUT_MS);

  it("pushes the captured sha on replay after a restart before the push, and sets the upstream", async () => {
    const { repo, remote, server } = await createFixture();
    write(repo, "a.ts", "changed a\n");
    const click = request(repo, selected("a.ts"), { push: true });

    await expect(server.commits.commit(click, { stopAt: "before-push" })).rejects.toBeInstanceOf(GitCommitFaultStop);
    const sha = head(repo);
    const restarted = await restart(server);
    expect(restarted.requests.findById(click.requestId)).toMatchObject({
      state: "committed",
      commitSha: sha,
      push: { state: "pending", destination: { kind: "standard", remote: "origin", branch: "main" } },
    });

    const replay = await restarted.commits.commit(click);

    expect(replay).toMatchObject({ status: "committed", sha, push: { status: "pushed", destination: "origin refs/heads/main" } });
    expect(remoteRef(remote, "refs/heads/main")).toBe(sha);
    expect(git(repo, ["rev-parse", "--abbrev-ref", "main@{upstream}"])).toBe("origin/main");
  }, TEST_TIMEOUT_MS);

  it("pushes to the captured branch even when the checkout switched branches in the push gap", async () => {
    const { repo, remote, server } = await createFixture();
    write(repo, "a.ts", "changed a\n");
    const click = request(repo, selected("a.ts"), { push: true });
    await expect(server.commits.commit(click, { stopAt: "before-push" })).rejects.toBeInstanceOf(GitCommitFaultStop);
    const sha = head(repo);
    git(repo, ["checkout", "-q", "-b", "other"]);
    write(repo, "b.ts", "other branch work\n");
    git(repo, ["commit", "-q", "-am", "other work"]);

    const replay = await server.commits.commit(click);

    expect(replay).toMatchObject({ status: "committed", sha, push: { status: "pushed" } });
    expect(remoteRef(remote, "refs/heads/main")).toBe(sha);
    expect(remoteRef(remote, "refs/heads/other")).toBeNull();
  }, TEST_TIMEOUT_MS);

  it("reconciles to unknown, and never pushes, when an external commit with the same subject lands", async () => {
    const { repo, remote, server } = await createFixture();
    const remoteBefore = remoteRef(remote, "refs/heads/main");
    write(repo, "a.ts", "changed a\n");
    const click = request(repo, selected("a.ts"), { push: true });
    await expect(server.commits.commit(click, { stopAt: "after-prepared-write" })).rejects.toBeInstanceOf(GitCommitFaultStop);
    git(repo, ["commit", "-q", "-am", click.message]);
    const external = head(repo);

    const restarted = await restart(server);
    expect(restarted.requests.findById(click.requestId)).toMatchObject({ state: "unknown", head: external });
    const replay = await restarted.commits.commit(click);

    expect(replay).toMatchObject({ status: "unknown", head: external });
    expect(remoteRef(remote, "refs/heads/main")).toBe(remoteBefore);
  }, TEST_TIMEOUT_MS);

  it("reconciles a crash after git commit exited 0 to unknown and pushes nothing", async () => {
    const { repo, remote, server } = await createFixture();
    const remoteBefore = remoteRef(remote, "refs/heads/main");
    write(repo, "a.ts", "changed a\n");
    const click = request(repo, selected("a.ts"), { push: true });

    await expect(server.commits.commit(click, { stopAt: "after-commit-exit" })).rejects.toBeInstanceOf(GitCommitFaultStop);
    const madeByCrashedRequest = head(repo);
    expect(madeByCrashedRequest).not.toBe(click.expectedHead);
    const restarted = await restart(server);

    expect(restarted.requests.findById(click.requestId)?.state).toBe("unknown");
    expect(await restarted.commits.commit(click)).toMatchObject({ status: "unknown", head: madeByCrashedRequest });
    expect(remoteRef(remote, "refs/heads/main")).toBe(remoteBefore);
  }, TEST_TIMEOUT_MS);

  it("owns a commit whose subject a commit-msg hook rewrote, and pushes that sha", async () => {
    const { repo, remote, server } = await createFixture();
    hook(NodePath.join(repo, ".git"), "commit-msg", `printf 'chore: rewritten by hook\\n' > "$1"`);
    write(repo, "a.ts", "changed a\n");

    const result = await server.commits.commit(request(repo, selected("a.ts"), { push: true }));

    expect(result).toMatchObject({ status: "committed", sha: head(repo), push: { status: "pushed" } });
    expect(git(repo, ["log", "-1", "--format=%s"])).toBe("chore: rewritten by hook");
    expect(remoteRef(remote, "refs/heads/main")).toBe(head(repo));
  }, TEST_TIMEOUT_MS);

  it("reconciles a prepared request with HEAD unchanged to interrupted, or to unknown while index.lock exists", async () => {
    const { repo, server } = await createFixture();
    write(repo, "a.ts", "changed a\n");
    const interrupted = request(repo, selected("a.ts"));
    const locked = request(repo, selected("a.ts"), { message: "feat: second click" });
    await expect(server.commits.commit(interrupted, { stopAt: "after-prepared-write" })).rejects.toBeInstanceOf(GitCommitFaultStop);
    let restarted = await restart(server);
    await expect(restarted.commits.commit(locked, { stopAt: "after-prepared-write" })).rejects.toBeInstanceOf(GitCommitFaultStop);
    NodeFS.writeFileSync(NodePath.join(repo, ".git", "index.lock"), "");

    restarted = await restart(restarted);

    expect(await restarted.commits.commit(interrupted)).toEqual({
      status: "rejected",
      reason: {
        kind: "failed",
        summary: "Commit was interrupted",
        detail: "Mcode stopped before it recorded the outcome, and HEAD did not move.",
      },
    });
    expect(await restarted.commits.commit(locked)).toMatchObject({ status: "unknown", head: interrupted.expectedHead });
  }, TEST_TIMEOUT_MS);

  it("rejects a stale expectedHead as head-moved, commits nothing and stores nothing", async () => {
    const { repo, server } = await createFixture();
    write(repo, "a.ts", "changed a\n");
    const stale = request(repo, selected("a.ts"), { expectedHead: "f".repeat(40) });

    expect(await server.commits.commit(stale)).toEqual({ status: "rejected", reason: { kind: "head-moved", head: head(repo) } });
    expect(git(repo, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(server.requests.findById(stale.requestId)).toBeNull();
  }, TEST_TIMEOUT_MS);

  it("rejects a push request on a detached checkout as no-branch", async () => {
    const { repo, server } = await createFixture();
    git(repo, ["checkout", "-q", "--detach"]);
    write(repo, "a.ts", "changed a\n");

    expect(await server.commits.commit(request(repo, selected("a.ts"), { push: true })))
      .toEqual({ status: "rejected", reason: { kind: "no-branch" } });
  }, TEST_TIMEOUT_MS);

  it("reports a failing pre-commit hook with its output and rolls back intent-to-add", async () => {
    const { repo, server } = await createFixture();
    hook(NodePath.join(repo, ".git"), "pre-commit", `echo "lint failed in new.md" >&2\nexit 1`);
    const before = head(repo);
    write(repo, "new.md", "# new\n");

    const result = await server.commits.commit(request(repo, selected("new.md")));

    expect(result).toMatchObject({ status: "rejected", reason: { kind: "failed", summary: "lint failed in new.md" } });
    expect(result.status === "rejected" && result.reason.kind === "failed" && result.reason.detail).toContain("lint failed in new.md");
    expect(head(repo)).toBe(before);
    expect(git(repo, ["status", "--porcelain=v1", "--", "new.md"])).toBe("?? new.md");
  }, TEST_TIMEOUT_MS);

  it("rejects a commit of unchanged files as nothing-to-commit", async () => {
    const { repo, server } = await createFixture();

    expect(await server.commits.commit(request(repo, selected("a.ts"))))
      .toEqual({ status: "rejected", reason: { kind: "nothing-to-commit" } });
  }, TEST_TIMEOUT_MS);

  it("keeps the commit and reports push.failed when the remote rejects the push", async () => {
    const { repo, remote, server } = await createFixture();
    hook(remote, "pre-receive", `echo "denied by policy" >&2\nexit 1`);
    write(repo, "a.ts", "changed a\n");

    const result = await server.commits.commit(request(repo, selected("a.ts"), { push: true }));

    expect(result).toMatchObject({ status: "committed", sha: head(repo), push: { status: "failed" } });
    expect(result.status === "committed" && result.push.status === "failed" && result.push.detail).toContain("denied by policy");
    expect(remoteRef(remote, "refs/heads/main")).not.toBe(head(repo));
  }, TEST_TIMEOUT_MS);

  it("refuses a path outside the repository without storing a request", async () => {
    const { repo, server } = await createFixture();
    const escape = request(repo, selected("../outside.ts"));

    await expect(server.commits.commit(escape)).rejects.toThrow("Invalid repository path");
    expect(server.requests.findById(escape.requestId)).toBeNull();
  }, TEST_TIMEOUT_MS);
});
