import type { PermissionRequest } from "@github/copilot-sdk";
import type { ApprovalRequestBody, ApprovalSubject } from "@mcode/contracts";

/** Map only the scope Copilot already supplies; scoped grants remain a later ticket. */
export function copilotApprovalBody(native: PermissionRequest): ApprovalRequestBody {
  return {
    toolCallId: native.toolCallId, requestedAt: new Date().toISOString(), subject: copilotSubject(native),
    choices: [
      { id: "allow", intent: "allow_once", label: "Allow once" },
      { id: "allow-session", intent: "provider", label: "Allow all tools for this session", description: "Approves all later tool requests in this session." },
      { id: "deny", intent: "deny", label: "Deny" },
    ],
    noteDelivery: "native", noteChoiceId: "deny", origin: { kind: "agent" },
  };
}

function copilotSubject(native: PermissionRequest): ApprovalSubject {
  if (native.kind === "shell" && typeof native.fullCommandText === "string") return { kind: "command", command: native.fullCommandText };
  if (native.kind === "write" && typeof native.fileName === "string") {
    return { kind: "file_edit", files: [{ path: native.fileName, change: "edited", additions: 0, deletions: 0 }] };
  }
  if (native.kind === "url" && typeof native.url === "string") return { kind: "fetch", url: native.url };
  return { kind: "tool", toolName: native.kind, preview: JSON.stringify({
    path: native.path, fileName: native.fileName, serverName: native.serverName, toolName: native.toolName, arguments: native.arguments,
  }) };
}
