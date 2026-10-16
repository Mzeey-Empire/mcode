/** Public Terminal feature surface for workbench composition. */
export {
  PendingActionApproval,
  TerminalPoolHost,
  TerminalTabContent,
  TerminalView,
  useScopeTerminals,
} from "./surfaces";
export {
  TerminalPoolSlot,
  TerminalPoolSlotProvider,
} from "./surfaces/TerminalPoolSlotContext";
export { TerminalSection } from "./settings/TerminalSection";
export { useTerminalSettingsStore } from "./settings/terminalSettingsStore";
export { applyActionRun } from "./state/applyActionRun";
export { useTerminalStore } from "./state/terminalStore";
export { useHomeTerminalPresented } from "./state/useHomeTerminalPresented";
export type {
  ActiveTerminalSession,
  TerminalInstance,
  TerminalSearchOptions,
  TerminalSearchState,
} from "./state/terminalStore";
