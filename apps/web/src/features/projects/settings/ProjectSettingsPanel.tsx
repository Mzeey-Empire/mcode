import { useState } from "react";
import { Plus, Settings } from "lucide-react";
import type { WorkspaceEnvironmentAction, WorkspaceEnvironmentStorageMode } from "@mcode/contracts";
import { PanelHeaderSlot, PanelTitlePill } from "@/components/panels/shell/PanelHeader";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { applyActionRun } from "@/features/terminal/state/applyActionRun";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { openRightPanelTab } from "@/lib/right-panel-layout";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";
import type { ActionPlay } from "./ActionEditor";
import { ActionsSection } from "./ActionsSection";
import { EnvironmentConflictBanner } from "./EnvironmentConflictBanner";
import { useProjectSettingsDraftStore } from "./projectSettingsDraftStore";
import { SettingsSaveBar } from "./SettingsSaveBar";
import { jsonEqual, newAction, validateDocument, type SettingsIssue } from "./settings-model";
import { useProjectSettings } from "./useProjectSettings";

const STORAGE_OPTIONS = [
  { value: "system", label: "This computer" },
  { value: "shared", label: "In repo" },
] as const;

const DIRTY_STORAGE_REASON = "Save or discard changes first.";

function StorageRow({ mode, locked, onChange }: {
  readonly mode: WorkspaceEnvironmentStorageMode;
  readonly locked: boolean;
  readonly onChange: (mode: WorkspaceEnvironmentStorageMode) => void;
}) {
  return (
    <div className="flex h-10 items-center justify-between gap-2 px-1">
      <span className="text-caption text-muted">Saved on</span>
      <SegmentedControl
        size="compact"
        aria-label="Saved on"
        value={mode}
        onChange={(value) => onChange(value as WorkspaceEnvironmentStorageMode)}
        options={STORAGE_OPTIONS.map((option) => ({
          ...option,
          disabled: locked,
          title: locked ? DIRTY_STORAGE_REASON : undefined,
        }))}
      />
    </div>
  );
}

/** Splits issues into the one under each action and the first that belongs to the whole document. */
function groupIssues(issues: readonly SettingsIssue[]) {
  const byAction = new Map<string, string>();
  let document: string | null = null;
  for (const issue of issues) {
    if (issue.actionId === null) document ??= issue.message;
    else if (!byAction.has(issue.actionId)) byAction.set(issue.actionId, issue.message);
  }
  return { byAction, document };
}

function startAction(workspaceId: string, threadId: string, action: WorkspaceEnvironmentAction): void {
  openRightPanelTab(workspaceId, threadId, "terminal");
  getTransport().startWorkspaceAction(threadId, action.id).then(
    (run) => applyActionRun(run, { focus: true }),
    () => useToastStore.getState().show({ kind: "failed", title: "Project Action could not start" }),
  );
}

/**
 * Right-panel editor for a Project's actions. Edits live in the draft store until Save, so they
 * survive switching threads or tabs; the save bar and conflict banner appear only when needed.
 */
export function ProjectSettingsPanel({ workspaceId, threadId, active = true }: {
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly active?: boolean;
}) {
  const projectName = useWorkspaceStore((state) =>
    state.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "Unknown project",
  );
  const settings = useProjectSettings(workspaceId, threadId, active);
  const [newActionId, setNewActionId] = useState<string | null>(null);
  const { entry, dirty } = settings;
  const edit = useProjectSettingsDraftStore((state) => state.edit);
  const setExpanded = useProjectSettingsDraftStore((state) => state.setExpanded);

  const addAction = () => {
    const action = newAction();
    edit(workspaceId, (draft) => ({ ...draft, actions: [...draft.actions, action] }));
    setExpanded(workspaceId, action.id);
    setNewActionId(action.id);
  };

  const playFor = (action: WorkspaceEnvironmentAction): ActionPlay => {
    const saved = entry?.base.document.actions.find((candidate) => candidate.id === action.id);
    if (!threadId) return { disabledReason: "Open a thread to run actions.", run: () => undefined };
    // Runs read the saved file, so an unsaved or edited action would run something other than what is shown.
    if (!saved || !jsonEqual(saved, action)) return { disabledReason: "Save to run this action.", run: () => undefined };
    return { disabledReason: null, run: () => startAction(workspaceId, threadId, action) };
  };

  const header = (
    <PanelHeaderSlot slot="leading">
      <PanelTitlePill id="project-settings-title" headingLevel={1} icon={<Settings className="size-3.5" aria-hidden />}>
        {projectName}
      </PanelTitlePill>
    </PanelHeaderSlot>
  );
  const addButton = (
    <PanelHeaderSlot slot="row2">
      <Button variant="subtle" shape="round" className="ml-auto text-body-small" disabled={!entry} onClick={addAction}>
        <Plus aria-hidden />
        Action
      </Button>
    </PanelHeaderSlot>
  );

  if (!entry) {
    return (
      <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="project-settings-title">
        {header}
        {addButton}
        <p role="status" className="px-3 py-2 text-caption text-muted">
          {settings.loadError ? "Settings could not be loaded." : "Loading"}
        </p>
      </section>
    );
  }

  const issues = groupIssues([...validateDocument(entry.draft), ...entry.issues]);
  const storageMode = entry.base.storageMode ?? "system";
  const canSave = dirty && issues.byAction.size === 0 && issues.document === null;

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="project-settings-title">
      {header}
      {addButton}
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pt-1 pb-2">
        {entry.conflict ? (
          <EnvironmentConflictBanner
            storageMode={storageMode}
            busy={settings.busy}
            onKeepMine={() => void settings.keepMine()}
            onReload={() => void settings.reload()}
          />
        ) : null}
        <StorageRow mode={storageMode} locked={dirty} onChange={(mode) => void settings.changeStorageMode(mode)} />
        <ActionsSection
          actions={entry.draft.actions}
          expandedActionId={entry.expandedActionId}
          focusNameActionId={newActionId}
          approvedActionIds={entry.base.approvedActionIds ?? []}
          issueFor={(actionId) => issues.byAction.get(actionId) ?? null}
          playFor={playFor}
          onExpand={(actionId) => setExpanded(workspaceId, actionId)}
          onChange={(next) =>
            edit(workspaceId, (draft) => ({
              ...draft,
              actions: draft.actions.map((candidate) => (candidate.id === next.id ? next : candidate)),
            }))
          }
          onRemove={(actionId) => {
            edit(workspaceId, (draft) => ({ ...draft, actions: draft.actions.filter((candidate) => candidate.id !== actionId) }));
            setExpanded(workspaceId, null);
          }}
          onForgetApproval={(actionId) => void settings.forgetApproval(actionId)}
        />
      </div>
      {dirty ? (
        <SettingsSaveBar
          problem={issues.document}
          canSave={canSave}
          busy={settings.busy}
          onDiscard={settings.discard}
          onSave={() => void settings.save()}
        />
      ) : null}
    </section>
  );
}
