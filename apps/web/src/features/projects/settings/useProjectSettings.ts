import { useCallback, useEffect, useState } from "react";
import type { WorkspaceEnvironmentDocument, WorkspaceEnvironmentReadResult, WorkspaceEnvironmentStorageMode, WorkspaceEnvironmentValidationIssue } from "@mcode/contracts/models/workspace-environment";
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

/**
 * Installs a server result as the new base. Edits typed while the request was in flight stay as the
 * draft over it instead of being replaced.
 */
function settle(workspaceId: string, result: WorkspaceEnvironmentReadResult, sentDraft: WorkspaceEnvironmentDocument | undefined): void {
  const store = useProjectSettingsDraftStore.getState();
  const latest = store.drafts[workspaceId];
  if (latest && sentDraft && !jsonEqual(latest.draft, sentDraft)) {
    store.patchBase(workspaceId, result);
    // The new base is the file as it is now, so nothing is left to conflict with.
    store.setConflict(workspaceId, false);
  } else store.adopt(workspaceId, result);
}

/** Turns a failed save into a conflict, field-level issues or a toast, whichever the server's answer calls for. */
function reportSaveFailure(workspaceId: string, error: unknown, sentDraft: WorkspaceEnvironmentDocument): void {
  const store = useProjectSettingsDraftStore.getState();
  if (error instanceof RpcError && error.code === STALE) {
    store.setConflict(workspaceId, true);
    return;
  }
  const issues = serverIssues(error).map((issue) => toSettingsIssue(issue, sentDraft));
  if (issues.length === 0) {
    useToastStore.getState().show({ kind: "failed", title: "Project settings could not be saved" });
    return;
  }
  // Issues describe the draft that was sent, so a draft edited meanwhile is left to the next Save to judge.
  const latest = store.drafts[workspaceId];
  if (latest && jsonEqual(latest.draft, sentDraft)) store.setIssues(workspaceId, issues);
}

/** What the settings surface reads and does for one Project, backed by the in-memory draft store. */
export interface ProjectSettings {
  readonly entry: ProjectSettingsDraft | undefined;
  readonly dirty: boolean;
  readonly loadError: boolean;
  /** Whether the document shown was read for the current thread and no conflict is open, which Play needs. */
  readonly syncedWithThread: boolean;
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
  const [syncedKey, setSyncedKey] = useState<string | null>(null);
  const threadKey = `${workspaceId}:${threadId ?? ""}`;
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
        else if (current.base.revision !== fresh.revision) {
          store.setConflict(workspaceId, true);
          return;
        }
        setSyncedKey(threadKey);
      },
      () => {
        if (!cancelled) setLoadError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, threadId, threadKey, workspaceId]);

  const saveDraft = useCallback(async (revision: string | null) => {
    const store = useProjectSettingsDraftStore.getState();
    const current = store.drafts[workspaceId];
    if (!current) return;
    setBusy(true);
    try {
      const result = threadId
        ? await getTransport().saveWorkspaceEnvironment(workspaceId, current.draft, revision, threadId)
        : await getTransport().saveWorkspaceEnvironment(workspaceId, current.draft, revision);
      useProjectActionStore.getState().invalidateWorkspaceConfiguration(workspaceId);
      // A read for another thread flagged a conflict while this save was in flight, so `result` is
      // that other checkout's document and installing it would show the wrong actions.
      const conflictedMeanwhile = !current.conflict && useProjectSettingsDraftStore.getState().drafts[workspaceId]?.conflict;
      if (conflictedMeanwhile) return;
      settle(workspaceId, result, current.draft);
      setSyncedKey(threadKey);
    } catch (error) {
      reportSaveFailure(workspaceId, error, current.draft);
    } finally {
      setBusy(false);
    }
  }, [threadId, threadKey, workspaceId]);

  // Reverting the draft hides the banner, so the conflict has to resolve itself by re-reading the file.
  const conflictResolvable = active && entry?.conflict === true && !dirty;
  useEffect(() => {
    if (!conflictResolvable) return;
    let cancelled = false;
    read(workspaceId, threadId).then(
      (fresh) => {
        const current = useProjectSettingsDraftStore.getState().drafts[workspaceId];
        if (cancelled || isDraftDirty(current)) return;
        useProjectSettingsDraftStore.getState().adopt(workspaceId, fresh);
        setSyncedKey(threadKey);
      },
      () => {
        if (!cancelled) setLoadError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [conflictResolvable, threadId, threadKey, workspaceId]);

  const save = useCallback(
    () => saveDraft(useProjectSettingsDraftStore.getState().drafts[workspaceId]?.base.revision ?? null),
    [saveDraft, workspaceId],
  );

  const reload = useCallback(async () => {
    setBusy(true);
    const startedWith = useProjectSettingsDraftStore.getState().drafts[workspaceId]?.draft;
    try {
      settle(workspaceId, await read(workspaceId, threadId), startedWith);
      setSyncedKey(threadKey);
    } catch {
      useToastStore.getState().show({ kind: "failed", title: "Project settings could not be reloaded" });
    } finally {
      setBusy(false);
    }
  }, [threadId, threadKey, workspaceId]);

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
    const startedWith = useProjectSettingsDraftStore.getState().drafts[workspaceId]?.draft;
    try {
      const result = threadId
        ? await getTransport().setWorkspaceEnvironmentStorageMode(workspaceId, mode, threadId)
        : await getTransport().setWorkspaceEnvironmentStorageMode(workspaceId, mode);
      settle(workspaceId, result, startedWith);
      setSyncedKey(threadKey);
      useProjectActionStore.getState().invalidateWorkspaceConfiguration(workspaceId);
    } catch {
      useToastStore.getState().show({ kind: "failed", title: "Storage could not be changed" });
    } finally {
      setBusy(false);
    }
  }, [threadId, threadKey, workspaceId]);

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

  const syncedWithThread = syncedKey === threadKey && entry?.conflict !== true;
  return { entry, dirty, loadError, syncedWithThread, busy, save, reload, keepMine, discard, changeStorageMode, forgetApproval };
}
