import { describe, expect, it } from "vitest";
import {
  reconcileComposerThreadModel,
  type ComposerThreadModelReconciliationInput,
} from "../composer-thread-model-reconciliation";

const serverKeyA = "model-a\0codex";

function reconcile(overrides: Partial<ComposerThreadModelReconciliationInput>) {
  return reconcileComposerThreadModel({
    activeThreadModel: "model-a",
    activeThreadProvider: "codex",
    threadSwitchPending: false,
    hasDraft: false,
    lastServerThreadModelKey: serverKeyA,
    selection: { modelId: "model-b", provider: "codex" },
    ...overrides,
  });
}

describe("reconcileComposerThreadModel", () => {
  it("keeps a model picked while the thread runs", () => {
    expect(reconcile({}).selectionPatch).toBeNull();
  });

  it("applies a changed server model when there is no draft", () => {
    expect(reconcile({ lastServerThreadModelKey: "model-old\0codex" }).selectionPatch).toEqual({
      modelId: "model-a",
      provider: "codex",
    });
  });

  it("consumes a pending thread switch without patching the selection", () => {
    const result = reconcile({ threadSwitchPending: true, lastServerThreadModelKey: "" });
    expect(result.consumeThreadSwitch).toBe(true);
    expect(result.selectionPatch).toBeNull();
  });
});
