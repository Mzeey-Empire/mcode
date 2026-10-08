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


const markdown = "# Login plan\n\n## Implementation\n\nAdd passkey login.";
const fenced = "````mcode-plan\n" + markdown + "\n````";

describe("PlanExecutionState", () => {
  it("publishes one question outcome from chunked text", () => {
    const state = new PlanExecutionState();
    state.beginQuestionGeneration();
    const block = "```plan-questions\n" + JSON.stringify([question]) + "\n```";
    expect(state.feedText(block.slice(0, 23))).toBeNull();
    expect(state.feedText(block.slice(23))).toEqual({ questions: [question] });
    expect(state.feedText(block)).toBeNull();
    expect(state.finishTurn()).toBeNull();
  });

  it("captures a streamed fence at the assistant boundary, once persisted", () => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    state.feedText(fenced.slice(0, 19));
    state.feedText(fenced.slice(19));
    expect(state.consumeAssistantMessage("Summary")).toEqual({
      title: "Login plan", contentMd: markdown,
      sectionsJson: '[{"id":"s1","title":"Implementation","level":2}]', changeSummary: null,
    });
    state.markPlanPersisted();
    expect(state.needsAssistantMaterialization()).toBe(false);
    expect(state.consumeAssistantMessage(fenced)).toBeNull();
    expect(state.finishTurn()).toEqual({ outcome: "captured" });
  });

  it("reports missing for a prose-only reply with headings and creates no version", () => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    state.feedText("# Findings\n## Status\nStill investigating.");
    expect(state.consumeAssistantMessage("# Findings\n## Status\nStill investigating.")).toBeNull();
    expect(state.hasPersistedPlan()).toBe(false);
    expect(state.finishTurn()).toEqual({ outcome: "missing" });
  });

  it.each(["native-first", "fence-first"])("prefers native capture regardless of arrival order: %s", (order) => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    const capture = { markdown: "# Native plan\n## Deploy\nShip it.", source: "native" as const };
    if (order === "native-first") state.handlePlanCapture(capture);
    state.feedText(fenced);
    if (order === "fence-first") state.handlePlanCapture(capture);
    expect(state.consumeAssistantMessage(fenced)).toEqual({
      title: "Native plan", contentMd: capture.markdown,
      sectionsJson: '[{"id":"s1","title":"Deploy","level":2}]', changeSummary: null,
    });
    state.markPlanPersisted();
    state.handlePlanCapture(capture);
    expect(state.consumeAssistantMessage(fenced)).toBeNull();
  });

  it("captures a complete message without deltas after an earlier prose message", () => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    expect(state.consumeAssistantMessage("# Findings\n## Status")).toBeNull();
    expect(state.consumeAssistantMessage(fenced)?.contentMd).toBe(markdown);
  });

  it("takes the first H1 and skips headings inside code blocks", () => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    const body = "## Context\n# Actual title\n```sh\n# Not a heading\n```\n## Steps\nDo it.";
    state.handlePlanCapture({ markdown: body, source: "native" });
    expect(state.consumeAssistantMessage("Summary")).toEqual({
      title: "Actual title", contentMd: body,
      sectionsJson: '[{"id":"s1","title":"Context","level":2},{"id":"s2","title":"Steps","level":2}]', changeSummary: null,
    });
  });

  it("allows a titled plan without subheadings and rejects unclosed captures", () => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    expect(state.consumeAssistantMessage("````mcode-plan\n# Unclosed")).toBeNull();
    state.handlePlanCapture({ markdown: "# Small plan\nDo it.", source: "native" });
    expect(state.consumeAssistantMessage("Summary")).toEqual({
      title: "Small plan", contentMd: "# Small plan\nDo it.", sectionsJson: "[]", changeSummary: null,
    });
  });

  it.each([
    ["## First heading\n### Next\nSteps", "First heading"],
    ["\n  Implement the login screen.\nThen test it.", "Implement the login screen."],
    ["# " + "x".repeat(250), "x".repeat(200)],
  ])("captures native markdown with a bounded fallback title: %s", (body, title) => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    state.handlePlanCapture({ markdown: body, source: "native" });
    expect(state.consumeAssistantMessage(fenced)).toMatchObject({ title, contentMd: body });
  });

  it.each(["   ", "x".repeat(256 * 1024 + 1)])("retains the fence when native capture is unusable", (body) => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    state.handlePlanCapture({ markdown: body, source: "native" });
    expect(state.consumeAssistantMessage(fenced)?.contentMd).toBe(markdown);
  });

  it("does not arm planning from a native capture during questions", () => {
    const state = new PlanExecutionState();
    state.beginQuestionGeneration();
    state.handlePlanCapture({ markdown, source: "native" });
    expect(state.consumeAssistantMessage("Summary")).toBeNull();
    expect(state.finishTurn()).toBeNull();
  });

  it("bounds navigation sections while retaining the complete markdown", () => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    const body = "# Plan\n" + Array.from({ length: 150 }, (_, index) => `## Step ${index}\n`).join("");
    state.handlePlanCapture({ markdown: body, source: "native" });
    const output = state.consumeAssistantMessage("Summary");
    expect(output?.contentMd).toBe(body);
    expect(JSON.parse(output?.sectionsJson ?? "null")).toEqual(Array.from({ length: 128 }, (_, index) => ({
      id: `s${index + 1}`, title: `Step ${index}`, level: 2,
    })));
  });

  it("forks partial fences without consuming accepted state", () => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    state.feedText(fenced.slice(0, 12));
    const copy = state.fork();
    copy.feedText(fenced.slice(12));
    expect(copy.consumeAssistantMessage("Summary")?.title).toBe("Login plan");
    expect(state.consumeAssistantMessage("Summary")).toBeNull();
  });

  it("never takes a code fence line as the title of a heading-less plan", () => {
    const state = new PlanExecutionState();
    state.beginOutputGeneration();
    state.handlePlanCapture({ markdown: "```mermaid\ngraph TD\n```\nShip the change.", source: "native" });
    expect(state.consumeAssistantMessage("Summary")?.title).toBe("Ship the change.");
  });
});
