#!/usr/bin/env bun
/**
 * Lists every git worktree of this repository with the tool that made it, the work it
 * holds, the state of its branch, and its size. With --remove it deletes the worktrees
 * that hold no work: no uncommitted changes, no unpushed commits, and a merged or gone branch.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const INSPECT_CONCURRENCY = 8;
const COMMAND_MAX_BUFFER = 256 * 1024 * 1024;
const REMOVABLE_BRANCH_STATES = new Set(["merged", "gone"]);
const BRANCH_STATE_REASONS = {
  open: "branch has an open pull request",
  unmerged: "branch is pushed but not merged",
  local: "branch was never pushed",
  detached: "detached HEAD, no branch",
};

/**
 * @typedef {{ headRefName: string, headRefOid: string, state: "OPEN" | "MERGED" | "CLOSED" }} PullRequest
 * @typedef {"merged" | "gone" | "open" | "unmerged" | "local" | "detached"} BranchState
 * @typedef {{
 *   path: string,
 *   branch: string | null,
 *   head: string | null,
 *   origin: string,
 *   branchState: BranchState,
 *   mergedHeads: string[],
 *   uncommittedFiles: number,
 *   unpushedCommits: number,
 *   bytes: number,
 *   keepReasons: string[],
 * }} WorktreeEntry
 */

async function run(command, args, cwd) {
  const { stdout } = await execFile(command, args, { cwd, maxBuffer: COMMAND_MAX_BUFFER, windowsHide: true });
  return stdout;
}

function git(cwd, args) {
  return run("git", ["-C", cwd, ...args], cwd);
}

/** Loads this repository's own pull requests (not forks) so branch names map to their merge state. */
export async function loadPullRequestsFromGitHub(repoRoot) {
  const stdout = await run("gh", [
    "pr", "list", "--state", "all", "--limit", "10000",
    "--json", "headRefName,headRefOid,state,isCrossRepository",
  ], repoRoot);
  return JSON.parse(stdout).filter((pullRequest) => !pullRequest.isCrossRepository);
}

/** Parses `git worktree list --porcelain -z`; the first record is always the main checkout. */
export function parseWorktreeList(porcelain) {
  const records = [];
  for (const line of porcelain.split("\0")) {
    if (line.startsWith("worktree ")) {
      records.push({ path: line.slice("worktree ".length), head: null, branch: null, bare: false, locked: false, prunable: false });
      continue;
    }
    const record = records.at(-1);
    if (!record) continue;
    const field = line.split(" ", 1)[0];
    if (line.startsWith("branch ")) record.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (line.startsWith("HEAD ")) record.head = line.slice("HEAD ".length);
    else if (line === "bare") record.bare = true;
    else if (field === "locked") record.locked = true;
    else if (field === "prunable") record.prunable = true;
  }
  return records;
}

/** Names the tool that made a worktree from where it lives. */
export function worktreeOrigin(worktreePath) {
  const path = worktreePath.replaceAll("\\", "/").toLowerCase();
  if (path.includes("/.claude/worktrees/")) return "Claude Agent tool";
  if (path.includes("/.mcode/worktrees/")) return "Mcode";
  if (path.includes("/.t3/worktrees/") || path.includes("/worktrees/t3/")) return "T3 Code";
  return "other";
}

function samePath(left, right) {
  const relative = NodePath.relative(NodePath.resolve(left), NodePath.resolve(right));
  return relative === "";
}

function isInside(root, candidate) {
  const relative = NodePath.relative(NodePath.resolve(root), NodePath.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}

async function readBranchTracking(repoRoot) {
  const stdout = await git(repoRoot, ["for-each-ref", "--format=%(refname)%00%(upstream)%00%(upstream:track)", "refs/heads"]);
  const tracking = new Map();
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const [refName, upstream, track] = line.split("\0");
    tracking.set(refName.replace(/^refs\/heads\//, ""), { upstream, gone: track === "[gone]" });
  }
  return tracking;
}

async function resolveBranchState(worktreePath, branch, pullRequestsByBranch, tracking) {
  if (!branch) return { branchState: "detached", mergedHeads: [] };
  const pullRequests = pullRequestsByBranch.get(branch) ?? [];
  if (pullRequests.some((pullRequest) => pullRequest.state === "OPEN")) return { branchState: "open", mergedHeads: [] };
  const mergedHeads = pullRequests.filter((pullRequest) => pullRequest.state === "MERGED").map((pullRequest) => pullRequest.headRefOid);
  for (const oid of mergedHeads) {
    if (await headIsMerged(worktreePath, oid)) return { branchState: "merged", mergedHeads };
  }
  const branchTracking = tracking.get(branch);
  if (branchTracking?.gone) return { branchState: "gone", mergedHeads };
  return { branchState: branchTracking?.upstream ? "unmerged" : "local", mergedHeads };
}

async function headIsMerged(worktreePath, oid) {
  try {
    await git(worktreePath, ["merge-base", "--is-ancestor", "HEAD", oid]);
    return true;
  } catch {
    return false;
  }
}

async function countUncommittedFiles(worktreePath) {
  const stdout = await git(worktreePath, ["status", "--porcelain", "--untracked-files=normal"]);
  return stdout.split(/\r?\n/).filter(Boolean).length;
}

async function commitExists(worktreePath, oid) {
  try {
    await git(worktreePath, ["cat-file", "-e", `${oid}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Counts commits that exist only in this checkout. A squash-merged branch whose remote
 * branch was deleted has commits on no remote ref, so the merged pull request's head
 * also counts as pushed: GitHub keeps that commit with the pull request.
 */
async function countUnpushedCommits(worktreePath, mergedHeads) {
  const pushedHeads = [];
  for (const oid of mergedHeads) {
    if (await commitExists(worktreePath, oid)) pushedHeads.push(`^${oid}`);
  }
  // `--not` flips every revision after it, so the explicit exclusions must come first.
  const stdout = await git(worktreePath, ["rev-list", "--count", "HEAD", ...pushedHeads, "--not", "--remotes"]);
  return Number.parseInt(stdout.trim(), 10);
}

function readLinkTarget(linkPath, rawTarget) {
  // Junctions read back as absolute `\\?\F:\...` paths; symlinks may be relative.
  const target = rawTarget.replace(/^\\\\\?\\/, "");
  return NodePath.resolve(NodePath.dirname(linkPath), target);
}

/**
 * Estimates the space removal would free, without following links. Files with more than
 * one hard link are left out, because deleting one name frees nothing while Bun's cache
 * holds another. Records every link whose target is outside the worktree, because
 * `git worktree remove` follows Windows junctions and would delete what they point at.
 * Nested worktrees are skipped: they are not part of this one and are listed on their own.
 */
async function scanWorktreeDirectory(root, nestedWorktrees) {
  const scan = { bytes: 0, outsideLinks: [], unreadableFolders: 0 };

  async function visit(directory) {
    let entries;
    try {
      entries = await NodeFS.promises.readdir(directory, { withFileTypes: true });
    } catch {
      scan.unreadableFolders += 1;
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const entryPath = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const target = readLinkTarget(entryPath, await NodeFS.promises.readlink(entryPath));
          if (!isInside(root, target)) scan.outsideLinks.push(entryPath);
        } catch {
          scan.outsideLinks.push(entryPath);
        }
        return;
      }
      if (entry.isDirectory()) {
        if (!nestedWorktrees.some((nested) => samePath(nested, entryPath))) await visit(entryPath);
        return;
      }
      try {
        // Read the size before adding: `scan.bytes += await ...` would add to a stale total.
        const { size, nlink } = await NodeFS.promises.lstat(entryPath);
        if (nlink === 1) scan.bytes += size;
      } catch {
        // A file deleted mid-scan only makes the size estimate smaller.
      }
    }));
  }

  await visit(root);
  return scan;
}

function errorMessage(error) {
  const text = error?.stderr?.toString().trim() || error?.message || String(error);
  return text.split(/\r?\n/)[0];
}

function checkoutKeepReasons(record) {
  const reasons = [];
  if (record.isMain) reasons.push("main checkout");
  if (record.isCurrent) reasons.push("this command runs from it");
  if (record.bare) reasons.push("bare repository");
  if (record.locked) reasons.push("locked");
  return reasons;
}

/** Counts the work only this checkout holds; a failed count keeps the worktree. */
async function inspectWork(worktreePath, mergedHeads) {
  const work = { uncommittedFiles: 0, unpushedCommits: 0, keepReasons: [] };
  try {
    work.uncommittedFiles = await countUncommittedFiles(worktreePath);
    if (work.uncommittedFiles > 0) work.keepReasons.push(`${work.uncommittedFiles} uncommitted files`);
  } catch (error) {
    work.keepReasons.push(`git status failed: ${errorMessage(error)}`);
  }
  try {
    work.unpushedCommits = await countUnpushedCommits(worktreePath, mergedHeads);
    if (work.unpushedCommits > 0) work.keepReasons.push(`${work.unpushedCommits} unpushed commits`);
  } catch (error) {
    work.keepReasons.push(`unpushed check failed: ${errorMessage(error)}`);
  }
  return work;
}

/** Sizes the directory and keeps it when deleting it would reach outside it. */
async function inspectDirectory(record, allPaths) {
  const keepReasons = [];
  const nestedWorktrees = allPaths.filter((path) => isInside(record.path, path));
  if (!record.isMain && nestedWorktrees.length > 0) keepReasons.push(`contains another worktree: ${nestedWorktrees[0]}`);
  const scan = await scanWorktreeDirectory(record.path, nestedWorktrees);
  if (scan.outsideLinks.length > 0) keepReasons.push(`links outside the worktree, such as ${scan.outsideLinks[0]}`);
  if (scan.unreadableFolders > 0) keepReasons.push(`${scan.unreadableFolders} folders could not be read to check for links`);
  return { bytes: scan.bytes, keepReasons };
}

async function inspectWorktree(record, context) {
  /** @type {WorktreeEntry} */
  const entry = {
    path: record.path,
    branch: record.branch,
    head: record.head,
    origin: worktreeOrigin(record.path),
    branchState: "detached",
    mergedHeads: [],
    uncommittedFiles: 0,
    unpushedCommits: 0,
    bytes: 0,
    keepReasons: checkoutKeepReasons(record),
  };
  if (record.prunable || !NodeFS.existsSync(record.path)) {
    entry.keepReasons.push("directory is missing; run git worktree prune");
    return entry;
  }

  const { branchState, mergedHeads } = await resolveBranchState(record.path, record.branch, context.pullRequestsByBranch, context.tracking);
  entry.branchState = branchState;
  entry.mergedHeads = mergedHeads;
  // The main checkout's branch is the default branch, which is never "merged", so a reason would mislead.
  if (!record.isMain && !REMOVABLE_BRANCH_STATES.has(branchState)) entry.keepReasons.push(BRANCH_STATE_REASONS[branchState]);

  const work = await inspectWork(record.path, mergedHeads);
  const directory = await inspectDirectory(record, context.allPaths);
  entry.uncommittedFiles = work.uncommittedFiles;
  entry.unpushedCommits = work.unpushedCommits;
  entry.bytes = directory.bytes;
  entry.keepReasons.push(...work.keepReasons, ...directory.keepReasons);
  return entry;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = Array.from({ length: items.length });
  let next = 0;
  async function drain() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
  return results;
}

/**
 * Inspects every worktree of the repository that `cwd` belongs to. A worktree is removable
 * when `keepReasons` is empty. When pull requests cannot be loaded, merged branches read as
 * unmerged, so the result only ever keeps more.
 *
 * @param {{ cwd?: string, loadPullRequests?: (repoRoot: string) => Promise<PullRequest[]>, warn?: (message: string) => void }} [options]
 * @returns {Promise<WorktreeEntry[]>}
 */
export async function listWorktrees({ cwd = process.cwd(), loadPullRequests = loadPullRequestsFromGitHub, warn = console.warn } = {}) {
  const currentRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const records = parseWorktreeList(await git(cwd, ["worktree", "list", "--porcelain", "-z"]));
  const mainRoot = records[0].path;

  let pullRequests = [];
  try {
    pullRequests = await loadPullRequests(mainRoot);
  } catch (error) {
    warn(`Could not load pull requests from GitHub (${errorMessage(error)}). Only branches whose remote branch is gone can be removed.`);
  }
  const pullRequestsByBranch = new Map();
  for (const pullRequest of pullRequests) {
    pullRequestsByBranch.set(pullRequest.headRefName, [...(pullRequestsByBranch.get(pullRequest.headRefName) ?? []), pullRequest]);
  }

  const context = {
    pullRequestsByBranch,
    tracking: await readBranchTracking(mainRoot),
    allPaths: records.map((record) => record.path),
  };
  return mapWithConcurrency(
    records.map((record, index) => ({ ...record, isMain: index === 0, isCurrent: samePath(record.path, currentRoot) })),
    INSPECT_CONCURRENCY,
    (record) => inspectWorktree(record, context),
  );
}

/**
 * Rechecks each removable worktree immediately before asking Git to remove it.
 *
 * @param {WorktreeEntry[]} entries
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<{ removed: WorktreeEntry[], failed: { entry: WorktreeEntry, error: string }[], skipped: { entry: WorktreeEntry, reason: string }[] }>}
 */
export async function removeWorktrees(entries, { cwd = process.cwd() } = {}) {
  const removed = [];
  const failed = [];
  const skipped = [];
  for (const entry of entries.filter((candidate) => candidate.keepReasons.length === 0)) {
    const reason = await removalSkipReason(entry, cwd);
    if (reason) {
      skipped.push({ entry, reason: `changed since inspection: ${reason}` });
      continue;
    }
    try {
      await git(cwd, ["worktree", "remove", entry.path]);
      removed.push(entry);
    } catch (error) {
      failed.push({ entry, error: errorMessage(error) });
    }
  }
  return { removed, failed, skipped };
}

async function removalSkipReason(entry, cwd) {
  try {
    const records = parseWorktreeList(await git(cwd, ["worktree", "list", "--porcelain", "-z"]));
    if (!records.some((record) => samePath(record.path, entry.path))) return "worktree is no longer listed";
    const head = (await git(entry.path, ["rev-parse", "HEAD"])).trim();
    if (head !== entry.head) return "HEAD moved";
    const branch = (await git(entry.path, ["symbolic-ref", "--short", "HEAD"])).trim();
    if (branch !== entry.branch) return "branch changed";
    if (await countUnpushedCommits(entry.path, entry.mergedHeads) > 0) return "unpushed commits";
    if (await countUncommittedFiles(entry.path) !== 0) return "uncommitted files";
    const directory = await inspectDirectory(entry, records.map((record) => record.path));
    return directory.keepReasons.join("; ");
  } catch (error) {
    return `recheck failed: ${errorMessage(error)}`;
  }
}

/** Formats bytes as gigabytes, the unit disk space is discussed in. */
export function formatGigabytes(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatEntry(entry) {
  const verdict = entry.keepReasons.length === 0 ? "REMOVE" : "KEEP  ";
  const branch = entry.branch ?? "(detached)";
  const reasons = entry.keepReasons.length === 0 ? "" : `  kept: ${entry.keepReasons.join("; ")}`;
  return `${verdict}  ${formatGigabytes(entry.bytes).padStart(9)}  ${entry.origin.padEnd(17)}  ${entry.branchState.padEnd(8)}  ${branch}  ${entry.path}${reasons}`;
}

/** Renders one line per worktree, removable ones first, then the space removal would free. */
export function formatReport(entries) {
  const sorted = [...entries].sort((left, right) =>
    (left.keepReasons.length === 0 ? 0 : 1) - (right.keepReasons.length === 0 ? 0 : 1) || right.bytes - left.bytes);
  const removable = entries.filter((entry) => entry.keepReasons.length === 0);
  const freeable = removable.reduce((total, entry) => total + entry.bytes, 0);
  const lines = [
    ...sorted.map(formatEntry),
    "",
    `${removable.length} of ${entries.length} worktrees can be removed, freeing ${formatGigabytes(freeable)}.`,
  ];
  if (removable.length > 0) lines.push("Remove them with: bun run agent:worktrees --remove");
  return lines.join("\n");
}

async function main(args) {
  const unknown = args.filter((arg) => arg !== "--remove");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}. Usage: bun run agent:worktrees [--remove]`);

  console.error("Inspecting worktrees. Sizing reads every file, so on a cold disk this can take several minutes.");
  const entries = await listWorktrees();
  console.log(formatReport(entries));
  if (!args.includes("--remove")) return;

  const { removed, failed, skipped } = await removeWorktrees(entries);
  console.log("");
  for (const entry of removed) console.log(`Removed ${entry.path} (${formatGigabytes(entry.bytes)})`);
  for (const { entry, reason } of skipped) console.log(`Skipped ${entry.path}: ${reason}`);
  for (const { entry, error } of failed) console.error(`Could not remove ${entry.path}: ${error}`);
  console.log(`Removed ${removed.length} worktrees, freeing ${formatGigabytes(removed.reduce((total, entry) => total + entry.bytes, 0))}.`);
  if (failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
