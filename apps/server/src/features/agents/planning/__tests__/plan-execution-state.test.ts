import { describe, expect, it } from "vitest";

import { PlanExecutionState } from "../plan-execution-state.js";

const question = {
  id: "q1",
  category: "AUTH",
  question: "Which login?",
  options: [
    { id: "o1", title: "Passkey", description: "Use passkeys.", recommended: true },
    { id: "o2", title: "Password", description: "Use passwords." },
  ],
};

const structuredPlan = {
  title: "Login plan",
  changeSummary: "Use passkeys",
  sections: [{ id: "s1", title: "Implementation", level: 1, content: "Add passkey login." }],
};

describe("PlanExecutionState", () => {
  it("publishes one plain question outcome from chunked text", () => {
    const state = new PlanExecutionState();
    state.beginQuestionGeneration();
    const block = `\`\`\`plan-questions\n${JSON.stringify([question])}\n\`\`\``;

    expect(state.feedText(block.slice(0, 23))).toBeNull();
    const ready = state.feedText(block.slice(23));
    expect(ready).toEqual({ questions: [question] });
    expect(structuredClone(ready)).toEqual(ready);
    expect(state.feedText(block)).toBeNull();
  });

  it("uses the parsed plan at the assistant message boundary", () => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    const block = `\`\`\`plan-output\n${JSON.stringify(structuredPlan)}\n\`\`\``;

    expect(state.needsAssistantMaterialization()).toBe(true);
    expect(state.feedText(block.slice(0, 19))).toBeNull();
    expect(state.feedText(block.slice(19))).toBeNull();
    expect(state.consumeAssistantMessage("provider prose")).toEqual({
      title: "Login plan",
      contentMd: "## Implementation\n\nAdd passkey login.",
      sectionsJson: '[{"id":"s1","title":"Implementation","level":1}]',
      changeSummary: "Use passkeys",
    });
    expect(state.needsAssistantMaterialization()).toBe(false);
    expect(state.consumeAssistantMessage("# Another\n## Section")).toBeNull();
  });

  it("uses assistant markdown when no structured block completes", () => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();

    expect(state.consumeAssistantMessage("# Fallback\n## Step\nDo it.")).toEqual({
      title: "Fallback",
      contentMd: "# Fallback\n## Step\nDo it.",
      sectionsJson: '[{"id":"s1","title":"Step","level":2}]',
      changeSummary: null,
    });
    expect(state.needsAssistantMaterialization()).toBe(false);
  });

  it("lets native exit markdown replace a pending streamed plan", () => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    state.feedText(`\`\`\`plan-output\n${JSON.stringify(structuredPlan)}\n\`\`\``);
    state.handleNativeExit("# Native plan\n## Deploy\nShip it.");

    expect(state.consumeAssistantMessage("ignored")).toEqual({
      title: "Native plan",
      contentMd: "# Native plan\n## Deploy\nShip it.",
      sectionsJson: '[{"id":"s1","title":"Deploy","level":2}]',
      changeSummary: null,
    });
    state.markPlanPersisted();
    state.handleNativeExit("# Later\n## Ignored");
    expect(state.consumeAssistantMessage("ignored")).toBeNull();
  });
});
