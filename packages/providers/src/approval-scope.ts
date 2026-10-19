import { ApprovalChoiceSchema, type ApprovalChoice, type ApprovalOutcome, type ApprovalRequestBody, type ApprovalResponse } from "@mcode/contracts";

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

type AcpPermissionOption = { optionId: string; name: string; kind?: string | null; description?: string };

/** ACP preserves both reject kinds and uses cancellation only when no reject exists. */
export function acpApprovalChoices(options: readonly AcpPermissionOption[]): ApprovalChoice[] {
  const choices = options.filter((option) => option.optionId !== "allow_always_global").flatMap((option) => acpChoice(option) ?? []);
  if (!choices.some((choice) => choice.intent === "deny")) {
    let id = "mcode-deny";
    while (choices.some((choice) => choice.id === id)) id += "-";
    choices.push({ id, intent: "deny", label: "Deny" });
  }
  return choices;
}

// An option the card cannot show in full must not invalidate the whole request, which would auto-deny it.
// Allows are dropped rather than shown with an unstated scope; a reject needs no scope, so it keeps its native id.
function acpChoice(option: AcpPermissionOption): ApprovalChoice | undefined {
  const intent = option.kind?.startsWith("reject") ? "deny" : option.kind === "allow_once" ? "allow_once" : "provider";
  const choice: ApprovalChoice = { id: option.optionId, label: option.name, intent, ...(option.description ? { description: option.description } : {}) };
  if (ApprovalChoiceSchema().safeParse(choice).success) return choice;
  if (intent !== "deny") return undefined;
  const plain: ApprovalChoice = { id: option.optionId, label: "Deny", intent };
  return ApprovalChoiceSchema().safeParse(plain).success ? plain : undefined;
}

