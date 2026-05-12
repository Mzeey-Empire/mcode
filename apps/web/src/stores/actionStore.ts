/**
 * Zustand store for managing project actions per workspace.
 *
 * Handles loading, saving, deleting, reordering, and tracking last-used
 * actions. Calls transport methods added alongside this store
 * (actionList, actionSave, actionDelete, actionRun, actionReorder).
 */

import { create } from "zustand";
import type { Action } from "@mcode/contracts";
import { getTransport } from "@/transport";

/** State and actions for the action Zustand store. */
interface ActionState {
  /** Per-workspace action lists, keyed by workspaceId. */
  actionsByWorkspace: Record<string, Action[]>;
  /** Last-used action ID per workspace, keyed by workspaceId. */
  lastUsedByWorkspace: Record<string, string | null>;
  /** In-flight loading flag per workspace, keyed by workspaceId. */
  loading: Record<string, boolean>;

  /** Fetch the action list for a workspace from the server. */
  loadActions: (workspaceId: string) => Promise<void>;
  /** Trigger a run of a specific action within a thread. */
  runAction: (workspaceId: string, actionId: string, threadId: string) => Promise<void>;
  /** Persist an action (create or update). Updates local state optimistically. */
  saveAction: (workspaceId: string, action: Action) => Promise<void>;
  /** Delete an action and remove it from local state. */
  deleteAction: (workspaceId: string, actionId: string) => Promise<void>;
  /** Persist the display order for workspace actions. */
  reorderActions: (workspaceId: string, orderedIds: string[]) => Promise<void>;
  /** Push handler: re-fetches actions when the server signals a change. */
  handleActionsChanged: (workspaceId: string) => void;
  /** Push handler: records the last-run action for a workspace. */
  handleActionRan: (workspaceId: string, actionId: string) => void;
  /** Return the cached action list for a workspace (never undefined). */
  getActions: (workspaceId: string) => Action[];
  /**
   * Return the last-used action for a workspace.
   * Falls back to the first action if no last-used ID is recorded.
   */
  getLastUsed: (workspaceId: string) => Action | undefined;
}

/** Per-workspace Zustand store for project actions. */
export const useActionStore = create<ActionState>((set, get) => ({
  actionsByWorkspace: {},
  lastUsedByWorkspace: {},
  loading: {},

  loadActions: async (workspaceId) => {
    set((s) => ({ loading: { ...s.loading, [workspaceId]: true } }));
    try {
      const { actions, lastActionId } = await getTransport().actionList(workspaceId);
      set((s) => ({
        actionsByWorkspace: { ...s.actionsByWorkspace, [workspaceId]: actions },
        lastUsedByWorkspace: { ...s.lastUsedByWorkspace, [workspaceId]: lastActionId },
        loading: { ...s.loading, [workspaceId]: false },
      }));
    } catch {
      set((s) => ({ loading: { ...s.loading, [workspaceId]: false } }));
    }
  },

  runAction: async (workspaceId, actionId, threadId) => {
    await getTransport().actionRun(workspaceId, actionId, threadId);
    set((s) => ({
      lastUsedByWorkspace: { ...s.lastUsedByWorkspace, [workspaceId]: actionId },
    }));
  },

  saveAction: async (workspaceId, action) => {
    const saved = await getTransport().actionSave(workspaceId, action);
    set((s) => {
      const existing = s.actionsByWorkspace[workspaceId] ?? [];
      const idx = existing.findIndex((a) => a.id === saved.id);
      const updated = [...existing];
      if (idx >= 0) {
        updated[idx] = saved;
      } else {
        updated.push(saved);
      }
      // Enforce single-setup invariant: only one action may be flagged as setup.
      if (saved.setup) {
        for (const a of updated) {
          if (a.id !== saved.id) a.setup = false;
        }
      }
      return { actionsByWorkspace: { ...s.actionsByWorkspace, [workspaceId]: updated } };
    });
  },

  deleteAction: async (workspaceId, actionId) => {
    await getTransport().actionDelete(workspaceId, actionId);
    set((s) => {
      const existing = s.actionsByWorkspace[workspaceId] ?? [];
      return {
        actionsByWorkspace: {
          ...s.actionsByWorkspace,
          [workspaceId]: existing.filter((a) => a.id !== actionId),
        },
      };
    });
  },

  reorderActions: async (workspaceId, orderedIds) => {
    await getTransport().actionReorder(workspaceId, orderedIds);
    set((s) => {
      const existing = s.actionsByWorkspace[workspaceId] ?? [];
      const map = new Map(existing.map((a) => [a.id, a]));
      const reordered: Action[] = [];
      for (const id of orderedIds) {
        const a = map.get(id);
        if (a) reordered.push(a);
      }
      return { actionsByWorkspace: { ...s.actionsByWorkspace, [workspaceId]: reordered } };
    });
  },

  handleActionsChanged: (workspaceId) => {
    get().loadActions(workspaceId);
  },

  handleActionRan: (workspaceId, actionId) => {
    set((s) => ({
      lastUsedByWorkspace: { ...s.lastUsedByWorkspace, [workspaceId]: actionId },
    }));
  },

  getActions: (workspaceId) => get().actionsByWorkspace[workspaceId] ?? [],

  getLastUsed: (workspaceId) => {
    const actions = get().actionsByWorkspace[workspaceId] ?? [];
    const lastId = get().lastUsedByWorkspace[workspaceId];
    if (lastId) {
      const found = actions.find((a) => a.id === lastId);
      if (found) return found;
    }
    return actions[0];
  },
}));
