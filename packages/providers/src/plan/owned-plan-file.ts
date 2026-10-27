import * as NodeCrypto from "node:crypto";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { PLAN_MAX_CONTENT_CHARS, type NativePlanFileOutcome } from "@mcode/contracts/models/plan";
import { type NativePlanFileRef } from "@mcode/contracts/providers/interfaces";

type SkippedFile = Extract<NativePlanFileOutcome, { outcome: "skipped" }>;

/** Validated bytes and session evidence for a provider-named plan file. */
export type NativePlanFileCapture = {
  outcome: "captured";
  markdown: string;
  nativePlanFile: NativePlanFileRef;
};

function isInside(root: string, path: string): boolean {
  const relative = NodePath.relative(root, path);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${NodePath.sep}`)
    && !NodePath.isAbsolute(relative);
}

function fileFailure(error: unknown): SkippedFile {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return { outcome: "skipped", reason: "no-file" };
  }
  return { outcome: "skipped", reason: "unsafe-path" };
}

/** Read one explicitly named file; the adapter supplies ownership and its trusted plan root. */
export async function captureOwnedPlanFile(input: {
  path: string; planRoot: string; sessionId: string;
}): Promise<NativePlanFileCapture | SkippedFile> {
  if (!input.sessionId) return { outcome: "skipped", reason: "unproven" };
  if (!NodePath.isAbsolute(input.path) || !NodePath.isAbsolute(input.planRoot)
    || !isInside(input.planRoot, input.path)) return { outcome: "skipped", reason: "unsafe-path" };
  try {
    return await readPlanFile(input);
  } catch (error) {
    return fileFailure(error);
  }
}

async function readPlanFile(input: {
  path: string; planRoot: string; sessionId: string;
}): Promise<NativePlanFileCapture | SkippedFile> {
  const stat = await NodeFSPromises.lstat(input.path);
  const realPlanRoot = await NodeFSPromises.realpath(input.planRoot);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PLAN_MAX_CONTENT_CHARS
    || !isInside(realPlanRoot, await NodeFSPromises.realpath(input.path))) {
    return { outcome: "skipped", reason: "unsafe-path" };
  }
  const file = await NodeFSPromises.open(input.path, "r");
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      return { outcome: "skipped", reason: "unsafe-path" };
    }
    const bytes = await readBoundedBytes(file);
    if (bytes.length > PLAN_MAX_CONTENT_CHARS) return { outcome: "skipped", reason: "unsafe-path" };
    return { outcome: "captured", markdown: bytes.toString("utf8"), nativePlanFile: {
      path: input.path, sessionId: input.sessionId,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    } };
  } finally {
    await file.close();
  }
}

async function readBoundedBytes(file: NodeFSPromises.FileHandle): Promise<Buffer> {
  const buffer = Buffer.alloc(PLAN_MAX_CONTENT_CHARS + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

/** Delete only the named, still-safe file whose bytes match the captured reference. */
export async function deleteOwnedPlanFile(input: {
  nativePlanFile: NativePlanFileRef; planRoot: string; sessionId: string;
}): Promise<NativePlanFileOutcome> {
  if (!input.sessionId || input.nativePlanFile.sessionId !== input.sessionId) {
    return { outcome: "skipped", reason: "unproven" };
  }
  const capture = await captureOwnedPlanFile({ ...input, path: input.nativePlanFile.path });
  if (capture.outcome === "skipped") return capture;
  if (capture.nativePlanFile.sha256 !== input.nativePlanFile.sha256) {
    return { outcome: "skipped", reason: "changed" };
  }
  try {
    await NodeFSPromises.unlink(input.nativePlanFile.path);
    return { outcome: "deleted" };
  } catch (error) {
    return fileFailure(error);
  }
}
