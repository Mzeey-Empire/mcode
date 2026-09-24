import "reflect-metadata";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import { describe, expect, it, vi } from "vitest";

import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
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

describe("PlanTurnService output", () => {
  it("publishes parsed questions and persists the plan at its assistant message", () => {
    const db = openMemoryDatabase();
    const workspace = new WorkspaceRepo(db).create("plans", process.cwd(), false);
    const threads = new ThreadRepo(db);
    const thread = threads.create(workspace.id, "plan", "direct", "main", false, "codex");
    const messages = new MessageRepo(db);
    const plans = new PlanRepo(db);
    const questions = new PlanQuestionService(messages, new PlanQuestionAnswersRepo(db));
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
    const output = { title: "Login plan", sections: [{ id: "s1", title: "Implement", level: 1, content: "Add passkeys." }] };
    const block = `\`\`\`plan-output\n${JSON.stringify(output)}\n\`\`\``;
    service.onTextDelta(thread.id, block.slice(0, 24));
    service.onTextDelta(thread.id, block.slice(24));
    const assistant = messages.create(thread.id, "assistant", "Plan response", 1);
    const event: Extract<AgentEvent, { type: "message" }> = {
      type: AgentEventType.Message, threadId: thread.id, messageId: assistant.id, content: assistant.content, tokens: null,
    };

    expect(service.needsAssistantMaterialization(event)).toBe(true);
    service.persistAssistantMessage(event);
    expect(plans.getLatestForThread(thread.id)).toMatchObject({
      messageId: assistant.id,
      title: "Login plan",
      contentMd: "## Implement\n\nAdd passkeys.",
      sectionsJson: [{ id: "s1", title: "Implement", level: 1 }],
    });
    expect(service.needsAssistantMaterialization(event)).toBe(false);
    db.close(true);
  });
});
