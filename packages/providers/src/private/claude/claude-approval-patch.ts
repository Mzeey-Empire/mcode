import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { z } from "zod";
import { createTextPatch } from "@mcode/shared";
import type { ApprovalSubject } from "@mcode/contracts/models/approval";
import { approvalPatch } from "../../approval-patch.js";

const EditSchema = z.object({ old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() });
const EditsSchema = z.array(EditSchema);
const MAX_FILE_BYTES = 1_048_576;
type FilePatch = Extract<ApprovalSubject, { kind: "file_edit" }>["files"][number];

function isInside(root: string, target: string): boolean {
  const relative = NodePath.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative);
}

async function readBefore(cwd: string, file: string): Promise<{ text: string; missing: boolean } | undefined> {
  const root = await NodeFSPromises.realpath(cwd);
  const target = NodePath.resolve(root, file);
  if (!isInside(root, target)) return undefined;
  let canonical: string;
  try { canonical = await NodeFSPromises.realpath(target); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = await existingParent(NodePath.dirname(target));
    return isInside(root, parent) ? { text: "", missing: true } : undefined;
  }
  if (!isInside(root, canonical)) return undefined;
  return readBoundedFile(canonical);
}

async function existingParent(directory: string): Promise<string> {
  try { return await NodeFSPromises.realpath(directory); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    return existingParent(NodePath.dirname(directory));
  }
}

async function readBoundedFile(file: string): Promise<{ text: string; missing: false } | undefined> {
  const handle = await NodeFSPromises.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > MAX_FILE_BYTES ? undefined : { text: buffer.toString("utf8", 0, length), missing: false };
  } finally { await handle.close(); }
}

/** Build optional preview evidence; an unavailable file must not prevent answering the approval. */
export async function claudeFilePatch(toolName: string, input: Record<string, unknown>, file: string, cwd: string | undefined): Promise<FilePatch> {
  const base: FilePatch = { path: file, change: "edited", additions: 0, deletions: 0 };
  const patchPath = (cwd ? NodePath.relative(cwd, NodePath.resolve(cwd, file)) : file).replaceAll("\\", "/");
  if (toolName === "Edit") {
    const edit = EditSchema.safeParse(input);
    if (edit.success) return edit.data.replace_all && cwd
      ? fullFilePatch(toolName, input, base, cwd, patchPath)
      : { ...base, ...approvalPatch(createTextPatch(patchPath, edit.data.old_string, edit.data.new_string)) };
  }
  if (!cwd || (toolName !== "Write" && toolName !== "MultiEdit")) return base;
  return fullFilePatch(toolName, input, base, cwd, patchPath);
}

async function fullFilePatch(toolName: string, input: Record<string, unknown>, base: FilePatch, cwd: string, patchPath: string): Promise<FilePatch> {
  let before: Awaited<ReturnType<typeof readBefore>>;
  try { before = await readBefore(cwd, base.path); }
  catch { return { ...base, patchTruncated: true }; }
  if (!before) return { ...base, patchTruncated: true };
  const after = proposedText(toolName, input, before.text);
  if (after === undefined) return { ...base, patchTruncated: true };
  const change = before.missing ? "added" : "edited";
  return { ...base, change, ...approvalPatch(createTextPatch(patchPath, before.text, after, change)) };
}

function proposedText(toolName: string, input: Record<string, unknown>, before: string): string | undefined {
  if (toolName === "Write") return typeof input.content === "string" ? input.content : undefined;
  const edits = EditsSchema.safeParse(toolName === "Edit" ? [input] : input.edits);
  if (!edits.success) return undefined;
  return replaceEdits(before, edits.data);
}

function replaceEdits(before: string, edits: z.infer<typeof EditsSchema>): string | undefined {
  let after = before;
  for (const edit of edits) {
    const result = replaceEdit(after, edit);
    if (result === undefined) return undefined;
    after = result;
  }
  return after;
}

function replaceEdit(before: string, edit: z.infer<typeof EditSchema>): string | undefined {
  if (!edit.old_string) return undefined;
  const occurrences = before.split(edit.old_string).length - 1;
  if (occurrences === 0 || (!edit.replace_all && occurrences !== 1)) return undefined;
  const size = before.length + occurrences * (edit.new_string.length - edit.old_string.length);
  if (size > MAX_FILE_BYTES) return undefined;
  return before.replaceAll(edit.old_string, () => edit.new_string);
}
