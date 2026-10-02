import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { TaskRepo } from "../orchestration/persistence/task-repo.js";
import { taskToolWriteIntents, type TaskToolWriteIntent } from "./task-tool-intent-reducer.js";

/** Persists provider task-tool state for reconnect hydration. */
@injectable()
export class TaskPersistenceService {
  constructor(
    @inject(TaskRepo) private readonly tasks: TaskRepo,
    @inject(NarrativeStore) private readonly narrative: NarrativeStore,
  ) {}

  /** Persist task state from one tool-use event after narrative attribution. */
  async onToolUse(
    threadId: string,
    event: { toolName: string; toolInput: Record<string, unknown>; parentToolCallId?: string },
  ): Promise<void> {
    const intents = taskToolWriteIntents({
      kind: "tool-use",
      ...event,
      bufferedCalls: this.narrative.getBufferedToolCalls(threadId),
    });
    const label = event.toolName === "TodoWrite" ? "TodoWrite tasks"
      : event.toolName === "update_plan" ? "update_plan tasks" : "TaskUpdate";
    await this.applyIntents(threadId, intents, label);
  }

  /** Persist one TaskCreate after its result supplies the stable harness identity. */
  async onToolResult(threadId: string, toolCallId: string, output: string, isError: boolean): Promise<void> {
    if (isError) return;
    const intents = taskToolWriteIntents({
      kind: "tool-result",
      toolCallId,
      output,
      isError,
      bufferedCalls: this.narrative.getBufferedToolCalls(threadId),
    });
    await this.applyIntents(threadId, intents, "TaskCreate task");
  }

  private async applyIntents(threadId: string, intents: readonly TaskToolWriteIntent[], label: string): Promise<void> {
    for (const intent of intents) {
      await this.tryPersist(label, threadId, () => this.applyIntent(threadId, intent));
    }
  }

  private async applyIntent(threadId: string, intent: TaskToolWriteIntent): Promise<void> {
    switch (intent.kind) {
      case "upsert-group":
        await this.tasks.upsertGroup(threadId, intent.group, intent.tasks);
        return;
      case "append-task":
        await this.tasks.appendTask(threadId, intent.task);
        return;
      case "update-task":
        await this.tasks.updateTask(threadId, intent.id, intent.patch, intent.group);
        return;
      case "remove-task":
        await this.tasks.removeTask(threadId, intent.id, intent.group);
        return;
    }
  }

  private async tryPersist(label: string, threadId: string, persist: () => Promise<void>): Promise<void> {
    try {
      await persist();
    } catch (error) {
      logger.warn(`${label} not persisted`, {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
