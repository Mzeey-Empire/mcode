import "reflect-metadata";
import { logger } from "@mcode/shared";
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

describe("PlanTurnService output", () => {
  it("publishes parsed questions and persists the plan at its assistant message", async () => {
    const db = openMemoryDatabase();
    const workspace = await new WorkspaceRepo(db, agentStorageTestWriter(db)).create("plans", process.cwd(), false);
    const threads = new ThreadRepo(db, agentStorageTestWriter(db));
    const thread = await threads.create(workspace.id, "plan", "direct", "main", false, "codex");
    const messages = new MessageRepo(db, agentStorageTestWriter(db));
    const plans = new PlanRepo(db, agentStorageTestWriter(db));
    const questions = new PlanQuestionService(messages, new PlanQuestionAnswersRepo(db, agentStorageTestWriter(db)));
    const service = new PlanTurnService(
      threads,
      new ProviderRegistry([]),
      questions,
      plans,
      new AgentTurnCommandPort(new AgentRuntimeCommandPort()),
    );
    const question = {
      id: "q1", category: "AUTH", question: "Which login?",
      options: [
        { id: "o1", title: "Passkey", description: "Use passkeys." },
        { id: "o2", title: "Password", description: "Use passwords." },
      ],
    };

    service.beginQuestionGeneration(thread.id);
    service.onTextDelta(thread.id, `\`\`\`plan-questions\n${JSON.stringify([question])}\n\`\`\``);
    expect(broadcast).toHaveBeenCalledWith("plan.questions", { threadId: thread.id, questions: [question] });

    service.beginOutputGeneration(thread.id);
    const output = "# Login plan\n\n## Implement\n\nAdd passkeys.";
    const block = `\`\`\`\`mcode-plan\n${output}\n\`\`\`\``;
    service.onTextDelta(thread.id, block.slice(0, 24));
    service.onTextDelta(thread.id, block.slice(24));
    const assistant = await messages.create(thread.id, "assistant", "Plan response", 1);
    const event: Extract<AgentEvent, { type: "message" }> = {
      type: AgentEventType.Message, threadId: thread.id, messageId: assistant.id, content: assistant.content, tokens: null,
    };

    expect(service.needsAssistantMaterialization(event)).toBe(true);
    await service.persistAssistantMessage(event);
    expect(plans.getLatestForThread(thread.id)).toMatchObject({
      messageId: assistant.id,
      title: "Login plan",
      contentMd: output,
      sectionsJson: [{ id: "s1", title: "Implement", level: 2 }],
    });
    expect(service.needsAssistantMaterialization(event)).toBe(false);
    service.clearTurn(thread.id);
    service.beginOutputGeneration(thread.id);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const prose = "# Findings\n## Status\nStill investigating.";
    const reply = await messages.create(thread.id, "assistant", prose, 2);
    service.onTextDelta(thread.id, prose);
    await service.persistAssistantMessage({ ...event, messageId: reply.id, content: prose });
    service.clearTurn(thread.id);
    expect(plans.getLatestForThread(thread.id)?.version).toBe(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith("Planning turn produced no plan", { threadId: thread.id, outcome: "missing" });
    warn.mockRestore();
    db.close(true);
  });
});
