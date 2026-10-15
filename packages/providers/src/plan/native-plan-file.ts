import * as NodeCrypto from "node:crypto";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { PLAN_MAX_CONTENT_CHARS, type NativePlanFileOutcome, type NativePlanFileRef } from "@mcode/contracts";

type Skipped = Extract<NativePlanFileOutcome, { outcome: "skipped" }>;
type PlanLocation = { path: string; planRoot: string; sessionId: string };
type PlanRead = { ref: NativePlanFileRef; text: string };
const PLAN_MAX_CONTENT_BYTES = PLAN_MAX_CONTENT_CHARS * 4;

function skipped(reason: Skipped["reason"]): Skipped { return { outcome: "skipped", reason }; }

/** path.relative folds case only where the file system does, so this is the platform's own equality. */
function samePath(left: string, right: string): boolean {
  return NodePath.relative(left, right) === "";
}

function isInside(root: string, path: string): boolean {
  const suffix = NodePath.relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(suffix);
}

function fileFailure(error: unknown): Skipped {
  if (error instanceof Error && "code" in error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return skipped("no-file");
    if (error.code === "ELOOP") return skipped("unsafe-path");
    if (["EACCES", "EPERM", "EBUSY", "EEXIST", "EROFS", "ENOSPC", "EDQUOT", "EISDIR", "ENOTEMPTY", "ETXTBSY"].includes(String(error.code))) return skipped("unproven");
  }
  throw error;
}

async function validatePath(path: string, planRoot: string): Promise<Skipped | null> {
  if (!NodePath.isAbsolute(path) || !NodePath.isAbsolute(planRoot) || !isInside(planRoot, path)) return skipped("unsafe-path");
  const root = await NodeFSPromises.realpath(planRoot);
  let ancestor = NodePath.dirname(path);
  while (true) {
    if ((await NodeFSPromises.lstat(ancestor)).isSymbolicLink()) return skipped("unsafe-path");
    if (NodePath.relative(planRoot, ancestor) === "") break;
    ancestor = NodePath.dirname(ancestor);
  }
  const parent = await NodeFSPromises.realpath(NodePath.dirname(path));
  if (NodePath.relative(root, parent) !== "" && !isInside(root, parent)) return skipped("unsafe-path");
  return null;
}

/** Allows only the adapter's exact plan target, including its first creation. */
export async function canWriteNativePlanFile(input: { path: string; expectedPath: string }): Promise<boolean> {
  if (!NodePath.isAbsolute(input.path) || !NodePath.isAbsolute(input.expectedPath) || !samePath(input.path, input.expectedPath)) return false;
  try {
    if (await validatePath(input.path, NodePath.dirname(input.expectedPath))) return false;
    try {
      const stat = await NodeFSPromises.lstat(input.path);
      return stat.isFile() && stat.nlink === 1;
    }
    catch (error) { return fileFailure(error).reason === "no-file"; }
  } catch (error) {
    fileFailure(error);
    return false;
  }
}

/**
 * The CLI may report the plan through a symlinked or differently cased config directory, so the
 * path is rebased onto the canonical session root before it must be exactly that session's `plan.md`.
 */
async function locatePlan(input: PlanLocation): Promise<{ root: string; path: string } | Skipped> {
  const root = await NodeFSPromises.realpath(input.planRoot);
  const path = NodePath.isAbsolute(input.path) && isInside(input.planRoot, input.path) ? NodePath.join(root, NodePath.relative(input.planRoot, input.path)) : input.path;
  if (!samePath(path, NodePath.join(root, "plan.md"))) return skipped("unsafe-path");
  return await validatePath(path, root) ?? { root, path };
}

async function readPlan(input: PlanLocation): Promise<PlanRead | Skipped> {
  try {
    const located = await locatePlan(input);
    if ("outcome" in located) return located;
    const stat = await NodeFSPromises.lstat(located.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) return skipped("unsafe-path");
    const real = await NodeFSPromises.realpath(located.path);
    if (!isInside(located.root, real)) return skipped("unsafe-path");
    if (stat.size > PLAN_MAX_CONTENT_BYTES) return skipped("unproven");
    const bytes = await readPlanBytes(real);
    if ("outcome" in bytes) return bytes;
    return { ref: { path: real, sessionId: input.sessionId, sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex") }, text: bytes.toString("utf8") };
  } catch (error) { return fileFailure(error); }
}

async function readPlanBytes(path: string): Promise<Buffer | Skipped> {
  const file = await NodeFSPromises.open(path, "r");
  try {
    const bytes = Buffer.alloc(PLAN_MAX_CONTENT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > PLAN_MAX_CONTENT_BYTES || bytes.toString("utf8", 0, length).length > PLAN_MAX_CONTENT_CHARS) return skipped("unproven");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

/**
 * Captures file identity only after proving containment and reading bounded bytes. The file must
 * still hold `markdown`, the text the CLI reported, so a later rewrite never replaces bytes Mcode did not store.
 */
export async function captureNativePlanFile(input: PlanLocation & { markdown: string }): Promise<NativePlanFileRef | null> {
  const result = await readPlan(input);
  return "outcome" in result || result.text !== input.markdown ? null : result.ref;
}

/** Rewrites only a session-owned file whose bytes still match the captured digest. */
export async function rewriteNativePlanFile(input: {
  planRoot: string; sessionId: string; nativePlanFile: NativePlanFileRef | null; markdown: string;
}): Promise<NativePlanFileOutcome> {
  const ref = input.nativePlanFile;
  if (!ref) return skipped("no-file");
  if (ref.sessionId !== input.sessionId) return skipped("unproven");
  const current = await readPlan({ path: ref.path, planRoot: input.planRoot, sessionId: input.sessionId });
  if ("outcome" in current) return current;
  if (current.ref.sha256 !== ref.sha256) return skipped("changed");
  if (input.markdown.length > PLAN_MAX_CONTENT_CHARS || Buffer.byteLength(input.markdown) > PLAN_MAX_CONTENT_BYTES) return skipped("unproven");
  const temporary = NodePath.join(NodePath.dirname(current.ref.path), `.mcode-plan-${NodeCrypto.randomUUID()}.tmp`);
  try {
    // The rename swaps the inode, so the original permissions are carried over explicitly.
    const { mode } = await NodeFSPromises.lstat(current.ref.path);
    await NodeFSPromises.writeFile(temporary, input.markdown, { flag: "wx", mode: mode & 0o777 });
    const checked = await readPlan({ path: ref.path, planRoot: input.planRoot, sessionId: input.sessionId });
    if ("outcome" in checked) return checked;
    if (checked.ref.sha256 !== ref.sha256) return skipped("changed");
    await NodeFSPromises.rename(temporary, current.ref.path);
    return { outcome: "synced" };
  } catch (error) {
    return fileFailure(error);
  } finally {
    await NodeFSPromises.rm(temporary, { force: true });
  }
}
