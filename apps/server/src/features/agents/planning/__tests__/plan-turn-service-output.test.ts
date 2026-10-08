import "reflect-metadata";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openAgentStorageTestDatabase as openMemoryDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../__tests__/agent-storage-fixture.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ProviderRegistry } from "../../../providers/composition/provider-registry.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { AgentRuntimeCommandPort, AgentTurnCommandPort } from "../../orchestration/agent-turn-command-port.js";
import { PlanQuestionAnswersRepo } from "../persistence/plan-question-answers-repo.js";
import { PlanRepo } from "../persistence/plan-repo.js";
import { PlanQuestionService } from "../plan-question-service.js";
import { PlanTurnService } from "../plan-turn-service.js";

vi.mock("../../../../application/transport/push.js", () => ({ broadcast: vi.fn() }));
import { broadcast } from "../../../../application/transport/push.js";

afterEach(closeAgentStorageTestDatabases);


async function fixture() {
  const db = openMemoryDatabase();
  const writer = agentStorageTestWriter(db);
  const workspace = await new WorkspaceRepo(db, writer).create("plans", process.cwd(), false);
  const threads = new ThreadRepo(db, writer);
  const thread = await threads.create(workspace.id, "plan", "direct", "main", false, "codex");
  const messages = new MessageRepo(db, writer);
  const plans = new PlanRepo(db, writer);
  const service = new PlanTurnService(threads, new ProviderRegistry([]),
    new PlanQuestionService(messages, new PlanQuestionAnswersRepo(db, writer)),
    plans, new AgentTurnCommandPort(new AgentRuntimeCommandPort()));
  return { thread, messages, plans, service };
}

describe("PlanTurnService output", () => {
  it.each(["fence", "native"] as const)("persists one %s plan after all captures settle", async (source) => {
    const { thread, messages, plans, service } = await fixture();
    service.beginOutputGeneration(thread.id);
    const block = "````mcode-plan\n# Login plan\n\n## Implement\nAdd passkeys.\n````";
    service.observeAcceptedText(thread.id, block.slice(0, 24));
    service.observeAcceptedText(thread.id, block.slice(24));
    const assistant = await messages.create(thread.id, "assistant", "Plan response", 1);
    const event: Extract<AgentEvent, { type: "message" }> = {
      type: AgentEventType.Message, threadId: thread.id, messageId: assistant.id, content: assistant.content, tokens: null,
    };
    await service.persistAssistantMessage(event);
    expect(plans.getLatestForThread(thread.id)).toBeNull();
    if (source === "native") service.handlePlanCaptured({ threadId: thread.id, markdown: "# Native plan\nShip it.", source });
    await service.finishTurn(thread.id);
    await service.finishTurn(thread.id);
    expect(plans.listByThread(thread.id)).toHaveLength(1);
    expect(plans.getLatestForThread(thread.id)).toMatchObject(source === "native" ? {
      version: 1, messageId: assistant.id, title: "Native plan", contentMd: "# Native plan\nShip it.", sectionsJson: [],
    } : {
      version: 1, messageId: assistant.id, title: "Login plan", contentMd: "# Login plan\n\n## Implement\nAdd passkeys.",
      sectionsJson: [{ id: "s1", title: "Implement", level: 2 }],
    });
    expect(service.needsAssistantMaterialization(event)).toBe(false);
    service.clearTurn(thread.id);
  });

  it("creates no version for prose with headings and logs the missing outcome", async () => {
    const { thread, messages, plans, service } = await fixture();
    const { logger } = await import("@mcode/shared");
    const warning = vi.spyOn(logger, "warn");
    service.beginOutputGeneration(thread.id);
    const assistant = await messages.create(thread.id, "assistant", "# Status\n## Next\nNeed input.", 1);
    await service.persistAssistantMessage({
      type: AgentEventType.Message, threadId: thread.id, messageId: assistant.id, content: assistant.content, tokens: null,
    });
    await service.finishTurn(thread.id);
    service.clearTurn(thread.id);
    expect(plans.listByThread(thread.id)).toEqual([]);
    expect(warning).toHaveBeenCalledWith("Plan capture missing", { threadId: thread.id, outcome: "missing" });
    warning.mockRestore();
  });

  it("still publishes parsed questions without creating a plan", async () => {
    const { thread, plans, service } = await fixture();
    const question = { id: "q1", category: "AUTH", question: "Which login?",
      options: [{ id: "o1", title: "Passkey", description: "Use passkeys." }, { id: "o2", title: "Password", description: "Use passwords." }] };
    service.beginQuestionGeneration(thread.id);
    service.onTextDelta(thread.id, "```plan-questions\n" + JSON.stringify([question]) + "\n```");
    expect(broadcast).toHaveBeenCalledWith("plan.questions", { threadId: thread.id, questions: [question] });
    expect(plans.listByThread(thread.id)).toEqual([]);
  });
});
