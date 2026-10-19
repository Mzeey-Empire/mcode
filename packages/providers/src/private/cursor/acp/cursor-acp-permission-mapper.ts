import type { PermissionOption, RequestPermissionOutcome, ToolCallContent } from "@agentclientprotocol/sdk";
import type { ApprovalRequestBody, ApprovalResponse, ApprovalSubject } from "@mcode/contracts";
import { z } from "zod";
import { createTextPatch } from "@mcode/shared";
import { approvalPatch } from "../../../approval-patch.js";
import { acpApprovalChoices } from "../../../approval-scope.js";

const InputSchema = z.object({ command: z.string().optional(), cwd: z.string().optional(), path: z.string().optional(), url: z.string().optional() }).passthrough();

/** Keep ACP choice identities and scope intact while building the display body. */
export function synthesizeCursorAcpApprovalRequest(input: {
  toolTitle: string; rawToolInput: unknown; toolCallId?: string; kind?: string | null; content?: ToolCallContent[] | null; options: PermissionOption[];
}): ApprovalRequestBody {
  const choices = acpApprovalChoices(input.options);
  return {
    toolCallId: input.toolCallId, requestedAt: new Date().toISOString(),
    subject: cursorSubject(input), choices, origin: { kind: "agent" },
  };
}

function cursorSubject(input: { toolTitle: string; rawToolInput: unknown; kind?: string | null; content?: ToolCallContent[] | null }): ApprovalSubject {
  const files = cursorDiffFiles(input.content, input.kind);
  if (files.length) return { kind: "file_edit", files };
  const parsed = InputSchema.safeParse(input.rawToolInput ?? {});
  if (!parsed.success) return { kind: "tool", toolName: input.toolTitle, preview: JSON.stringify(input.rawToolInput) };
  const args = parsed.data;
  if (input.kind === "execute" && args.command) return { kind: "command", command: args.command, cwd: args.cwd };
  if (input.kind === "fetch" && args.url) return { kind: "fetch", url: args.url };
  if (args.path && ["edit", "delete", "move"].some((kind) => kind === input.kind)) {
    return cursorFileSubject(args.path, input.kind);
  }
  return { kind: "tool", toolName: input.toolTitle, preview: JSON.stringify(args) };
}

function cursorDiffFiles(content: ToolCallContent[] | null | undefined, kind: string | null | undefined): Extract<ApprovalSubject, { kind: "file_edit" }>["files"] {
  return content?.flatMap<Extract<ApprovalSubject, { kind: "file_edit" }>["files"][number]>((entry) => {
    if (entry.type !== "diff") return [];
    const change = entry.oldText === null ? "added" : kind === "delete" ? "removed" : "edited";
    return [{ path: entry.path, change, ...approvalPatch(createTextPatch(entry.path.replaceAll("\\", "/"), entry.oldText ?? "", entry.newText, change)) }];
  }) ?? [];
}

function cursorFileSubject(path: string, kind: string | null | undefined): ApprovalSubject {
  return { kind: "file_edit", files: [{ path, change: kind === "delete" ? "removed" : kind === "move" ? "renamed" : "edited", additions: 0, deletions: 0 }] };
}

/** Full access can select only an allow option. */
export function pickFullAccessAllowOption(options: PermissionOption[]): string | undefined {
  return options.find((option) => option.kind === "allow_always")?.optionId
    ?? options.find((option) => option.kind === "allow_once")?.optionId;
}

/** Send the exact selected native id; automatic denial never selects an allow. */
export function mapResponseToAcpOutcome(response: ApprovalResponse, options: PermissionOption[]): RequestPermissionOutcome {
  const option = "autoDeny" in response
    ? options.find((candidate) => candidate.kind === "reject_once")
    : options.find((candidate) => candidate.optionId === response.choiceId);
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}
