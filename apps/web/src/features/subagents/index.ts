/** Public Sub-agents feature surface for app composition and workbench consumers. */
export { SubagentsPanel } from "./roster/SubagentsPanel";
export { SubagentDetailTab } from "./detail/SubagentDetailTab";
export { useSubagentRoster, useSubagentRosterStore } from "./state/subagentRosterStore";
export { subagentStatusLabel, subagentChipStatus, subagentOverviewCounts } from "./subagent-status";
export { SubagentStopControl } from "./lifecycle/SubagentStopControl";
export { openSubagentsPanel, openSubagentDetail } from "./detail/open-subagent-detail";
