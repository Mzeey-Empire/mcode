import type { ComponentType, ReactNode } from "react";
import { BackgroundCommandsEntryBlock } from "./entries/background-commands";
import { BranchEntryBlock, BranchEntryState } from "./entries/branch";
import { BrowserEntryBlock, BrowserEntryState } from "./entries/browser";
import { ChangesEntryBlock, ChangesEntryState } from "./entries/changes";
import { FolderEntryBlock } from "./entries/folder";
import { GitEntryBlock } from "./entries/git";
import { LocalEntryBlock, LocalEntryState } from "./entries/local";
import { PlanEntryBlock } from "./entries/plan";
import { TargetBranchEntryBlock, TargetWorkspaceEntryBlock } from "./entries/new-thread-target";
import { PullRequestEntryBlock } from "./entries/pull-request";
import { RecapEntryBlock, RecapEntryState } from "./entries/recap";
import { RepositoryEntryBlock, RepositoryEntryState } from "./entries/repository";
import { SaveRecoveryEntryBlock } from "./entries/save-recovery";
import { SourcesEntryBlock } from "./entries/sources";
import { SubagentsEntryBlock } from "./entries/subagents";
import { OverviewTerminalsSection } from "./entries/terminals";
import { UsageEntryBlock } from "./entries/usage";
import { OverviewProjectActionsState, ProjectActionsEntryBlock } from "./entries/project-actions";
import type { OverviewSubject } from "./overview-subject";

/** Card sections, top to bottom. A divider separates each pair of non-empty sections. */
export const OVERVIEW_SECTIONS = ["actions", "lane", "activity", "terminals", "usage", "recap"] as const;

/** One card section. */
export type OverviewSectionId = (typeof OVERVIEW_SECTIONS)[number];

/** One registered block of the overview card. */
export interface OverviewEntry {
  readonly id: string;
  readonly section: OverviewSectionId;
  readonly order: number;
  readonly subjects: readonly OverviewSubject["kind"][];
  /** Filters entries to project or No project subjects. Omit to allow both. */
  readonly audience?: "project" | "no-project";
  /** Renders null when there is nothing to show. */
  readonly Entry: ComponentType<{ subject: OverviewSubject }>;
  /** Owns state that must survive the row unmounting when the overview closes. */
  readonly State?: ComponentType<{ subject: OverviewSubject; children: ReactNode }>;
}

/** Body entries. The card groups them by section, then orders each section by `order`. */
export const OVERVIEW_ENTRIES: readonly OverviewEntry[] = [
  { id: "project-actions", audience: "project", section: "actions", order: 0, subjects: ["thread"], Entry: ProjectActionsEntryBlock, State: OverviewProjectActionsState },
  { id: "save-recovery", section: "activity", order: 10, subjects: ["thread"], Entry: SaveRecoveryEntryBlock },
  { id: "changes", audience: "project", section: "activity", order: 20, subjects: ["thread"], Entry: ChangesEntryBlock, State: ChangesEntryState },
  { id: "repository", audience: "project", section: "lane", order: 95, subjects: ["thread"], Entry: RepositoryEntryBlock, State: RepositoryEntryState },
  { id: "plan", section: "activity", order: 45, subjects: ["thread"], Entry: PlanEntryBlock },
  { id: "local", audience: "project", section: "lane", order: 50, subjects: ["thread"], Entry: LocalEntryBlock, State: LocalEntryState },
  { id: "folder", audience: "no-project", section: "lane", order: 50, subjects: ["thread"], Entry: FolderEntryBlock },
  // A new thread's rows take the slots of the thread rows they become: where it runs, then the branch.
  { id: "target.workspace", section: "lane", order: 50, subjects: ["new-thread"], Entry: TargetWorkspaceEntryBlock },
  { id: "target.branch", section: "lane", order: 70, subjects: ["new-thread"], Entry: TargetBranchEntryBlock },
  { id: "git", audience: "project", section: "lane", order: 75, subjects: ["thread"], Entry: GitEntryBlock },
  { id: "branch", audience: "project", section: "lane", order: 70, subjects: ["thread"], Entry: BranchEntryBlock, State: BranchEntryState },
  { id: "terminals", section: "terminals", order: 85, subjects: ["thread"], Entry: OverviewTerminalsSection },
  { id: "usage", section: "usage", order: 90, subjects: ["thread"], Entry: UsageEntryBlock },
  { id: "subagents", section: "activity", order: 100, subjects: ["thread"], Entry: SubagentsEntryBlock },
  { id: "background-commands", section: "activity", order: 105, subjects: ["thread"], Entry: BackgroundCommandsEntryBlock },
  { id: "pull-request", audience: "project", section: "lane", order: 110, subjects: ["thread"], Entry: PullRequestEntryBlock },
  { id: "browser", section: "activity", order: 120, subjects: ["thread"], Entry: BrowserEntryBlock, State: BrowserEntryState },
  { id: "sources", section: "activity", order: 130, subjects: ["thread"], Entry: SourcesEntryBlock },
  { id: "recap", section: "recap", order: 140, subjects: ["thread"], Entry: RecapEntryBlock, State: RecapEntryState },
];

/** Filters entries for the subject and its workspace kind, sorted by `order`. */
export function getOverviewEntries(subject: OverviewSubject, noProject = false): readonly OverviewEntry[] {
  return OVERVIEW_ENTRIES
    .filter(entry => entry.subjects.includes(subject.kind) && (entry.audience === undefined || (entry.audience === "no-project") === noProject))
    .sort((a, b) => a.order - b.order);
}
