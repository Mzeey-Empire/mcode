import { AgentEventType, ApprovalRequestBodySchema, type AgentEvent, type ApprovalOutcome, type ApprovalRequestEnvelope, type ApprovalSubject } from "@mcode/contracts";

/** Build a bounded receipt without exposing unreadable request data. */
export function approvalReceipt(request: ApprovalRequestEnvelope, outcome: ApprovalOutcome): Extract<AgentEvent, { type: "approvalDecided" }> {
  const failClosed = outcome.status === "auto_denied" || outcome.status === "cancelled" && outcome.reason === "unanswerable";
  const parsed = failClosed ? undefined : ApprovalRequestBodySchema().safeParse(request.body);
  const body = parsed?.success ? parsed.data : undefined;
  return {
    type: AgentEventType.ApprovalDecided, threadId: request.threadId, requestId: request.requestId,
    kind: body?.subject.kind ?? "tool",
    subjectLabel: body ? subjectLabel(body.subject).slice(0, 200) : "Mcode couldn't read this request",
    outcome,
    ...(body ? { toolCallId: body.toolCallId, origin: body.origin } : {}),
  };
}

function subjectLabel(subject: ApprovalSubject): string {
  switch (subject.kind) {
    case "command": return subject.command;
    case "file_edit": return subject.files[0]?.path.split(/[\\/]/).pop() || "File edit";
    case "fetch": return fetchHost(subject.url);
    case "tool": return subject.toolName;
    case "question": return "Questions";
    case "thread_operation": return subject.operation;
  }
}

function fetchHost(value: string): string {
  return URL.canParse(value) ? new URL(value).host || "Fetch" : "Fetch";
}
