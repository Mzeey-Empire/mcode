import { ApprovalRequestBodySchema, type ApprovalChoice, type ApprovalOutcome, type ApprovalRequestBody, type ApprovalResponse } from "@mcode/contracts";

/** Check the whole authorization scope without shortening any field. */
export function approvalScope(body: unknown): "unreadable" | "too_large" | undefined {
  const parsed = ApprovalRequestBodySchema().safeParse(body);
  if (parsed.success) return undefined;
  return parsed.error.issues.some((issue) => issue.code === "too_big") ? "too_large" : "unreadable";
}

/** Resolve a response against the choices the adapter actually advertised. */
export function approvalChoice(body: ApprovalRequestBody, response: ApprovalResponse): ApprovalChoice | undefined {
  if ("autoDeny" in response) return body.choices.find((choice) => choice.intent === "deny");
  return body.choices.find((choice) => choice.id === response.choiceId);
}

/** Build a resolution only after the adapter's native answer has completed. */
export function approvalOutcome(choice: ApprovalChoice | undefined, response: ApprovalResponse): ApprovalOutcome {
  if ("autoDeny" in response) return { status: "auto_denied", reason: response.autoDeny };
  if (!choice) return { status: "cancelled", reason: "unanswerable" };
  if (choice.intent === "deny") return { status: "denied", choiceLabel: choice.label };
  if (response.answers) return { status: "answered", count: response.answers.length };
  return { status: "allowed", intent: choice.intent, choiceLabel: choice.label };
}

/** ACP preserves both reject kinds and uses cancellation only when no reject exists. */
export function acpApprovalChoices(options: readonly { optionId: string; name: string; kind?: string | null; description?: string }[]): ApprovalChoice[] {
  const choices = options.filter((option) => option.optionId !== "allow_always_global").map((option): ApprovalChoice => ({
    id: option.optionId,
    label: option.name,
    intent: option.kind?.startsWith("reject") ? "deny" : option.kind === "allow_once" ? "allow_once" : "provider",
    ...(option.description ? { description: option.description } : {}),
  }));
  if (!choices.some((choice) => choice.intent === "deny")) {
    let id = "mcode-deny";
    while (choices.some((choice) => choice.id === id)) id += "-";
    choices.push({ id, intent: "deny", label: "Deny" });
  }
  return choices;
}

/** Prefer the native one-off reject for the future deny-note action. */
export function acpNoteChoiceId(options: readonly { optionId: string; kind?: string | null }[], choices: ApprovalChoice[]): string | undefined {
  return options.find((option) => option.kind === "reject_once")?.optionId
    ?? choices.find((choice) => choice.intent === "deny")?.id;
}
