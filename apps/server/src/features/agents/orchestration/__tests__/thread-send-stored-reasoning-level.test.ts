import "reflect-metadata";
import type { IAgentProvider } from "@mcode/contracts/providers/interfaces";
import { container } from "tsyringe";
import { expect, it, vi } from "vitest";
import { ThreadControlService } from "../../../thread-control/authority/thread-control-service.js";
import { openWorkerServiceFixture } from "./worker-turn-fixture.js";

it("runs a thread_send follow-up at the target thread's stored reasoning level", async () => {
  const fixture = await openWorkerServiceFixture();
  try {
    const coordinator = await fixture.threads.create(fixture.workspace.id, "Coordinator", "direct", "main", true, "codex");
    await fixture.threads.updateSettings(fixture.thread.id, { reasoning_level: "low", model: "gpt-5.5" });
    // thread_send requires the target model to appear in the provider's model list.
    const provider: Pick<IAgentProvider, "listModels"> = fixture.provider;
    vi.spyOn(provider, "listModels").mockResolvedValue([{ id: "gpt-5.5", name: "GPT-5.5", provider: "codex" }]);
    const control = container.resolve(ThreadControlService);
    const result = await control.threadSend(
      {
        type: "internal", userId: "local-user", sourceThreadId: coordinator.id, sourceTurnId: "turn-1",
        sourceToolCallId: "call-1", sourceProviderId: "codex", permissionMode: "full",
      },
      { threadId: fixture.thread.id, message: "Follow up" },
    );
    expect(result.status).toBe("accepted");
    await vi.waitFor(() => expect(fixture.sent).toHaveLength(1));
    expect(fixture.sent[0]?.reasoningLevel).toBe("low");
  } finally {
    await fixture.close();
  }
});

it("skips a stored reasoning level the thread_send target model does not support", async () => {
  const fixture = await openWorkerServiceFixture();
  try {
    const coordinator = await fixture.threads.create(fixture.workspace.id, "Coordinator", "direct", "main", true, "codex");
    await fixture.threads.updateSettings(fixture.thread.id, { reasoning_level: "max", model: "gpt-5.5" });
    const provider: Pick<IAgentProvider, "listModels"> = fixture.provider;
    vi.spyOn(provider, "listModels").mockResolvedValue([{
      id: "gpt-5.5", name: "GPT-5.5", provider: "codex", supportedReasoningEfforts: ["low", "medium", "high"],
    }]);
    const control = container.resolve(ThreadControlService);
    const result = await control.threadSend(
      {
        type: "internal", userId: "local-user", sourceThreadId: coordinator.id, sourceTurnId: "turn-1",
        sourceToolCallId: "call-1", sourceProviderId: "codex", permissionMode: "full",
      },
      { threadId: fixture.thread.id, message: "Follow up" },
    );
    expect(result.status).toBe("accepted");
    await vi.waitFor(() => expect(fixture.sent).toHaveLength(1));
    expect(fixture.sent[0]?.reasoningLevel).toBeUndefined();
  } finally {
    await fixture.close();
  }
});
