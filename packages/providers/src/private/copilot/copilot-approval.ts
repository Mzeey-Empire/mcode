import type { PermissionRequest } from "@github/copilot-sdk";
import type { ApprovalChoice, ApprovalRequestBody, ApprovalSubject } from "@mcode/contracts";
import { z } from "zod";
import { approvalPatch } from "../../approval-patch.js";

const ShellScopeSchema = z.object({
  canOfferSessionApproval: z.literal(true),
  hasWriteFileRedirection: z.literal(false),
  commands: z.array(z.object({ identifier: z.string().min(1).regex(/\S/) })).min(1),
});
const McpScopeSchema = z.object({ serverName: z.string().min(1), toolName: z.string().min(1) });

/** Exact native scopes retained until the session closes or its permission mode changes. */
export interface CopilotSessionScope {
  keys: string[];
  description: string;
}

/** Validate native SDK extension fields before offering or reusing a scoped grant. */
export function copilotSessionScope(native: PermissionRequest): CopilotSessionScope | undefined {
  let scope: CopilotSessionScope;
  switch (native.kind) {
    case "shell": {
      const parsed = ShellScopeSchema.safeParse(native);
      if (!parsed.success) return undefined;
      const identifiers = parsed.data.commands.map((command) => command.identifier);
      scope = {
        keys: identifiers.map((identifier) => JSON.stringify(["shell", identifier])),
        description: `Shell command identifiers: ${identifiers.join(", ")}`,
      };
      break;
    }
    case "url": {
      if (typeof native.url !== "string" || !URL.canParse(native.url)) return undefined;
      const url = new URL(native.url);
      if (!["https:", "http:"].includes(url.protocol)) return undefined;
      scope = { keys: [JSON.stringify(["url", url.origin])], description: `URLs on origin: ${url.origin}` };
      break;
    }
    case "mcp": {
      const parsed = McpScopeSchema.safeParse(native);
      if (!parsed.success) return undefined;
      const { serverName, toolName } = parsed.data;
      scope = { keys: [JSON.stringify(["mcp", serverName, toolName])], description: `MCP server: ${serverName}; tool: ${toolName}` };
      break;
    }
    default:
      return undefined;
  }
  return scope.description.length <= 500 ? scope : undefined;
}

/** Offer a session choice only for native scope that can be stated in full. */
export function copilotApprovalBody(native: PermissionRequest, scope: CopilotSessionScope | undefined): ApprovalRequestBody {
  const choices: ApprovalChoice[] = [{ id: "allow", intent: "allow_once", label: "Allow once" }];
  if (scope) {
    choices.push({ id: "allow-session", intent: "allow_scoped", label: "Allow for this session", description: scope.description });
  }
  choices.push({ id: "deny", intent: "deny", label: "Deny" });
  return {
    toolCallId: native.toolCallId, requestedAt: new Date().toISOString(), subject: copilotSubject(native),
    choices,
    noteDelivery: "native", noteChoiceId: "deny", origin: { kind: "agent" },
  };
}

function copilotSubject(native: PermissionRequest): ApprovalSubject {
  if (native.kind === "shell" && typeof native.fullCommandText === "string") return { kind: "command", command: native.fullCommandText };
  if (native.kind === "write" && typeof native.fileName === "string") {
    return { kind: "file_edit", files: [{ path: native.fileName, change: "edited",
      ...(typeof native.diff === "string" ? approvalPatch(native.diff) : { additions: 0, deletions: 0 }) }] };
  }
  if (native.kind === "url" && typeof native.url === "string") return { kind: "fetch", url: native.url };
  return { kind: "tool", toolName: native.kind, preview: JSON.stringify({
    path: native.path, fileName: native.fileName, serverName: native.serverName, toolName: native.toolName, arguments: native.arguments,
  }) };
}
