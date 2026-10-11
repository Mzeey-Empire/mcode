import type { ProviderId } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { useUiStore } from "@/stores/uiStore";
import { getTransport } from "@/transport";

/**
 * Starts a new thread on an announced model and acknowledges the provider's
 * announcements, so the bell row leaves once the server pushes the new status.
 */
export function tryNewModel(provider: ProviderId, modelId: string): void {
  getTransport()
    .acknowledgeProviderModels(provider)
    .catch((err: unknown) => console.error("[tryNewModel] Failed to acknowledge new models", err));
  useComposerDraftStore.getState().setPendingModel({ provider, modelId });
  useUiStore.getState().setPrimarySurface("chat");
  useWorkspaceStore.getState().beginNewThread();
}
