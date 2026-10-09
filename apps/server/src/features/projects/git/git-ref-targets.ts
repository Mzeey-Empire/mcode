import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import { z } from "zod";
import {
  GitRefSchema,
  DetachedWorktreeTargetSchema,
  type GitRef,
  type GitRefPurpose,
  type GitRefsListParams,
  type GitRefsListResult,
  type TargetWorktree,
} from "@mcode/contracts";

type Target = Extract<GitRefsListResult, { ok: true }>["items"][number];
type RefOptions = Omit<GitRefsListParams, "workspaceId" | "threadId">;

const rawRefSchema = z.tuple([
  z.string(), z.string(), z.string(), z.string(), z.string(), z.string(), z.string(),
]);

function pathKey(path: string): string {
  const resolved = NodePath.resolve(path);
  return NodePath.sep === "\\" ? resolved.toLowerCase() : resolved;
}

function targetWorktree(path: string): TargetWorktree {
  return { path, folder: NodePath.basename(path) };
}

function parseLinkedWorktrees(output: string) {
  // -z avoids Git's C-style quoting of paths containing whitespace or non-ASCII characters.
  return output.split("\0\0").slice(1).filter(Boolean).map((record) => {
    const fields = record.split("\0");
    const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    const head = fields.find((field) => field.startsWith("HEAD "))?.slice(5);
    const branch = fields.find((field) => field.startsWith("branch "))?.slice(7);
    if (!path || !head) throw new Error("Invalid git worktree listing");
    return { path, head, branch, detached: fields.includes("detached") };
  });
}

function parseRefs(output: string, contextPath: string, linkedPaths: ReadonlySet<string>): GitRef[] {
  const contextKey = pathKey(NodeFS.realpathSync.native(contextPath));
  const rows = output.split("\n").filter(Boolean).map((line) => rawRefSchema.parse(line.replace(/\r$/, "").split("\0")));
  const defaultRef = rows.find(([fullName]) => fullName === "refs/remotes/origin/HEAD")?.[6];
  const localDefault = defaultRef?.replace(/^refs\/remotes\/origin\//, "refs/heads/");
  return rows.filter(([fullName, , , , , , symref]) => !(fullName.endsWith("/HEAD") && symref))
    .map(([fullName, shortName, headSha, head, worktreePath, committedAt]) => {
      const remoteMatch = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(fullName);
      const otherLinked = worktreePath && linkedPaths.has(pathKey(worktreePath))
        && pathKey(worktreePath) !== contextKey;
      return GitRefSchema().parse({
        kind: "ref", fullName, shortName, headSha,
        branchName: remoteMatch?.[2] ?? fullName.slice("refs/heads/".length),
        remote: remoteMatch?.[1] ?? null,
        twin: null,
        isCurrent: head === "*",
        isDefault: fullName === defaultRef || fullName === localDefault,
        worktree: otherLinked ? targetWorktree(worktreePath) : null,
        committedAt: new Date(committedAt).toISOString(),
      });
    });
}

const purposeFilters: Record<GitRefPurpose, (
  refs: GitRef[], options: RefOptions, linkedBranches: ReadonlySet<string>,
) => GitRef[]> = {
  "new-thread": (refs) => {
    const locals = new Set(refs.filter((ref) => ref.remote === null).map((ref) => ref.branchName));
    const names = new Set(refs.map((ref) => ref.fullName));
    return refs.filter((ref) => ref.remote === null || !locals.has(ref.branchName)).map((ref) => {
      const twin = `refs/remotes/origin/${ref.branchName}`;
      return { ...ref, twin: ref.remote === null && names.has(twin) ? twin : null };
    });
  },
  "existing-worktree": (refs, _options, linkedBranches) => refs.filter((ref) => linkedBranches.has(ref.fullName)),
  review: (refs, options) => refs.filter((ref) => options.side === "local" ? ref.remote === null : ref.remote !== null),
};

function targetSortKey(target: Target, purpose: GitRefPurpose) {
  if (target.kind === "detached-worktree") {
    return { default: 1, current: 1, remote: 0, timestamp: 0, name: target.worktree.path };
  }
  return {
    default: Number(!target.isDefault), current: Number(!target.isCurrent),
    remote: purpose === "new-thread" ? Number(target.remote !== null) : 0,
    timestamp: Date.parse(target.committedAt), name: target.fullName,
  };
}

function compareTargets(a: Target, b: Target, purpose: GitRefPurpose): number {
  const left = targetSortKey(a, purpose);
  const right = targetSortKey(b, purpose);
  return left.default - right.default || left.current - right.current || left.remote - right.remote
    || right.timestamp - left.timestamp || compareNames(left.name, right.name);
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

function readOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^refs:(0|[1-9][0-9]*)$/.exec(decoded);
  const offset = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(offset) || Buffer.from(decoded).toString("base64url") !== cursor) {
    throw new Error("Invalid ref cursor");
  }
  return offset;
}

/** Parse Git output, apply the purpose and query, and page the single sorted target list. */
export function buildRefPage(
  refsOutput: string, worktreeOutput: string, contextPath: string, options: RefOptions,
): GitRefsListResult {
  const linked = parseLinkedWorktrees(worktreeOutput);
  const paths = new Set(linked.map((worktree) => pathKey(worktree.path)));
  const refs = parseRefs(refsOutput, contextPath, paths);
  const linkedBranches = new Set(linked.flatMap((worktree) => worktree.branch ? [worktree.branch] : []));
  const targets: Target[] = purposeFilters[options.purpose](refs, options, linkedBranches);
  if (options.purpose === "existing-worktree") {
    targets.push(...linked.filter((worktree) => worktree.detached).map((worktree) =>
      DetachedWorktreeTargetSchema().parse({
        kind: "detached-worktree", worktree: targetWorktree(worktree.path), headShortSha: worktree.head.slice(0, 7),
      })));
  }
  const query = options.query?.trim().toLowerCase() ?? "";
  const matches = targets.filter((target) =>
    (target.kind === "ref" && target.shortName.toLowerCase().includes(query))
    || (target.worktree?.folder.toLowerCase().includes(query) ?? false));
  matches.sort((a, b) => compareTargets(a, b, options.purpose));
  const offset = readOffset(options.cursor);
  const items = matches.slice(offset, offset + (options.limit ?? 50));
  const nextOffset = offset + items.length;
  return {
    ok: true, items, total: matches.length,
    nextCursor: nextOffset < matches.length ? Buffer.from(`refs:${nextOffset}`).toString("base64url") : null,
  };
}
