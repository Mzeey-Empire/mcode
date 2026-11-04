import type { WsMethodName } from "@mcode/contracts/ws/methods";
import { diag, type EventPayload } from "@mcode/shared/diagnostics";

/** Where a request's record is filed: its thread, or for an approval answer, the approval it answers. */
interface RequestTarget {
  th?: string;
  approval?: string;
}

type TargetResolver = (params: unknown, result: unknown) => RequestTarget;

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}

const threadFromParams: TargetResolver = (params) => ({ th: stringField(params, "threadId") });

// The server creates the thread, so only the response knows its id.
const threadFromResult: TargetResolver = (_params, result) => ({ th: stringField(result, "id") });

// An approval answer names only the approval; its thread's `approval` span shares that id.
const approvalFromParams: TargetResolver = (params) => ({ approval: stringField(params, "requestId") });

const RECORDED_REQUESTS: Partial<Record<string, TargetResolver>> = {
  "agent.send": threadFromParams,
  "agent.stop": threadFromParams,
  "agent.steer": threadFromParams,
  "agent.answerQuestions": threadFromParams,
  "turn.retry": threadFromParams,
  "turn.resume": threadFromParams,
  "agent.createAndSend": threadFromResult,
  "approval.respond": approvalFromParams,
} satisfies Partial<Record<WsMethodName, TargetResolver>>;

/** Records when a user request reached the server and over which connection, without its content. */
export function recordRequest(
  method: string,
  params: unknown,
  result: unknown,
  payload: EventPayload<"rpc.request">,
): void {
  const resolveTarget = RECORDED_REQUESTS[method];
  if (!resolveTarget) return;
  const { th, approval } = resolveTarget(params, result);
  diag.emit("rpc.request", { th }, () => (approval === undefined ? payload : { ...payload, approval }));
}
