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

describe("PlanExecutionState", () => {
  it("treats streamed assistant block boundaries as new lines", () => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    state.feedText("I checked the files.");
    state.finishAssistantMessage();
    state.feedText("````mcode-plan\n# Plan\nBuild it.\n````");
    expect(state.consumeAssistantMessage("Summary.")).toEqual({
      title: "Plan", contentMd: "# Plan\nBuild it.", sectionsJson: "[]", changeSummary: null,
    });
  });

  it.each(["", "\n"])("retains message-only captures across all assistant messages with trailing %j", (newline) => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    state.observeAssistantMessage("I checked the files.");
    state.observeAssistantMessage("````mcode-plan\n# Plan\nBuild it." + newline);
    state.observeAssistantMessage("Then test it.\n````");
    expect(state.consumeAssistantMessage("Summary.")).toEqual({
      title: "Plan", contentMd: "# Plan\nBuild it.\nThen test it.", sectionsJson: "[]", changeSummary: null,
    });
  });
  it("publishes a question batch once", () => {
    const state = new PlanExecutionState();
    state.beginQuestionGeneration();
    const block = "```plan-questions\n" + JSON.stringify([question]) + "\n```";
    expect(state.feedText(block.slice(0, 23))).toBeNull();
    expect(state.feedText(block.slice(23))).toEqual({ questions: [question] });
    expect(state.feedText(block)).toBeNull();
  });

  it("captures literal markdown and derives navigation from headings outside code", () => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    const content = "## Context\n# Login plan\n\n## Implement\n```md\n# Example\n```\nAdd passkeys.";
    state.feedText("````mcode-plan\n" + content + "\n````");
    expect(state.consumeAssistantMessage("Summary.")).toEqual({
      title: "Login plan", contentMd: content,
      sectionsJson: '[{"id":"s1","title":"Context","level":2},{"id":"s2","title":"Implement","level":2}]',
      changeSummary: null,
    });
    state.markPlanPersisted();
    expect(state.consumeAssistantMessage("ignored")).toBeNull();
    expect(state.outcome()).toEqual({ outcome: "captured", source: "fence" });
  });

  it("returns an explicit missing outcome for prose with headings and no version", () => {
    const state = new PlanExecutionState();
    expect(state.outcome()).toEqual({ outcome: "inactive" });
    state.beginOutputGeneration();
    expect(state.consumeAssistantMessage("# Status\n## Next\nI need more information.")).toBeNull();
    expect(state.outcome()).toEqual({ outcome: "missing" });
  });

  it.each([true, false])("native capture wins regardless of arrival order (%s)", (nativeFirst) => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    const native = { markdown: "# Native plan\n## Deploy\nShip it.", source: "native" as const };
    if (nativeFirst) state.handleCapture(native);
    state.feedText("````mcode-plan\n# Fallback\n````\n");
    state.observeAssistantMessage("Summary.");
    if (!nativeFirst) state.handleCapture(native);
    expect(state.consumeAssistantMessage("Summary.")).toEqual({
      title: "Native plan", contentMd: "# Native plan\n## Deploy\nShip it.",
      sectionsJson: '[{"id":"s1","title":"Deploy","level":2}]', changeSummary: null,
    });
    state.markPlanPersisted();
    state.handleCapture({ markdown: "# Duplicate", source: "native" });
    expect(state.consumeAssistantMessage("ignored")).toBeNull();
  });

  it("accepts message-only capture with no headings without scraping its summary", () => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    expect(state.consumeAssistantMessage("# Summary\n````mcode-plan\nBuild and test.\n````")).toEqual({
      title: "Untitled plan", contentMd: "Build and test.", sectionsJson: "[]", changeSummary: null,
    });
  });
});
