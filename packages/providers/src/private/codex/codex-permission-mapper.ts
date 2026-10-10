import type { ApprovalRequestBody, ApprovalSubject } from "@mcode/contracts";

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
    ...(typeof params.reason === "string" ? { reason: params.reason.slice(0, 1_000) } : {}),
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
    return { kind: "command", command: params.command, ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
      ...(params.networkApprovalContext ? { facts: [`Network: ${JSON.stringify(params.networkApprovalContext)}`] } : {}) };
  }
  if (method === "item/fileChange/requestApproval") {
    return { kind: "tool", toolName: "FileWrite", preview: JSON.stringify({ itemId: params.itemId, grantRoot: params.grantRoot }) };
  }
  if (method === "item/permissions/requestApproval") return { kind: "tool", toolName: "WorkspacePermissions", preview: JSON.stringify({ permissions: params.permissions }) };
  return { kind: "tool", toolName: method === "applyPatchApproval" ? "ApplyPatch" : "Shell", preview: JSON.stringify(params) };
}
