import type { Settings, ProviderAvailability } from "@mcode/contracts";
import type { PermissionRequest, PermissionDecision } from "@mcode/contracts";
import { pushEmitter } from "./ws-transport";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { useThreadStore } from "@/stores/threadStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useSkillsStore } from "@/stores/skillsStore";
import { clearFileListCache } from "@/components/chat/useFileAutocomplete";

/** Unsubscribe handles for all push listeners. */
let unsubs: (() => void)[] = [];

/** Encoder reused across all legacy JSON terminal.data frames. */
const _legacyEncoder = new TextEncoder();

/**
 * Wire up push channel listeners that forward server events to the
 * appropriate Zustand stores. Call once at app startup.
 *
 * Push channels handled:
 * - `agent.event` -- agent stream events forwarded to threadStore
 * - `terminal.data` -- PTY output forwarded to xterm instances via custom DOM event
 * - `terminal.exit` -- PTY exit forwarded via custom DOM event
 * - `thread.status` -- thread status changes reflected in threadStore
 * - `thread.prLinked` -- PR detected for a thread, updates pr_number/pr_status
 * - `thread.checksUpdated` -- CI check status polled for a thread's PR, updates checksById
 * - `thread.modelUpdated` -- thread model and provider synced after a message send (multi-client)
 * - `files.changed` -- invalidates the file autocomplete cache
 * - `skills.changed` -- invalidates the skill cache; popup re-fetches on next open
 * - `turn.persisted` -- tool call persistence confirmation forwarded to threadStore
 * - `settings.changed` -- server-pushed settings updates forwarded to settingsStore
 * - `branch.changed` -- refreshes branch list and updates current branch if not manually overridden
 * - `plan.questions` -- model-proposed plan questions forwarded to threadStore wizard
 * - `plan.answered` -- server committed an answered marker; dismisses the wizard on this client
 * - `permission.request` -- tool permission awaiting user decision
 * - `permission.resolved` -- a permission was settled (by user or session stop)
 * - `providers.availability` -- server-pushed provider availability snapshot forwarded to providerAvailabilityStore
 * - `workspace.gitStatusChanged` -- workspace git status changed (e.g. non-git folder became a repo), updates is_git_repo flag
 * - `workspace.orderChanged` -- sidebar project order changed on the server; refreshes workspace list
 * - `workspace.deleted` -- workspace hard-delete complete; removes it from local state
 * - `workspace.deleteFailed` -- workspace deletion permanently stuck; reloads workspace list
 */
export function startPushListeners(): void {
  // Guard against double-init
  stopPushListeners();

  const handleAgentEvent = useThreadStore.getState().handleAgentEvent;

  // agent.event: the server wraps each sidecar event with { threadId, type, ... }
  unsubs.push(
    pushEmitter.on("agent.event", (data) => {
      const event = data as Record<string, unknown>;
      const threadId = event.threadId as string;
      if (!threadId) return;

      // Map the flat contract AgentEvent into the method-keyed shape
      // that handleAgentEvent expects (method = "session.<type>").
      const type = event.type as string;
      const method = `session.${type}`;
      handleAgentEvent(threadId, { method, ...event });
    }),
  );

  // terminal.data: broadcast to TerminalView instances via CustomEvent
  unsubs.push(
    pushEmitter.on("terminal.data", (data) => {
      // Binary path (preferred): { ptyId, seq, payload: Uint8Array }
      // Legacy JSON fallback: { ptyId, data: string, seq?: number }
      let detail: { ptyId: string; payload: Uint8Array; seq: number };
      const d = data as Record<string, unknown>;
      if (d["payload"] instanceof Uint8Array) {
        detail = {
          ptyId: d["ptyId"] as string,
          seq: d["seq"] as number,
          payload: d["payload"] as Uint8Array,
        };
      } else if (Array.isArray(d["payload"])) {
        // IPC path (current): the socket adapter serializes via JSON.stringify;
        // the server converts to number[] so it survives the round-trip.
        detail = {
          ptyId: d["ptyId"] as string,
          seq: d["seq"] as number,
          payload: new Uint8Array(d["payload"] as number[]),
        };
      } else if (d["payload"] && typeof d["payload"] === "object") {
        // IPC fallback for older servers that sent a raw Uint8Array through
        // JSON.stringify — it arrives as an indexed object {"0":72,"1":101,...}.
        // Object.values gives us the bytes in ascending-key order.
        detail = {
          ptyId: d["ptyId"] as string,
          seq: d["seq"] as number,
          payload: new Uint8Array(Object.values(d["payload"] as Record<string, number>)),
        };
      } else {
        // Legacy JSON fallback: older servers send { ptyId, data: string, seq? }.
        // Guard: skip malformed frames where data is not a string.
        if (typeof d["data"] !== "string") return;
        detail = {
          ptyId: d["ptyId"] as string,
          payload: _legacyEncoder.encode(d["data"]),
          seq: (d["seq"] as number | undefined) ?? 0,
        };
      }
      window.dispatchEvent(new CustomEvent("mcode:pty-data", { detail }));
    }),
  );

  // terminal.exit: broadcast exit event
  unsubs.push(
    pushEmitter.on("terminal.exit", (data) => {
      const payload = data as { ptyId: string; code: number };
      window.dispatchEvent(
        new CustomEvent("mcode:pty-exit", { detail: payload }),
      );
      // Remove the terminal from the store after a brief delay so the
      // exit message has time to render.
      setTimeout(() => {
        useTerminalStore.getState().removeTerminal(payload.ptyId);
      }, 2000);
    }),
  );

  // thread.status: update running state in the thread store
  unsubs.push(
    pushEmitter.on("thread.status", (data) => {
      const { threadId, status } = data as {
        threadId: string;
        status: string;
      };
      useWorkspaceStore.setState((ws) => ({
        threads: ws.threads.map((t) =>
          t.id === threadId ? { ...t, status: status as typeof t.status } : t,
        ),
      }));
    }),
  );

  // thread.prLinked: a PR was detected and linked to a thread
  unsubs.push(
    pushEmitter.on("thread.prLinked", (data) => {
      const { threadId, prNumber, prStatus } = data as {
        threadId: string;
        prNumber: number;
        prStatus: string;
      };
      useWorkspaceStore.setState((ws) => ({
        threads: ws.threads.map((t) =>
          t.id === threadId ? { ...t, pr_number: prNumber, pr_status: prStatus } : t,
        ),
      }));
    }),
  );

  // thread.checksUpdated: CI check status polled for a thread's PR
  unsubs.push(
    pushEmitter.on("thread.checksUpdated", (data) => {
      const { threadId, checks } = data as {
        threadId: string;
        checks: import("@mcode/contracts").ChecksStatus;
      };
      useWorkspaceStore.setState((ws) => ({
        checksById: { ...ws.checksById, [threadId]: checks },
      }));
    }),
  );

  // thread.modelUpdated: thread row model/provider persisted for this send (multi-tab / client)
  unsubs.push(
    pushEmitter.on("thread.modelUpdated", (data) => {
      const { threadId, model, provider } = data as {
        threadId: string;
        model: string;
        provider: string;
      };
      if (!threadId || !model) return;
      useWorkspaceStore.setState((ws) => ({
        threads: ws.threads.map((t) =>
          t.id === threadId ? { ...t, model, provider } : t,
        ),
      }));
    }),
  );

  // files.changed: invalidate file autocomplete cache
  unsubs.push(
    pushEmitter.on("files.changed", (data) => {
      const { workspaceId, threadId } = data as {
        workspaceId: string;
        threadId?: string;
      };
      clearFileListCache(workspaceId, threadId);
    }),
  );

  // skills.changed: invalidate skill cache so the popup re-fetches on next open
  unsubs.push(
    pushEmitter.on("skills.changed", () => {
      useSkillsStore.getState().invalidate();
    }),
  );

  // turn.persisted: server has persisted tool calls for a completed turn
  unsubs.push(
    pushEmitter.on("turn.persisted", (data) => {
      const payload = data as {
        threadId: string;
        messageId: string;
        toolCallCount: number;
        filesChanged: string[];
      };
      useThreadStore.getState().handleTurnPersisted(payload);

      const snap = useDiffStore.getState();
      const hasSnapshots = snap.snapshotsByThread[payload.threadId] !== undefined;
      const hasCommits = snap.commitsByThread[payload.threadId] !== undefined;
      if (!hasSnapshots && !hasCommits) return;

      try {
        const transport = getTransport();
        if (hasSnapshots) {
          transport
            .listSnapshots(payload.threadId)
            .then((snapshots) =>
              useDiffStore.getState().setSnapshots(payload.threadId, snapshots),
            )
            .catch(() => { /* non-critical */ });
        }

        if (hasCommits) {
          const thread = useWorkspaceStore
            .getState()
            .threads.find((t) => t.id === payload.threadId);
          if (!thread) return;
          transport
            .getGitLog(thread.workspace_id, thread.branch, 100)
            .then((commits) => {
              const current = useDiffStore.getState().commitsByThread[payload.threadId];
              if (
                current &&
                commits.length === current.length &&
                commits.every((c, i) => c.sha === current[i].sha)
              ) {
                return;
              }
              useDiffStore.getState().setCommits(payload.threadId, commits);
            })
            .catch(() => { /* non-critical */ });
        }
      } catch {
        // Transport not initialized — ignore (startup race / tests).
      }
    }),
  );

  // settings.changed: update settings store with server-pushed changes
  unsubs.push(
    pushEmitter.on("settings.changed", (data) => {
      const settings = data as Settings;
      useSettingsStore.getState()._applyPush(settings);
    }),
  );

  // branch.changed: refresh branch list and update current branch if not manually overridden
  unsubs.push(
    pushEmitter.on("branch.changed", (data) => {
      const { workspaceId, branch } = data as { workspaceId: string; branch: string | null };
      const state = useWorkspaceStore.getState();
      // Only refresh if this event is for the active workspace
      if (state.activeWorkspaceId === workspaceId) {
        state.loadBranches(workspaceId);
        if (!state.branchManuallySelected && branch) {
          state.setNewThreadBranch(branch);
        }
      }
    }),
  );

  // workspace.gitStatusChanged: update is_git_repo flag when a non-git workspace becomes a git repo
  unsubs.push(
    pushEmitter.on("workspace.gitStatusChanged", (data) => {
      const { workspaceId, isGitRepo } = data as { workspaceId: string; isGitRepo: boolean };
      useWorkspaceStore.setState((state) => ({
        workspaces: state.workspaces.map((w) =>
          w.id === workspaceId ? { ...w, is_git_repo: isGitRepo } : w,
        ),
      }));
    }),
  );

  unsubs.push(
    pushEmitter.on("workspace.orderChanged", () => {
      void useWorkspaceStore.getState().loadWorkspaces();
    }),
  );

  // workspace.deleted: remove the workspace from local state when hard-delete completes
  unsubs.push(
    pushEmitter.on("workspace.deleted", (data) => {
      const { workspaceId } = data as { workspaceId: string };
      const store = useWorkspaceStore.getState();
      if (store.activeWorkspaceId === workspaceId) {
        store.setActiveWorkspace(null);
      }
      store.removeWorkspaceFromState(workspaceId);
    }),
  );

  // workspace.deleteFailed: reload workspaces so stuck state is reflected
  unsubs.push(
    pushEmitter.on("workspace.deleteFailed", (data) => {
      const { workspaceId, reason } = data as { workspaceId: string; reason: string };
      void useWorkspaceStore.getState().loadWorkspaces();
      console.error(`Workspace ${workspaceId} deletion failed: ${reason}`);
    }),
  );

  // plan.questions: model proposed clarifying questions in plan mode
  unsubs.push(
    pushEmitter.on("plan.questions", (data) => {
      const { threadId, questions } = data as {
        threadId: string;
        questions: import("@mcode/contracts").PlanQuestion[];
      };
      if (!threadId || !Array.isArray(questions)) return;
      useThreadStore.getState().setPlanQuestions(threadId, questions);
    }),
  );

  // plan.answered: server committed an answered marker for a plan-questions message
  unsubs.push(
    pushEmitter.on("plan.answered", (data) => {
      const { threadId, assistantMessageId } = data as {
        threadId: string;
        assistantMessageId: string;
      };
      if (!threadId || !assistantMessageId) return;
      useThreadStore.getState().markPlanAnswered(threadId, assistantMessageId);
    }),
  );

  // permission.request: tool permission awaiting user decision
  unsubs.push(
    pushEmitter.on("permission.request", (data) => {
      const request = data as PermissionRequest;
      if (!request.requestId || !request.threadId) return;
      useThreadStore.getState().addPermissionRequest(request);
    }),
  );

  // permission.resolved: a permission was settled (by user or session stop)
  unsubs.push(
    pushEmitter.on("permission.resolved", (data) => {
      const { requestId, decision } = data as {
        requestId: string;
        decision: PermissionDecision;
      };
      if (!requestId) return;
      useThreadStore.getState().resolvePermissionRequest(requestId, decision);
    }),
  );

  // providers.availability: server-pushed snapshot of all provider availability records
  unsubs.push(
    pushEmitter.on("providers.availability", (data) => {
      // Reject malformed payloads rather than overwriting the store with garbage.
      if (!Array.isArray(data)) return;
      useProviderAvailabilityStore.getState().replace(data as ProviderAvailability[]);
    }),
  );

}

/** Remove all push channel listeners. Safe to call multiple times. */
export function stopPushListeners(): void {
  for (const unsub of unsubs) {
    unsub();
  }
  unsubs = [];
}
