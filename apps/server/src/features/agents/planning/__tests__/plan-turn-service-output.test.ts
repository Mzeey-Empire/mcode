import "reflect-metadata";
import * as NodeFS from "node:fs";
import { container } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkerTurnFixture } from "../../orchestration/__tests__/worker-turn-fixture.js";
import { PlanRepo } from "../persistence/plan-repo.js";
import { PlanService } from "../plan-service.js";

describe("worker-owned plan output", () => {
  let fixture: Awaited<ReturnType<typeof openWorkerTurnFixture>> | undefined;
  afterEach(async () => { await fixture?.close(); });

  it("keeps a durable native capture when the plan file projection fails", async () => {
    fixture = await openWorkerTurnFixture({ planning: true });
    const path = fixture.workers.planFiles!.path(fixture.thread.id);
    NodeFS.mkdirSync(path, { recursive: true });
    await fixture.emit({ type: "message", threadId: fixture.thread.id, content: "Plan summary", tokens: null },
      undefined, { markdown: "# Kept plan", source: "native" });
    await fixture.finish();
    expect(container.resolve(PlanRepo).getLatestForThread(fixture.thread.id)).toMatchObject({
      contentMd: "# Kept plan", providerId: "codex", status: "ready", revision: 0,
    });
    expect(NodeFS.statSync(path).isDirectory()).toBe(true);
  });

  it("persists the plan at its worker-owned assistant message", async () => {
    fixture = await openWorkerTurnFixture({ planning: true });
    const output = "# Login plan\n\n## Implement\n\nAdd passkeys.";
    await fixture.emit({ type: "textDelta", threadId: fixture.thread.id, delta: "````mcode-plan\n" + output + "\n````", isFinalResponse: true });
    await fixture.emit({ type: "message", threadId: fixture.thread.id, content: "Plan response", tokens: null });
    await fixture.finish();
    expect(container.resolve(PlanRepo).getLatestForThread(fixture.thread.id)).toMatchObject({
      messageId: fixture.assistant()!.id, title: "Login plan", contentMd: output,
      status: "ready", author: "agent", providerId: "codex", captureSource: "fence", revision: 0,
    });
  });

  it("publishes parsed questions through the worker-owned turn", async () => {
    fixture = await openWorkerTurnFixture({ questions: true });
    const question = {
      id: "q1", category: "AUTH", question: "Which login?",
      options: [{ id: "o1", title: "Passkey", description: "Use passkeys." },
        { id: "o2", title: "Password", description: "Use passwords." }],
    };
    const text = "```plan-questions\n" + JSON.stringify([question]) + "\n```";
    await fixture.emit({ type: "textDelta", threadId: fixture.thread.id, delta: text, isFinalResponse: true });
    await fixture.emit({ type: "message", threadId: fixture.thread.id, content: text, tokens: null });
    await fixture.finish();
    expect((await new PlanService(fixture.writer, fixture.workers.progress, fixture.workers.planFiles!).snapshot({ threadId: fixture.thread.id })).pendingQuestions).toEqual({
      assistantMessageId: fixture.assistant()!.id, questions: [question],
    });
  });

  it("does not capture ordinary prose as a plan", async () => {
    fixture = await openWorkerTurnFixture({ planning: true });
    await fixture.emit({ type: "message", threadId: fixture.thread.id, content: "# Findings\nStill investigating.", tokens: null });
    await fixture.finish();
    expect(container.resolve(PlanRepo).getLatestForThread(fixture.thread.id)).toBeNull();
  });
});
