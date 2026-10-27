import { create } from "zustand";
import type { WorkspaceEnvironmentDocument, WorkspaceEnvironmentReadResult } from "@mcode/contracts/models/workspace-environment";
import { jsonEqual, type SettingsIssue } from "./settings-model";

/** One Project's unsaved edit session: what the disk held, what the user changed it to, and what is open. */
export interface ProjectSettingsDraft {
  /** The last read or saved result. Its revision is what Save sends, so a stale write is refused. */
  readonly base: WorkspaceEnvironmentReadResult;
  readonly draft: WorkspaceEnvironmentDocument;
  readonly expandedActionId: string | null;
  readonly issues: readonly SettingsIssue[];
  /** The file changed under unsaved edits, so Save would overwrite someone else's change. */
  readonly conflict: boolean;
}

interface ProjectSettingsDraftState {
  readonly drafts: Readonly<Record<string, ProjectSettingsDraft>>;
  /** Replaces the Project's session with a clean copy of `result`, dropping any edits, issues and conflict. */
  adopt: (workspaceId: string, result: WorkspaceEnvironmentReadResult) => void;
  /** Applies an edit to the draft and clears issues, which the next Save recomputes. */
  edit: (workspaceId: string, update: (draft: WorkspaceEnvironmentDocument) => WorkspaceEnvironmentDocument) => void;
  setExpanded: (workspaceId: string, actionId: string | null) => void;
  setIssues: (workspaceId: string, issues: readonly SettingsIssue[]) => void;
  setConflict: (workspaceId: string, conflict: boolean) => void;
  /** Replaces the base without touching the draft, for changes that are not document edits such as approvals. */
  patchBase: (workspaceId: string, patch: Partial<WorkspaceEnvironmentReadResult>) => void;
}

function mapDraft(
  state: ProjectSettingsDraftState,
  workspaceId: string,
  update: (current: ProjectSettingsDraft) => ProjectSettingsDraft,
): Pick<ProjectSettingsDraftState, "drafts"> | ProjectSettingsDraftState {
  const current = state.drafts[workspaceId];
  if (!current) return state;
  return { drafts: { ...state.drafts, [workspaceId]: update(current) } };
}

/**
 * Unsaved Project settings, in memory per Project. A draft outlives tab, thread and panel
 * switches because the store is module state, and is gone on app restart by design.
 */
export const useProjectSettingsDraftStore = create<ProjectSettingsDraftState>((set) => ({
  drafts: {},
  adopt: (workspaceId, result) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [workspaceId]: {
          base: result,
          draft: result.document,
          expandedActionId: state.drafts[workspaceId]?.expandedActionId ?? null,
          issues: [],
          conflict: false,
        },
      },
    })),
  edit: (workspaceId, update) =>
    set((state) => mapDraft(state, workspaceId, (current) => ({ ...current, draft: update(current.draft), issues: [] }))),
  setExpanded: (workspaceId, actionId) =>
    set((state) => mapDraft(state, workspaceId, (current) => ({ ...current, expandedActionId: actionId }))),
  setIssues: (workspaceId, issues) => set((state) => mapDraft(state, workspaceId, (current) => ({ ...current, issues }))),
  setConflict: (workspaceId, conflict) =>
    set((state) => mapDraft(state, workspaceId, (current) => ({ ...current, conflict }))),
  patchBase: (workspaceId, patch) =>
    set((state) => mapDraft(state, workspaceId, (current) => ({ ...current, base: { ...current.base, ...patch } }))),
}));

/** Whether the draft differs from what was last read or saved. */
export function isDraftDirty(entry: ProjectSettingsDraft | undefined): boolean {
  return entry !== undefined && !jsonEqual(entry.draft, entry.base.document);
}
