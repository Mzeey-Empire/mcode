import type { ApprovalChoice, ApprovalQuestion, ApprovalRequestBody, ApprovalRequestEnvelope } from "@mcode/contracts";
import { z } from "zod";

const ToolIdentitySchema = z.object({ callID: z.string().optional() });

/**
 * Upstream reply for `POST /session/{id}/permissions/{permissionID}`.
 * Source: `PostSessionByIdPermissionsByPermissionIdData` in the generated
 * OpenCode SDK (`packages/sdk/js/src/gen/types.gen.ts`).
 */
export type OpenCodePermissionReply = "once" | "always" | "reject";

/** Largest accepted upstream request id (`per_*` / `que_*`); longer is hostile. */
const MAX_REQUEST_ID_CHARS = 128;
/** Largest retained question title header. */
const MAX_HEADER_CHARS = 200;
/** Largest retained question body. */
const MAX_QUESTION_CHARS = 1_000;
/** Largest retained question option description. */
const MAX_OPTION_DESCRIPTION_CHARS = 500;
/** Largest retained question option label. */
const MAX_OPTION_CHARS = 100;
/** Largest retained question batch; upstream asks stay small. */
const MAX_QUESTIONS = 10;
/** Largest retained option list per question. */
const MAX_OPTIONS = 10;

function boundString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function acceptedIdentity(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim().length === 0) return undefined;
  return value;
}

function acceptedId(value: unknown): string | undefined {
  return acceptedIdentity(value, MAX_REQUEST_ID_CHARS);
}

/** Map the exact adapter-owned choice to OpenCode's native permission reply. */
export function mapApprovalChoiceToReply(choiceId: string): OpenCodePermissionReply {
  if (choiceId === "once") return "once";
  if (choiceId === "always") return "always";
  return "reject";
}

/** Keep all resources intact; the shared scope validator decides whether they fit. */
export function synthesizeOpenCodeApprovalRequest(input: {
  threadId: string; properties: Record<string, unknown>;
}): (ApprovalRequestEnvelope & { body: ApprovalRequestBody }) | null {
  const requestId = acceptedId(input.properties.id);
  if (requestId === undefined) return null;
  const action = typeof input.properties.action === "string" ? input.properties.action
    : typeof input.properties.permission === "string" ? input.properties.permission : "";
  const resources = input.properties.resources ?? [];
  const description = Array.isArray(resources) && resources.every((item): item is string => typeof item === "string")
    ? resources.join(", ") : undefined;
  const choices: ApprovalChoice[] = [{ id: "once", intent: "allow_once", label: "Allow once" }];
  if (description && description.length <= 500) choices.push({ id: "always", intent: "allow_scoped", label: "Allow for this session", description });
  choices.push({ id: "reject", intent: "deny", label: "Deny" });
  const tool = ToolIdentitySchema.safeParse(input.properties.tool);
  return {
    requestId, threadId: input.threadId,
    body: {
      requestedAt: new Date().toISOString(), toolCallId: tool.success ? tool.data.callID : undefined,
      subject: { kind: "tool", toolName: action, preview: JSON.stringify({ action, resources }) },
      choices, noteDelivery: "next_turn", noteChoiceId: "reject", origin: { kind: "agent" },
    },
  };
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionOf(value: unknown): ApprovalQuestion["options"][number] | undefined {
  if (!objectRecord(value)) return undefined;
  // Labels are reply identities. Truncating one changes what the user chose,
  // so an oversized label invalidates the card instead of changing it.
  const label = acceptedIdentity(value.label, MAX_OPTION_CHARS);
  if (label === undefined) return undefined;
  const description = boundString(value.description, MAX_OPTION_DESCRIPTION_CHARS);
  return { label, ...(description === undefined ? {} : { description }) };
}

function optionsOf(value: unknown): ApprovalQuestion["options"] | undefined {
  if (!Array.isArray(value) || value.length > MAX_OPTIONS) return undefined;
  const options: ApprovalQuestion["options"] = [];
  for (const option of value) {
    const mapped = optionOf(option);
    if (mapped === undefined) return undefined;
    options.push(mapped);
  }
  return options;
}

function cardOf(value: unknown): ApprovalQuestion | null {
  if (!objectRecord(value)) return null;
  const header = boundString(value.header, MAX_HEADER_CHARS);
  const question = boundString(value.question, MAX_QUESTION_CHARS);
  if (header === undefined || question === undefined) return null;
  const options = optionsOf(value.options);
  if (options === undefined) return null;
  const multiple = value.multiple === true;
  const custom = value.custom === true;
  if (options.length === 0 && !custom) return null;
  return { header, question, options, multiple, custom };
}

/**
 * Build an inline card for `question.v2.asked` / `question.asked`
 * (`{ id: que_*, questions: [{ header, question, options: [{ label }] }] }`).
 * The card reuses the existing permission flow: the user approves or
 * dismisses, and the provider relays that response upstream. Returns the card
 * and preserves the exact selectable labels required by the upstream reply.
 * Returns null when the envelope carries no usable request identity or
 * bounded questions.
 */
export function synthesizeOpenCodeQuestionRequest(input: {
  threadId: string;
  properties: Record<string, unknown>;
}): (ApprovalRequestEnvelope & { body: ApprovalRequestBody }) | null {
  const requestId = acceptedId(input.properties.id);
  if (requestId === undefined) return null;
  if (!Array.isArray(input.properties.questions)) return null;
  if (input.properties.questions.length === 0 || input.properties.questions.length > MAX_QUESTIONS) return null;
  const questions: ApprovalQuestion[] = [];
  for (const item of input.properties.questions) {
    const card = cardOf(item);
    if (!card) return null;
    questions.push(card);
  }
  return {
    requestId,
    threadId: input.threadId,
    body: {
      requestedAt: new Date().toISOString(), subject: { kind: "question", questions },
      choices: [{ id: "answer", intent: "allow_once", label: "Submit answers" }, { id: "reject", intent: "deny", label: "Dismiss" }],
      noteDelivery: "none", origin: { kind: "agent" },
    },
  };
}
