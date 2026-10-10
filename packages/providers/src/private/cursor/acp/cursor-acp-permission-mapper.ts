import type { PermissionOption, RequestPermissionOutcome } from "@agentclientprotocol/sdk";
import type { ApprovalRequestBody, ApprovalResponse, ApprovalSubject } from "@mcode/contracts";
import { z } from "zod";
import { acpApprovalChoices, acpNoteChoiceId } from "../../../approval-scope.js";

const InputSchema = z.object({ command: z.string().optional(), cwd: z.string().optional(), path: z.string().optional(), url: z.string().optional() }).passthrough();

/** Keep ACP choice identities and scope intact while building the display body. */
export function synthesizeCursorAcpApprovalRequest(input: {
  toolTitle: string; rawToolInput: unknown; toolCallId?: string; kind?: string | null; options: PermissionOption[];
}): ApprovalRequestBody {
  const choices = acpApprovalChoices(input.options);
  return {
    toolCallId: input.toolCallId, requestedAt: new Date().toISOString(),
    subject: cursorSubject(input), choices, noteDelivery: "next_turn",
    noteChoiceId: acpNoteChoiceId(input.options, choices), origin: { kind: "agent" },
  };
}

function cursorSubject(input: { toolTitle: string; rawToolInput: unknown; kind?: string | null }): ApprovalSubject {
  const parsed = InputSchema.safeParse(input.rawToolInput ?? {});
  if (!parsed.success) return { kind: "tool", toolName: input.toolTitle, preview: JSON.stringify(input.rawToolInput) };
  const args = parsed.data;
  if (input.kind === "execute" && args.command) return { kind: "command", command: args.command, cwd: args.cwd };
  if (input.kind === "fetch" && args.url) return { kind: "fetch", url: args.url };
  if (["edit", "delete", "move"].includes(input.kind ?? "") && args.path) {
    return cursorFileSubject(args.path, input.kind);
  }
  return { kind: "tool", toolName: input.toolTitle, preview: JSON.stringify(args) };
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
