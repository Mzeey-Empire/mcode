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
  onToolUse(
    threadId: string,
    event: { toolName: string; toolInput: Record<string, unknown>; parentToolCallId?: string },
  ): void {
    const intents = taskToolWriteIntents({
      kind: "tool-use",
      ...event,
      bufferedCalls: this.narrative.getBufferedToolCalls(threadId),
    });
    const label = event.toolName === "TodoWrite" ? "TodoWrite tasks"
      : event.toolName === "update_plan" ? "update_plan tasks" : "TaskUpdate";
    this.applyIntents(threadId, intents, label);
  }

  /** Persist one TaskCreate after its result supplies the stable harness identity. */
  onToolResult(threadId: string, toolCallId: string, output: string, isError: boolean): void {
    if (isError) return;
    const intents = taskToolWriteIntents({
      kind: "tool-result",
      toolCallId,
      output,
      isError,
      bufferedCalls: this.narrative.getBufferedToolCalls(threadId),
    });
    this.applyIntents(threadId, intents, "TaskCreate task");
  }

  private applyIntents(threadId: string, intents: readonly TaskToolWriteIntent[], label: string): void {
    for (const intent of intents) {
      this.tryPersist(label, threadId, () => this.applyIntent(threadId, intent));
    }
  }

  private applyIntent(threadId: string, intent: TaskToolWriteIntent): void {
    switch (intent.kind) {
      case "upsert-group":
        this.tasks.upsertGroup(threadId, intent.group, intent.tasks);
        return;
      case "append-task":
        this.tasks.appendTask(threadId, intent.task);
        return;
      case "update-task":
        this.tasks.updateTask(threadId, intent.id, intent.patch, intent.group);
        return;
      case "remove-task":
        this.tasks.removeTask(threadId, intent.id, intent.group);
        return;
    }
  }

  private tryPersist(label: string, threadId: string, persist: () => void): void {
    try {
      persist();
    } catch (error) {
      logger.warn(`${label} not persisted`, {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
