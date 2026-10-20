/** Public input and result types for budgeted handoff history. */
export type {
  HandoffKind,
  HandoffSourceItem,
  HandoffMessageInput,
  HandoffCoverage,
  HandoffBudgetInput,
  HandoffSelection,
} from "./types.js";

/** Context reservations and the provider-independent history budget. */
export {
  HANDOFF_TOKEN_CAP,
  HANDOFF_BYTE_CAP,
  DEFAULT_CONTEXT_WINDOW,
  IMAGE_ATTACHMENT_RESERVE,
  FILE_ATTACHMENT_RESERVE,
  MIN_RESPONSE_RESERVE,
  handoffBudgetBytes,
} from "./budget.js";

/** Convert normalized messages into replayable items. */
export { handoffItemsFromMessages } from "./items.js";

/** Load normalized history from the thread's persisted messages and tool records. */
export { loadHandoffMessages } from "./message-adapter.js";

/** Select and render history, or report an exhausted preamble budget. */
export { HandoffBudgetExhaustedError, selectHandoffHistory } from "./select.js";

/** Budgeted, fenced history shared by every handoff kind. */
export { buildFencedHandoff } from "./fenced-handoff.js";
export type { FencedHandoff, FencedHandoffInput } from "./fenced-handoff.js";

/** The per-turn character cap a target provider imposes on a handoff. */
export { targetInputCharacterCap } from "./input-cap.js";

/** Delta-or-fresh planning and fenced rendering for a provider switch. */
export { MAX_DELTA_TURNS, planSwitchHandoff } from "./switch-plan.js";
export type { SwitchHandoffInput, SwitchHandoffMode, SwitchHandoffPlan } from "./switch-plan.js";
