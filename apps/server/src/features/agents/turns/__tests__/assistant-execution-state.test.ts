import { describe, expect, it } from "vitest";

import { AssistantExecutionState } from "../assistant-execution-state.js";

describe("AssistantExecutionState", () => {
  it("accumulates final text and clears it at a message boundary", () => {
    const state = new AssistantExecutionState();
    state.appendStreamingText("  partial");
    state.appendStreamingText(" answer  ");

    expect(state.getStreamingText()).toBe("  partial answer  ");
    expect(state.materializationInput("fallback-model")).toEqual({
      content: "partial answer",
      model: "fallback-model",
      attachments: [],
      fromProvider: false,
    });

    state.resetStreamingText();
    expect(state.getStreamingText()).toBe("");
    expect(state.hasBufferedBody()).toBe(false);
  });

  it("uses the provider message body and merges generated attachments by id", () => {
    const state = new AssistantExecutionState();
    const image = { id: "image", name: "image.png", mimeType: "image/png", sizeBytes: 12 };
    const updatedImage = { ...image, sizeBytes: 20 };
    const file = { id: "file", name: "notes.txt", mimeType: "text/plain", sizeBytes: 8 };
    state.appendStreamingText("draft text");
    state.bufferAttachments([image]);
    state.bufferBody("final answer", "provider-model");
    state.bufferAttachments([updatedImage, file]);

    const input = state.materializationInput("fallback-model");
    expect(input).toEqual({
      content: "final answer",
      model: "provider-model",
      attachments: [updatedImage, file],
      fromProvider: true,
    });
    expect(structuredClone(input)).toEqual(input);

    state.commitMaterialization();
    expect(state.hasMaterialized()).toBe(true);
    expect(state.getStreamingText()).toBe("");
    expect(state.getBufferedAttachments()).toEqual([]);
    expect(state.hasBufferedBody()).toBe(false);
  });

  it("keeps a text-only empty turn empty after an undecided message boundary", () => {
    const state = new AssistantExecutionState();
    state.appendStreamingText("   \n");
    expect(state.hasBufferedBody()).toBe(false);

    state.resetStreamingText();
    expect(state.materializationInput(null)).toEqual({
      content: "",
      model: null,
      attachments: [],
      fromProvider: false,
    });
    expect(state.hasMaterialized()).toBe(false);
  });
});
