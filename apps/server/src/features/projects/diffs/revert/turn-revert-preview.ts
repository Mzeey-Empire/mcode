import * as NodeFSPromises from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import type { RevertFilePlan, TurnRevertPreview, TurnRevertScope } from "@mcode/contracts";
import type { SnapshotService } from "../snapshots/snapshot-service.js";
import type { TurnSnapshotRangeReader } from "../snapshots/turn-snapshot-range.js";
import type { TurnSnapshotRange } from "../snapshots/turn-snapshot-range-model.js";
import { rawGit, rawPath } from "../snapshots/snapshot-raw-state.js";
import type { SnapshotBlob } from "../snapshots/snapshot-checkout.js";
import { TurnRevertValidationError } from "./turn-revert-model.js";

/** The preview's target is always a whole logical turn or range. */
export interface RevertPreviewInput { threadId: string; messageId: string; scope: TurnRevertScope }
/** Shared evidence supplied by the service and application runtime. */
export interface RevertPreviewDeps {
  snapshots: SnapshotService;
  ranges: TurnSnapshotRangeReader;
  resolveCwd(threadId: string, worktreePath?: string | null): string;
  busy(cwd: string): Promise<boolean>;
  laterPaths(cwd: string, range: ReadyRevertRange): Promise<Set<string>>;
}
/** Complete snapshot range, never a shortened set of attempts. */
export type ReadyRevertRange = Extract<TurnSnapshotRange, { status: "ready" }>;
/** Internal evidence kept separate from the exact public union. */
export type PreparedPreview = { preview: Extract<TurnRevertPreview, { status: "ready" }>; cwd: string; range: ReadyRevertRange }
  | { preview: Exclude<TurnRevertPreview, { status: "ready" }>; cwd?: never; range?: never };

/** Validate order using independent turn membership, then read refs only through turnSnapshotRange. */
export function revertRange(ranges: TurnSnapshotRangeReader, input: RevertPreviewInput) {
  const from = input.scope.kind === "file" ? input.scope.fromMessageId : undefined;
  if (from) {
    const turns = ranges.listTurns(input.threadId);
    const start = turns.findIndex((turn) => turn.messageIds.includes(from));
    const end = turns.findIndex((turn) => turn.messageIds.includes(input.messageId));
    if (start >= 0 && end >= 0 && start > end) throw new TurnRevertValidationError("fromMessageId is after messageId");
  }
  return ranges.turnSnapshotRange(input.threadId, input.messageId, from);
}

/** Preview through filtered Git classification, with a precondition over raw worktree evidence. */
export async function preparePreview(deps: RevertPreviewDeps, input: RevertPreviewInput): Promise<PreparedPreview> {
  const range = revertRange(deps.ranges, input);
  const location = deps.resolveCwd(input.threadId, range.status === "ready" ? range.rows[0].worktree_path : null);
  const repository = await resolveRepository(location);
  if (repository.status !== "ready") return { preview: repository };
  const { cwd, identity } = repository;
  if (range.status !== "ready") return { preview: { status: "unavailable", reason: "snapshot_missing" } };
  if (await deps.busy(cwd)) return { preview: { status: "busy", reason: "turn_running" } };
  if (!await deps.snapshots.validateRef(cwd, range.refBefore) || !await deps.snapshots.validateRef(cwd, range.refAfter)) return { preview: { status: "unavailable", reason: "snapshot_pruned" } };
  return previewRange(deps, input, cwd, identity, range);
}

async function resolveRepository(location: string): Promise<{ status: "ready"; cwd: string; identity: string } | Extract<TurnRevertPreview, { status: "unavailable" }>> {
  let cwd: string;
  try { cwd = await NodeFSPromises.realpath(location); }
  catch (error) { if (isMissing(error)) return { status: "unavailable", reason: "worktree_missing" }; throw error; }
  let identity: string;
  try { identity = (await rawGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString().trim(); }
  catch (error) { if (error instanceof Error && error.message.includes("not a git repository")) return { status: "unavailable", reason: "not_git" }; throw error; }
  return { status: "ready", cwd, identity };
}

async function previewRange(deps: RevertPreviewDeps, input: RevertPreviewInput, cwd: string, identity: string, range: ReadyRevertRange): Promise<PreparedPreview> {
  const groups = [...range.pathGroups, ...await renameLinks(cwd, range)];
  const paths = closedPaths(range, input.scope, groups);
  if (!paths.length) return { preview: { status: "unavailable", reason: "no_attributed_files" } };
  paths.forEach((name) => rawPath(cwd, name));
  if (paths.length > 512) throw new TurnRevertValidationError("Revert is limited to 512 paths");
  const preview = await classifyPaths(deps, cwd, range, paths, groups);
  if (preview.files.every((file) => file.state === "already_reverted") && !preview.skipped.length) return { preview: { status: "nothing_to_revert" } };
  const raw = await deps.snapshots.workingTreeState(cwd, paths);
  const previewToken = NodeCrypto.createHash("sha256").update(JSON.stringify([identity, cwd, range.rows.map((row) => row.id), input.scope,
    paths.map((name) => [name, raw.get(name)])])).digest("hex");
  return { cwd, range, preview: { status: "ready", previewToken, ...preview } };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function renameLinks(cwd: string, range: ReadyRevertRange): Promise<string[][]> {
  const fields = (await rawGit(cwd, ["diff", "--name-status", "-z", "-M", "--diff-filter=R", range.refBefore, range.refAfter])).toString().split("\0");
  const links: string[][] = [];
  for (let index = 0; index < fields.length - 2; index += 3) {
    const before = fields[index + 1], after = fields[index + 2];
    if (before && after) links.push([before, after]);
  }
  return links;
}

function closedPaths(range: ReadyRevertRange, scope: TurnRevertScope, groups: string[][]): string[] {
  const all = new Set(range.paths);
  // A fallback rename may name only its destination; its source is a valid equivalent file scope.
  for (const group of groups) if (group.some((name) => all.has(name))) group.forEach((name) => all.add(name));
  if (scope.kind === "file" && !all.has(scope.path)) throw new TurnRevertValidationError("File is not attributed to this range");
  const selected = new Set(scope.kind === "file" ? [scope.path] : range.paths);
  let size = -1;
  while (size !== selected.size) {
    size = selected.size;
    for (const group of groups) if (group.some((name) => selected.has(name))) group.forEach((name) => selected.add(name));
  }
  return [...selected].sort();
}

function sameBlob(a: SnapshotBlob | null | undefined, b: SnapshotBlob | null | undefined): boolean {
  return (a?.blob ?? null) === (b?.blob ?? null) && (a?.mode ?? null) === (b?.mode ?? null);
}

async function ignoredPaths(cwd: string, paths: string[]): Promise<Set<string>> {
  try { return new Set((await rawGit(cwd, ["check-ignore", "--no-index", "-z", "--stdin"], `${paths.join("\0")}\0`)).toString().split("\0").filter(Boolean)); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === 1) return new Set(); throw error; }
}

async function folderObstructs(cwd: string, name: string, scope: Set<string>): Promise<boolean> {
  const entries = await NodeFSPromises.readdir(rawPath(cwd, name), { withFileTypes: true });
  for (const entry of entries) {
    const child = `${name}/${entry.name}`;
    if (entry.isDirectory()) { if (await folderObstructs(cwd, child, scope)) return true; }
    else if (!scope.has(child)) return true;
  }
  return false;
}

async function classifyPaths(deps: RevertPreviewDeps, cwd: string, range: ReadyRevertRange, paths: string[], groups: string[][]) {
  const before = await deps.snapshots.blobIdsAt(cwd, range.refBefore, paths);
  const after = await deps.snapshots.blobIdsAt(cwd, range.refAfter, paths);
  const skipped = await skippedPaths(deps, cwd, paths, before, after);
  const allowed = paths.filter((name) => !skipped.some((entry) => name === entry.path || name.startsWith(`${entry.path}/`)));
  const current = await deps.snapshots.currentBlobIds(cwd, range.refAfter, allowed);
  const later = await deps.laterPaths(cwd, range);
  const files: RevertFilePlan[] = [];
  for (const name of allowed) {
    const prior = before.get(name), now = current.get(name);
    const state = sameBlob(now, prior) ? "already_reverted" : sameBlob(now, after.get(name)) ? "clean" : "changed_later";
    const component = closedPaths({ ...range, paths }, { kind: "file", path: name }, groups);
    files.push(await pathPlan({ cwd, name, prior, now, after: after.get(name), state, later, previousPath: renameSource(name, component, before, after) }));
  }
  const changed = range.rows.some((row) => row.file_effects)
    ? await deps.snapshots.getFilesChanged(cwd, range.refBefore, range.refAfter) : [];
  return { files, skipped, unattributedChangeCount: changed.filter((name) => !range.paths.includes(name) && !paths.includes(name)).length };
}

function renameSource(name: string, component: string[], before: Map<string, SnapshotBlob | null>, after: Map<string, SnapshotBlob | null>) {
  if (before.get(name)) return undefined;
  return component.find((other) => other !== name && before.get(other) && !after.get(other));
}

async function pathPlan(input: { cwd: string; name: string; prior: SnapshotBlob | null | undefined; now: SnapshotBlob | null | undefined;
  after: SnapshotBlob | null | undefined; state: RevertFilePlan["state"]; later: Set<string>; previousPath: string | undefined }): Promise<RevertFilePlan> {
  const { name, prior, now, state, previousPath } = input;
  const blob = prior ?? input.after;
  const binary = blob && blob.mode !== "040000" ? (await rawGit(input.cwd, ["cat-file", "blob", blob.blob])).includes(0) : false;
  const plan: RevertFilePlan = { path: name, action: !prior ? "delete" : !now ? "recreate" : "restore", state, binary };
  if (previousPath) plan.previousPath = previousPath;
  if (state === "changed_later") plan.changedBy = input.later.has(name) ? "later_turn" : "outside";
  return plan;
}

async function skippedPaths(deps: RevertPreviewDeps, cwd: string, paths: string[], before: Map<string, SnapshotBlob | null>, after: Map<string, SnapshotBlob | null>) {
  const raw = await deps.snapshots.workingTreeState(cwd, paths);
  const ignored = await ignoredPaths(cwd, paths);
  const skipped: Extract<TurnRevertPreview, { status: "ready" }>["skipped"] = [];
  for (const name of paths) {
    const reason = await skipReason(cwd, name, { before: before.get(name)?.mode, after: after.get(name)?.mode,
      kind: raw.get(name)?.kind, ignored: ignored.has(name), scope: new Set(paths) });
    if (reason) skipped.push({ path: name, reason });
  }
  return skipped;
}

async function skipReason(cwd: string, name: string, state: { before?: string; after?: string; kind?: string; ignored: boolean; scope: Set<string> }) {
  if (state.ignored) return "ignored";
  if (state.before === "160000" || state.after === "160000") return "submodule";
  if (state.before && state.before !== "040000" && state.kind === "directory" && await folderObstructs(cwd, name, state.scope)) return "folder_in_the_way";
  return null;
}
