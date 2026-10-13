import type { ApprovalChoice, ApprovalRequestBody, ApprovalSubject } from "@mcode/contracts";
import { claudeFilePatch } from "./claude-approval-patch.js";

/** Build Claude's scope and bounded file evidence before publishing the approval. */
export async function claudeApprovalBody(toolName: string, input: Record<string, unknown>, options: {
  toolUseID?: string; decisionReason?: string; suggestions?: unknown[];
}, cwd?: string): Promise<ApprovalRequestBody> {
  const choices: ApprovalChoice[] = [{ id: "allow", intent: "allow_once", label: "Allow once" }];
  const description = options.suggestions?.length ? JSON.stringify(options.suggestions) : undefined;
  if (description && description.length <= 500) choices.push({ id: "allow-session", intent: "provider", label: "Allow suggested permissions", description });
  choices.push({ id: "deny", intent: "deny", label: "Deny" });
  return { requestedAt: new Date().toISOString(), toolCallId: options.toolUseID,
    reason: options.decisionReason, subject: await claudeSubject(toolName, input, cwd),
    choices, noteDelivery: "native", noteChoiceId: "deny", origin: { kind: "agent" } };
}

async function claudeSubject(toolName: string, input: Record<string, unknown>, cwd?: string): Promise<ApprovalSubject> {
  if (toolName === "Bash" && typeof input.command === "string") {
    return { kind: "command", command: input.command, ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}) };
  }
  if (toolName === "WebFetch" && typeof input.url === "string") return { kind: "fetch", url: input.url };
  const path = input.file_path ?? input.notebook_path;
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName) && typeof path === "string") {
    return { kind: "file_edit", files: [await claudeFilePatch(toolName, input, path, cwd)] };
  }
  return { kind: "tool", toolName, preview: JSON.stringify(input) };
}
