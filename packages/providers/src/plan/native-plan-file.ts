import * as NodeCrypto from "node:crypto";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { PLAN_MAX_CONTENT_CHARS, type NativePlanFileOutcome, type NativePlanFileRef } from "@mcode/contracts";

type FileRead = { outcome: "read"; sha256: string; realPath: string } | Extract<NativePlanFileOutcome, { outcome: "skipped" }>;

/** Check absolute lexical containment; file validation must also check resolved paths. */
export function isNativePlanFilePath(path: string, roots: readonly string[]): boolean {
  if (!NodePath.isAbsolute(path)) return false;
  return roots.some(root => {
    if (!NodePath.isAbsolute(root)) return false;
    const relative = NodePath.relative(root, path);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative);
  });
}

function fileFailure(error: unknown): Extract<NativePlanFileOutcome, { outcome: "skipped" }> {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return { outcome: "skipped", reason: "no-file" };
  }
  return { outcome: "skipped", reason: "unsafe-path" };
}

async function readPlanFile(path: string, roots: readonly string[]): Promise<FileRead> {
  try {
    if (!isNativePlanFilePath(path, roots)) return { outcome: "skipped", reason: "unsafe-path" };
    const stat = await NodeFSPromises.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PLAN_MAX_CONTENT_CHARS) {
      return { outcome: "skipped", reason: "unsafe-path" };
    }
    const realPath = await NodeFSPromises.realpath(path);
    const realRoots = await Promise.all(roots.filter(NodePath.isAbsolute).map(root =>
      NodeFSPromises.realpath(root).catch(() => root)));
    if (!isNativePlanFilePath(realPath, realRoots)) return { outcome: "skipped", reason: "unsafe-path" };
    const file = await NodeFSPromises.open(realPath, "r");
    try {
      const opened = await file.stat();
      if (opened.ino !== stat.ino || opened.dev !== stat.dev) return { outcome: "skipped", reason: "unsafe-path" };
      return await hashPlanFile(file, realPath);
    } finally {
      await file.close();
    }
  } catch (error) {
    return fileFailure(error);
  }
}

async function hashPlanFile(file: NodeFSPromises.FileHandle, realPath: string): Promise<FileRead> {
  const bytes = Buffer.alloc(PLAN_MAX_CONTENT_CHARS + 1);
  let length = 0;
  while (length < bytes.length) {
    const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length > PLAN_MAX_CONTENT_CHARS) return { outcome: "skipped", reason: "unsafe-path" };
  return { outcome: "read", sha256: NodeCrypto.createHash("sha256").update(bytes.subarray(0, length)).digest("hex"), realPath };
}

/** Validate and hash an exact path whose session ownership the adapter has proved. */
export async function captureNativePlanFile(input: {
  path: string; sessionId: string; roots: readonly string[];
}): Promise<NativePlanFileRef | undefined> {
  const file = await readPlanFile(input.path, input.roots);
  if (file.outcome !== "read") return undefined;
  return { path: input.path, sessionId: input.sessionId, sha256: file.sha256 };
}

/** Replace a proved, unchanged plan through a same-directory rename; refusals leave it untouched. */
export async function syncNativePlanFile(input: {
  nativePlanFile: NativePlanFileRef | null; roots: readonly string[]; markdown: string;
}): Promise<NativePlanFileOutcome> {
  const ref = input.nativePlanFile;
  if (!ref) return { outcome: "skipped", reason: "unproven" };
  const file = await readPlanFile(ref.path, input.roots);
  if (file.outcome !== "read") return file;
  if (file.sha256 !== ref.sha256) return { outcome: "skipped", reason: "changed" };
  if (Buffer.byteLength(input.markdown, "utf8") > PLAN_MAX_CONTENT_CHARS) return { outcome: "skipped", reason: "unsafe-path" };
  return await replacePlanFile(ref, file.realPath, input.roots, input.markdown);
}

async function replacePlanFile(ref: NativePlanFileRef, realPath: string, roots: readonly string[], markdown: string): Promise<NativePlanFileOutcome> {
  const temporaryPath = NodePath.join(NodePath.dirname(realPath), `.mcode-plan-${NodeCrypto.randomUUID()}.tmp`);
  let created = false;
  let outcome: NativePlanFileOutcome;
  try {
    const temporaryFile = await NodeFSPromises.open(temporaryPath, "wx", 0o600);
    created = true;
    try {
      await temporaryFile.writeFile(markdown);
    } finally {
      await temporaryFile.close();
    }
    const current = await readPlanFile(ref.path, roots);
    if (current.outcome !== "read") outcome = current;
    else if (current.realPath !== realPath) outcome = { outcome: "skipped", reason: "unsafe-path" };
    else if (current.sha256 !== ref.sha256) outcome = { outcome: "skipped", reason: "changed" };
    else {
      await NodeFSPromises.rename(temporaryPath, realPath);
      created = false;
      outcome = { outcome: "synced" };
    }
  } catch (error) {
    outcome = fileFailure(error);
  }
  if (created) {
    try {
      await NodeFSPromises.rm(temporaryPath, { force: true });
    } catch (error) {
      return fileFailure(error);
    }
  }
  return outcome;
}
