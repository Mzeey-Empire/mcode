import type { ApprovalRequestBody, ApprovalSubject } from "@mcode/contracts/models/approval";
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

/** Raw native parameters, interpreted only in this adapter. */
export type CodexApprovalParams = Record<string, unknown>;
/** Internal choices used by the native Codex response mapper and session drain. */
export type CodexApprovalDecision = "allow" | "allow-session" | "deny" | "cancelled";

/** MCP elicitation; Codex also sends its MCP tool-call approvals through it. */
export const CODEX_MCP_ELICITATION_METHOD = "mcpServer/elicitation/request";

// Codex marks a tool-call approval with these `_meta` keys (codex-rs protocol/src/mcp_approval_meta.rs).
const McpToolApprovalSchema = z.object({
  serverName: z.string().min(1),
  _meta: z.object({
    codex_approval_kind: z.literal("mcp_tool_call"),
    tool_name: z.string().min(1),
    tool_params: z.unknown().optional(),
    persist: z.union([z.string(), z.array(z.string())]).optional(),
  }),
});
type McpToolApproval = z.infer<typeof McpToolApprovalSchema>;

/** Parse an elicitation that asks to run an MCP tool; other elicitations are forms Mcode cannot show. */
export function codexMcpToolApproval(params: CodexApprovalParams): McpToolApproval | undefined {
  const parsed = McpToolApprovalSchema.safeParse(params);
  return parsed.success ? parsed.data : undefined;
}

function offersSessionApproval({ _meta: { persist } }: McpToolApproval): boolean {
  return persist === "session" || (Array.isArray(persist) && persist.includes("session"));
}

// Codex reads `_meta.persist` on an accepted tool approval; any other reply shape is a rejection.
function mcpElicitationResponse(decision: CodexApprovalDecision, params: CodexApprovalParams): unknown {
  if (decision === "cancelled") return { action: "cancel" };
  const approval = codexMcpToolApproval(params);
  if (decision === "deny" || !approval) return { action: "decline" };
  return decision === "allow-session" && offersSessionApproval(approval)
    ? { action: "accept", _meta: { persist: "session" } }
    : { action: "accept" };
}

type CodexResponder = (decision: CodexApprovalDecision, params: CodexApprovalParams) => unknown;
const V2_REPLIES = { allow: "accept", "allow-session": "acceptForSession", deny: "decline", cancelled: "cancel" } as const;
const LEGACY_REPLIES = { allow: "approved", "allow-session": "approved_for_session", deny: "denied", cancelled: "abort" } as const;
const v2Response: CodexResponder = (decision) => ({ decision: V2_REPLIES[decision] });
const legacyResponse: CodexResponder = (decision) => ({ decision: LEGACY_REPLIES[decision] });
const permissionsResponse: CodexResponder = (decision, params) => ({
  permissions: decision === "allow" || decision === "allow-session" ? params.permissions ?? {} : {},
  scope: decision === "allow-session" ? "session" : "turn",
});
const CODEX_RESPONDERS = new Map<string, CodexResponder>([
  ["item/commandExecution/requestApproval", v2Response],
  ["item/fileChange/requestApproval", v2Response],
  ["item/permissions/requestApproval", permissionsResponse],
  ["applyPatchApproval", legacyResponse],
  ["execCommandApproval", legacyResponse],
  [CODEX_MCP_ELICITATION_METHOD, mcpElicitationResponse],
]);

/** Translate the native protocol variant, including safe denial during teardown. */
export function mapDecisionToCodexResponse(method: string, decision: CodexApprovalDecision, params: CodexApprovalParams): unknown {
  const respond = CODEX_RESPONDERS.get(method);
  if (respond) return respond(decision, params);
  return method.toLowerCase().includes("permissions") ? { permissions: {}, scope: "turn" } : { decision: "decline" };
}

function codexApprovalChoices(toolApproval: McpToolApproval | undefined): ApprovalRequestBody["choices"] {
  const sessionChoice = !toolApproval || offersSessionApproval(toolApproval);
  return [
    { id: "allow", intent: "allow_once", label: "Allow once" },
    ...(sessionChoice ? [{ id: "allow-session", intent: "allow_scoped", label: "Allow for this session" } as const] : []),
    { id: "deny", intent: "deny", label: "Deny" },
  ];
}

/** Adapter state supplies routing; native data supplies only the body. */
export function synthesizeCodexApprovalRequest(input: {
  method: string; params: CodexApprovalParams;
  origin?: ApprovalRequestBody["origin"];
}): ApprovalRequestBody {
  const { method, params } = input;
  const toolApproval = method === CODEX_MCP_ELICITATION_METHOD ? codexMcpToolApproval(params) : undefined;
  return {
    requestedAt: new Date().toISOString(),
    ...(typeof params.itemId === "string" ? { toolCallId: params.itemId } : {}),
    ...((typeof params.reason === "string" || params.networkApprovalContext) ? {
      reason: [typeof params.reason === "string" ? params.reason : undefined,
        params.networkApprovalContext ? `Network: ${JSON.stringify(params.networkApprovalContext)}` : undefined]
        .filter((part) => part !== undefined).join("\n"),
    } : {}),
    subject: toolApproval ? mcpToolSubject(toolApproval) : codexSubject(method, params),
    choices: codexApprovalChoices(toolApproval),
    origin: input.origin ?? { kind: "agent" },
  };
}

function mcpToolSubject({ serverName, _meta }: McpToolApproval): ApprovalSubject {
  return { kind: "tool", toolName: `${serverName}/${_meta.tool_name}`, ...(_meta.tool_params === undefined ? {} : { preview: JSON.stringify(_meta.tool_params) }) };
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
