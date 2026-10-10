/** Public Sub-agents feature surface for app composition and workbench consumers. */
export { SubagentsPanel } from "./roster/SubagentsPanel";
export { useSubagentRoster, useSubagentRosterStore } from "./state/subagentRosterStore";
export { subagentStatusLabel, subagentChipStatus, subagentOverviewCounts } from "./subagent-status";
export { SubagentLifecycleStatus } from "./lifecycle/SubagentLifecycleStatus";
export type {
  SubagentLifecycleStatusProps,
  SubagentLifecycleTone,
} from "./lifecycle/SubagentLifecycleStatus";
export { SubagentStopControl } from "./lifecycle/SubagentStopControl";
export { SubagentChangeSummary } from "./detail/SubagentChangeSummary";
export { openSubagentsPanel, openSubagentsRoster, openSubagentDetail } from "./detail/open-subagent-detail";
