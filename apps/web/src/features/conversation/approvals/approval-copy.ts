import { getCatalogEntry, type ApprovalChoice, type ApprovalRequest, type ApprovalSubject } from "@mcode/contracts";

type ThreadOperation = Extract<ApprovalSubject, { kind: "thread_operation" }>["operation"];
type DockSubjectKind = Exclude<ApprovalSubject["kind"], "question" | "thread_operation">;

const SUBJECT_ACTIONS: Record<DockSubjectKind, string> = {
  command: "run a command",
  file_edit: "edit a file",
  fetch: "fetch a page",
  tool: "use a tool",
};

const THREAD_OPERATION_ACTIONS: Record<ThreadOperation, string> = {
  thread_send: "message another thread",
  thread_create_batch: "start new threads",
  thread_stop: "stop another thread",
};

function subjectAction(subject: ApprovalSubject): string {
  if (subject.kind === "thread_operation") return THREAD_OPERATION_ACTIONS[subject.operation];
  if (subject.kind === "question") return "ask you something";
  return SUBJECT_ACTIONS[subject.kind];
}

/** Who the answer goes to: the provider, or the integration that asked. */
export function approvalActorName(request: ApprovalRequest): string {
  if (request.origin.kind === "integration") return request.origin.label;
  return request.providerId ? getCatalogEntry(request.providerId).name : "The agent";
}

/** Dock header. A subagent request drops the provider name because its chip already names who asked. */
export function approvalTitle(request: ApprovalRequest): string {
  const action = subjectAction(request.subject);
  if (request.origin.kind === "subagent") return `Wants to ${action}`;
  return `${approvalActorName(request)} wants to ${action}`;
}

/** Label the chosen row reads while its answer is in flight. */
export function submittingLabel(choice: ApprovalChoice): string {
  if (choice.intent === "allow_once") return "Allowing once…";
  if (choice.intent === "deny") return "Denying…";
  return `${choice.label}…`;
}

/** Placeholder for the deny-with-a-note row. */
export function noteRowLabel(request: ApprovalRequest): string {
  const target = request.origin.kind === "subagent" ? "the subagent" : approvalActorName(request);
  return `Tell ${target} what to do instead…`;
}
