import { useCallback, useEffect, useState } from "react";
import type {
  WorkspaceEnvironmentReadResult,
  WorkspaceEnvironmentStorageMode,
  WorkspaceEnvironmentValidationIssue,
} from "@mcode/contracts";
import { getTransport, RpcError } from "@/transport";
import { useToastStore } from "@/stores/toastStore";
import { useProjectActionStore } from "../environment/state/project-action-store";
import { isDraftDirty, useProjectSettingsDraftStore, type ProjectSettingsDraft } from "./projectSettingsDraftStore";
import { jsonEqual, toSettingsIssue } from "./settings-model";

const STALE = "WORKSPACE_ENVIRONMENT_STALE";

function read(workspaceId: string, threadId: string | undefined): Promise<WorkspaceEnvironmentReadResult> {
  return threadId
    ? getTransport().readWorkspaceEnvironment(workspaceId, threadId)
    : getTransport().readWorkspaceEnvironment(workspaceId);
}

function serverIssues(error: unknown): WorkspaceEnvironmentValidationIssue[] {
  if (!(error instanceof RpcError) || !Array.isArray(error.data?.issues)) return [];
  return error.data.issues as WorkspaceEnvironmentValidationIssue[];
}

/** What the settings surface reads and does for one Project, backed by the in-memory draft store. */
export interface ProjectSettings {
  readonly entry: ProjectSettingsDraft | undefined;
  readonly dirty: boolean;
  readonly loadError: boolean;
  readonly busy: boolean;
  readonly save: () => Promise<void>;
  /** Drops edits and shows what is on disk now. */
  readonly reload: () => Promise<void>;
  /** Saves the draft over whatever changed on disk. */
  readonly keepMine: () => Promise<void>;
  readonly discard: () => void;
  readonly changeStorageMode: (mode: WorkspaceEnvironmentStorageMode) => Promise<void>;
  readonly forgetApproval: (actionId: string) => Promise<void>;
}

/**
 * Loads a Project's environment into the draft store and exposes its save, conflict and storage
 * operations. Reopening the tab re-reads the file: a changed revision under a clean draft is adopted
 * silently, and under unsaved edits it raises the conflict banner.
 */
export function useProjectSettings(workspaceId: string, threadId: string | undefined, active: boolean): ProjectSettings {
  const entry = useProjectSettingsDraftStore((state) => state.drafts[workspaceId]);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = isDraftDirty(entry);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    read(workspaceId, threadId).then(
      (fresh) => {
        if (cancelled) return;
        setLoadError(false);
        const store = useProjectSettingsDraftStore.getState();
        const current = store.drafts[workspaceId];
        if (!current || !isDraftDirty(current)) store.adopt(workspaceId, fresh);
        else if (current.base.revision !== fresh.revision) store.setConflict(workspaceId, true);
      },
      () => {
        if (!cancelled) setLoadError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, threadId, workspaceId]);

  const saveDraft = useCallback(async (revision: string | null) => {
    const store = useProjectSettingsDraftStore.getState();
    const current = store.drafts[workspaceId];
    if (!current) return;
    setBusy(true);
    try {
      const result = threadId
        ? await getTransport().saveWorkspaceEnvironment(workspaceId, current.draft, revision, threadId)
        : await getTransport().saveWorkspaceEnvironment(workspaceId, current.draft, revision);
      const latest = useProjectSettingsDraftStore.getState().drafts[workspaceId];
      // Edits typed while the save was in flight stay as the new draft over the saved base.
      if (latest && !jsonEqual(latest.draft, current.draft)) store.patchBase(workspaceId, result);
      else store.adopt(workspaceId, result);
      useProjectActionStore.getState().invalidateWorkspaceConfiguration(workspaceId);
    } catch (error) {
      if (error instanceof RpcError && error.code === STALE) store.setConflict(workspaceId, true);
      else {
        const issues = serverIssues(error).map((issue) => toSettingsIssue(issue, current.draft));
        if (issues.length > 0) store.setIssues(workspaceId, issues);
        else useToastStore.getState().show({ kind: "failed", title: "Project settings could not be saved" });
      }
    } finally {
      setBusy(false);
    }
  }, [threadId, workspaceId]);

  const save = useCallback(
    () => saveDraft(useProjectSettingsDraftStore.getState().drafts[workspaceId]?.base.revision ?? null),
    [saveDraft, workspaceId],
  );

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      useProjectSettingsDraftStore.getState().adopt(workspaceId, await read(workspaceId, threadId));
    } catch {
      useToastStore.getState().show({ kind: "failed", title: "Project settings could not be reloaded" });
    } finally {
      setBusy(false);
    }
  }, [threadId, workspaceId]);

  const keepMine = useCallback(async () => {
    try {
      const fresh = await read(workspaceId, threadId);
      await saveDraft(fresh.revision);
    } catch {
      useToastStore.getState().show({ kind: "failed", title: "Project settings could not be saved" });
    }
  }, [saveDraft, threadId, workspaceId]);

  const discard = useCallback(() => {
    const current = useProjectSettingsDraftStore.getState().drafts[workspaceId];
    if (current) useProjectSettingsDraftStore.getState().adopt(workspaceId, current.base);
  }, [workspaceId]);

  const changeStorageMode = useCallback(async (mode: WorkspaceEnvironmentStorageMode) => {
    setBusy(true);
    try {
      const result = threadId
        ? await getTransport().setWorkspaceEnvironmentStorageMode(workspaceId, mode, threadId)
        : await getTransport().setWorkspaceEnvironmentStorageMode(workspaceId, mode);
      useProjectSettingsDraftStore.getState().adopt(workspaceId, result);
      useProjectActionStore.getState().invalidateWorkspaceConfiguration(workspaceId);
    } catch {
      useToastStore.getState().show({ kind: "failed", title: "Storage could not be changed" });
    } finally {
      setBusy(false);
    }
  }, [threadId, workspaceId]);

  const forgetApproval = useCallback(async (actionId: string) => {
    try {
      await getTransport().forgetWorkspaceEnvironmentApproval(workspaceId, actionId);
      const approved = useProjectSettingsDraftStore.getState().drafts[workspaceId]?.base.approvedActionIds ?? [];
      useProjectSettingsDraftStore.getState().patchBase(workspaceId, {
        approvedActionIds: approved.filter((id) => id !== actionId),
      });
    } catch {
      useToastStore.getState().show({ kind: "failed", title: "Approval could not be forgotten" });
    }
  }, [workspaceId]);

  return { entry, dirty, loadError, busy, save, reload, keepMine, discard, changeStorageMode, forgetApproval };
}
