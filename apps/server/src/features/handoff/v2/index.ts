/** Public input and result types for budgeted handoff history. */
export type {
  HandoffKind,
  HandoffSourceItem,
  HandoffMessageRow,
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

/** Convert stored message fields into replayable items. */
export { handoffItemsFromMessages } from "./items.js";

/** Select and render history, or report an exhausted preamble budget. */
export { HandoffBudgetExhaustedError, selectHandoffHistory } from "./select.js";
