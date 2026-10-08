import type { ComponentType, ReactNode } from "react";
import { BranchEntryBlock, BranchEntryState } from "./entries/branch";
import { BrowserEntryBlock } from "./entries/browser";
import { ChangesEntryBlock, ChangesEntryState } from "./entries/changes";
import { CommitEntryBlock } from "./entries/commit";
import { CreateBranchEntryBlock } from "./entries/create-branch";
import { LocalEntryBlock, LocalEntryState } from "./entries/local";
import { PlansEntryBlock } from "./entries/plans";
import { PullRequestEntryBlock } from "./entries/pull-request";
import { RecapEntryBlock, RecapEntryState } from "./entries/recap";
import { RepositoryEntryBlock, RepositoryEntryState } from "./entries/repository";
import { SaveRecoveryEntryBlock } from "./entries/save-recovery";
import { SetupEntryBlock } from "./entries/setup";
import { SourcesEntryBlock } from "./entries/sources";
import { SubagentsEntryBlock } from "./entries/subagents";
import { UsageEntryBlock } from "./entries/usage";
import { OverviewProjectActions, OverviewProjectActionsState, OverviewProjectSettings } from "./header-actions";
import type { OverviewSubject } from "./overview-subject";

/** Card sections for the later grouped overview layout. */
export type OverviewSectionId = "lane" | "activity" | "terminals" | "summary";

/** One registered block of the overview card. */
export interface OverviewEntry {
  readonly id: string;
  readonly section: OverviewSectionId;
  readonly order: number;
  readonly subjects: readonly OverviewSubject["kind"][];
  /** Renders null when there is nothing to show. */
  readonly Entry: ComponentType<{ subject: OverviewSubject }>;
  /** Owns state that must survive the row unmounting when the overview closes. */
  readonly State?: ComponentType<{ subject: OverviewSubject; children: ReactNode }>;
}

/** Header icon buttons beside the Overview label. */
export interface OverviewHeaderAction {
  readonly id: string;
  readonly order: number;
  readonly subjects: readonly OverviewSubject["kind"][];
  readonly Action: ComponentType<{ subject: OverviewSubject }>;
  /** Owns state that must survive the button unmounting when the overview closes. */
  readonly State?: ComponentType<{ subject: OverviewSubject; children: ReactNode }>;
}

/** Body entries in the existing visual order; section grouping belongs to S03-02. */
export const OVERVIEW_ENTRIES: readonly OverviewEntry[] = [
  { id: "setup", section: "lane", order: 0, subjects: ["thread"], Entry: SetupEntryBlock },
  { id: "save-recovery", section: "activity", order: 10, subjects: ["thread"], Entry: SaveRecoveryEntryBlock },
  { id: "changes", section: "activity", order: 20, subjects: ["thread"], Entry: ChangesEntryBlock, State: ChangesEntryState },
  { id: "repository", section: "activity", order: 30, subjects: ["thread"], Entry: RepositoryEntryBlock, State: RepositoryEntryState },
  { id: "plans", section: "activity", order: 40, subjects: ["thread"], Entry: PlansEntryBlock },
  { id: "local", section: "lane", order: 50, subjects: ["thread"], Entry: LocalEntryBlock, State: LocalEntryState },
  { id: "create-branch", section: "lane", order: 60, subjects: ["thread"], Entry: CreateBranchEntryBlock },
  { id: "branch", section: "lane", order: 70, subjects: ["thread"], Entry: BranchEntryBlock, State: BranchEntryState },
  { id: "commit", section: "lane", order: 80, subjects: ["thread"], Entry: CommitEntryBlock },
  { id: "usage", section: "summary", order: 90, subjects: ["thread"], Entry: UsageEntryBlock },
  { id: "subagents", section: "activity", order: 100, subjects: ["thread"], Entry: SubagentsEntryBlock },
  { id: "pull-request", section: "lane", order: 110, subjects: ["thread"], Entry: PullRequestEntryBlock },
  { id: "browser", section: "activity", order: 120, subjects: ["thread"], Entry: BrowserEntryBlock },
  { id: "sources", section: "activity", order: 130, subjects: ["thread"], Entry: SourcesEntryBlock },
  { id: "recap", section: "summary", order: 140, subjects: ["thread"], Entry: RecapEntryBlock, State: RecapEntryState },
];

/** Header actions in their existing visual order. */
export const OVERVIEW_HEADER_ACTIONS: readonly OverviewHeaderAction[] = [
  { id: "project-actions", order: 0, subjects: ["thread"], Action: OverviewProjectActions, State: OverviewProjectActionsState },
  { id: "settings", order: 10, subjects: ["thread"], Action: OverviewProjectSettings },
];

/** Filters entries for the subject and preserves the current global row order. */
export function getOverviewEntries(subject: OverviewSubject): readonly OverviewEntry[] {
  return OVERVIEW_ENTRIES.filter(entry => entry.subjects.includes(subject.kind)).sort((a, b) => a.order - b.order);
}

/** Filters and orders the header buttons for the current subject. */
export function getOverviewHeaderActions(subject: OverviewSubject): readonly OverviewHeaderAction[] {
  return OVERVIEW_HEADER_ACTIONS.filter(action => action.subjects.includes(subject.kind)).sort((a, b) => a.order - b.order);
}
