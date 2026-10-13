import type { ApprovalRequestBody, ApprovalSubject } from "@mcode/contracts";
import { z } from "zod";
import { createTextPatch } from "@mcode/shared";
import { approvalPatch } from "../../approval-patch.js";

const FileChangesSchema = z.array(z.object({
  path: z.string(),
  kind: z.union([z.string(), z.object({ type: z.string(), move_path: z.string().nullish() })]),
  diff: z.string().optional(),
}));
type FileChange = z.infer<typeof FileChangesSchema>[number];
const FileChangeNoticeSchema = z.union([
  z.object({ method: z.literal("item/started"), params: z.object({ threadId: z.string().optional(), item: z.object({ id: z.string(), type: z.literal("fileChange"), changes: FileChangesSchema }) }) })
    .transform(({ params }) => ({ threadId: params.threadId, itemId: params.item.id, changes: params.item.changes })),
  z.object({ method: z.literal("item/fileChange/patchUpdated"), params: z.object({ threadId: z.string().optional(), itemId: z.string(), changes: FileChangesSchema }) })
    .transform(({ params }) => params),
]);

/** Parse only the native notices that can enrich a pending file approval. */
export function codexApprovalFileChange(notification: unknown) {
  const parsed = FileChangeNoticeSchema.safeParse(notification);
  if (!parsed.success) return undefined;
  const subject = codexFileSubject(parsed.data.changes);
  return subject ? { key: JSON.stringify([parsed.data.threadId, parsed.data.itemId]), subject } : undefined;
}

function codexFileSubject(changes: unknown): ApprovalSubject | undefined {
  const parsed = FileChangesSchema.safeParse(changes);
  if (!parsed.success || parsed.data.length === 0) return undefined;
  return { kind: "file_edit", files: parsed.data.map((file) => {
    const type = typeof file.kind === "string" ? file.kind : file.kind.type;
    const change = type === "add" ? "added" : type === "delete" ? "removed" : "edited";
    return { path: file.path, change, ...(file.diff === undefined ? { additions: 0, deletions: 0 } : approvalPatch(unifiedPatch(file, change))) };
  }) };
}

// Codex sends whole file content for adds and deletes, and header-less hunks (plus a "Moved to" note) for updates.
function unifiedPatch({ path, kind, diff = "" }: FileChange, change: "added" | "removed" | "edited"): string | undefined {
  const patchPath = path.replaceAll("\\", "/");
  if (change === "added") return createTextPatch(patchPath, "", diff, "added");
  if (change === "removed") return createTextPatch(patchPath, diff, "", "removed");
  if (diff.startsWith("--- ") || diff.startsWith("diff --git ")) return diff;
  const movePath = typeof kind === "string" ? undefined : kind.move_path?.replaceAll("\\", "/");
  const hunks = movePath ? diff.replace(/\n\nMoved to: [^\n]*$/, "") : diff;
  return `--- a/${patchPath}\n+++ b/${movePath ?? patchPath}\n${hunks}`;
}

/** Native Codex methods which ask the host to authorize an operation. */
export const CODEX_APPROVAL_METHODS = [
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/permissions/requestApproval", "applyPatchApproval", "execCommandApproval",
] as const;
/** Raw native parameters, interpreted only in this adapter. */
export type CodexApprovalParams = Record<string, unknown>;
/** Internal choices used by the native Codex response mapper and session drain. */
export type CodexApprovalDecision = "allow" | "allow-session" | "deny" | "cancelled";

/** Translate the native protocol variant, including safe denial during teardown. */
export function mapDecisionToCodexResponse(method: string, decision: CodexApprovalDecision, params: CodexApprovalParams): unknown {
  if (!CODEX_APPROVAL_METHODS.some((known) => known === method)) {
    return method.toLowerCase().includes("permissions") ? { permissions: {}, scope: "turn" } : { decision: "decline" };
  }
  if (method === "item/permissions/requestApproval") {
    return { permissions: decision === "allow" || decision === "allow-session" ? params.permissions ?? {} : {}, scope: decision === "allow-session" ? "session" : "turn" };
  }
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    const replies = { allow: "approved", "allow-session": "approved_for_session", deny: "denied", cancelled: "abort" };
    return { decision: replies[decision] };
  }
  const replies = { allow: "accept", "allow-session": "acceptForSession", deny: "decline", cancelled: "cancel" };
  return { decision: replies[decision] };
}

/** Adapter state supplies routing; native data supplies only the body. */
export function synthesizeCodexApprovalRequest(input: {
  method: string; params: CodexApprovalParams;
}): ApprovalRequestBody {
  const { method, params } = input;
  return {
    requestedAt: new Date().toISOString(),
    ...(typeof params.itemId === "string" ? { toolCallId: params.itemId } : {}),
    ...((typeof params.reason === "string" || params.networkApprovalContext) ? {
      reason: [typeof params.reason === "string" ? params.reason : undefined,
        params.networkApprovalContext ? `Network: ${JSON.stringify(params.networkApprovalContext)}` : undefined]
        .filter((part) => part !== undefined).join("\n"),
    } : {}),
    subject: codexSubject(method, params),
    choices: [
      { id: "allow", intent: "allow_once", label: "Allow once" },
      { id: "allow-session", intent: "allow_scoped", label: "Allow for this session" },
      { id: "deny", intent: "deny", label: "Deny" },
    ],
    noteDelivery: "steer", noteChoiceId: "deny", origin: { kind: "agent" },
  };
}

function codexSubject(method: string, params: CodexApprovalParams): ApprovalSubject {
  if ((method === "item/commandExecution/requestApproval" || method === "execCommandApproval") && typeof params.command === "string") {
    return { kind: "command", command: params.command, ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}) };
  }
  if (method === "item/fileChange/requestApproval") {
    return codexFileSubject(params.changes) ?? { kind: "tool", toolName: "FileWrite", preview: JSON.stringify({ itemId: params.itemId, grantRoot: params.grantRoot }) };
  }
  if (method === "item/permissions/requestApproval") return { kind: "tool", toolName: "WorkspacePermissions", preview: JSON.stringify({ permissions: params.permissions }) };
  return { kind: "tool", toolName: method === "applyPatchApproval" ? "ApplyPatch" : "Shell", preview: JSON.stringify(params) };
}
