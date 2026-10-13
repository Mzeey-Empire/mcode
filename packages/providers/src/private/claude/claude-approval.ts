import type { ApprovalChoice, ApprovalRequestBody, ApprovalSubject } from "@mcode/contracts";
import type { PermissionRuleValue, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { claudeFilePatch } from "./claude-approval-patch.js";

const SessionScopedUpdateSchema = z.union([
  z.object({ type: z.enum(["addRules", "replaceRules", "removeRules"]), behavior: z.enum(["allow", "deny", "ask"]),
    rules: z.array(z.object({ toolName: z.string().min(1), ruleContent: z.string().min(1)
      .refine((content) => !content.endsWith(":*") || content.slice(0, -2).trim().length > 0).optional() })).min(1) }),
  z.object({ type: z.enum(["addDirectories", "removeDirectories"]), directories: z.array(z.string().min(1)).min(1) }),
]);

/** Build Claude's scope and bounded file evidence before publishing the approval. */
export async function claudeApprovalBody(toolName: string, input: Record<string, unknown>, options: {
  toolUseID?: string; decisionReason?: string; suggestions?: PermissionUpdate[];
}, cwd?: string): Promise<ApprovalRequestBody> {
  const choices: ApprovalChoice[] = [{ id: "allow", intent: "allow_once", label: "Allow once" }];
  const description = sessionDescription(options.suggestions);
  if (description) {
    choices.push({ id: "allow-session", intent: "allow_scoped", label: "Allow for this session", description });
  }
  choices.push({ id: "deny", intent: "deny", label: "Deny" });
  return { requestedAt: new Date().toISOString(), toolCallId: options.toolUseID,
    reason: options.decisionReason, subject: await claudeSubject(toolName, input, cwd),
    choices, noteDelivery: "native", noteChoiceId: "deny", origin: { kind: "agent" } };
}

function sessionDescription(updates: PermissionUpdate[] | undefined): string | undefined {
  if (!updates?.length) return undefined;
  const descriptions: string[] = [];
  for (const update of updates) {
    const description = sessionScopedUpdateDescription(update);
    if (!description) return undefined;
    descriptions.push(description);
  }
  const description = descriptions.join("; ");
  return description.length <= 500 ? description : undefined;
}

function sessionScopedUpdateDescription(update: PermissionUpdate): string | undefined {
  if (!SessionScopedUpdateSchema.safeParse(update).success) return undefined;
  switch (update.type) {
    case "addRules":
    case "replaceRules":
    case "removeRules":
      return ruleUpdateDescription(update);
    case "addDirectories":
      return update.directories.length ? `Add accessible directories: ${update.directories.join(", ")}` : undefined;
    case "removeDirectories":
      return update.directories.length ? `Remove accessible directories: ${update.directories.join(", ")}` : undefined;
    case "setMode":
      return undefined;
    default: {
      update satisfies never;
      return undefined;
    }
  }
}

function ruleUpdateDescription(update: Extract<PermissionUpdate, { rules: PermissionRuleValue[] }>): string | undefined {
  if (!update.rules.length) return undefined;
  const rules = update.rules.map(ruleDescription).join(", ");
  if (update.type === "replaceRules") return `Replace all session ${update.behavior} rules with: ${rules}`;
  if (update.type === "removeRules") return `Remove session ${update.behavior} rules for: ${rules}`;
  return `Add session ${update.behavior} rules for: ${rules}`;
}

function ruleDescription(rule: PermissionRuleValue): string {
  if (rule.toolName === "Bash" && rule.ruleContent?.endsWith(":*")) {
    return `${rule.ruleContent.slice(0, -2)} commands`;
  }
  return rule.ruleContent === undefined ? `all ${rule.toolName} uses` : `${rule.toolName}(${rule.ruleContent})`;
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
