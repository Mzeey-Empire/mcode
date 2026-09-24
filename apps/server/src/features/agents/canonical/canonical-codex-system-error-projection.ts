import type { Database } from "bun:sqlite";
import type { AgentEvent } from "@mcode/contracts";

import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import type { CodexLiveReduction, CodexLiveWriterIntent } from "../execution/codex-live-event-reducer.js";
import type { DataOnlyParentTerminalProjectionInput } from "./canonical-parent-turn-write.js";
import { CanonicalAgentBoundary } from "./canonical-agent-boundary.js";

type Reduced = Extract<CodexLiveReduction, { kind: "reduced" }>;
type SystemEvent = Extract<AgentEvent, { type: "system" }>;
type SystemIntent = Extract<CodexLiveWriterIntent, { kind: "notice-session" | "system-notice" | "session-cursor" }>;
type ErrorTerminalIntent = Extract<CodexLiveWriterIntent, { kind: "terminal-projection" }>;

function errorTerminalIntent(reduction: Reduced, event: Extract<AgentEvent, { type: "error" }>): ErrorTerminalIntent {
  const error = reduction.writer.find((intent) => intent.kind === "turn-error");
  const terminal = reduction.writer.find((intent) => intent.kind === "terminal-projection");
  if (error?.kind !== "turn-error" || error.error !== event.error
    || terminal?.kind !== "terminal-projection" || terminal.source !== "error" || terminal.outcome !== "errored") {
    throw new Error("Codex error needs an errored terminal projection and end time");
  }
  return terminal;
}

/** Cloneable result of writer-local system projection or error terminal preparation. */
export type CanonicalCodexSystemErrorResult =
  | { readonly kind: "system"; readonly event: SystemEvent; readonly after: "writer" | "terminal" }
  | { readonly kind: "error-terminal"; readonly event: Extract<AgentEvent, { type: "error" }>; readonly after: "terminal"; readonly input: DataOnlyParentTerminalProjectionInput };

/** Projects only execution-bound Codex system events and prepares errors for the terminal owner. */
export class CanonicalCodexSystemErrorProjection {
  private readonly threads: ThreadRepo;
  private readonly messages: MessageRepo;
  private readonly canonical: CanonicalAgentBoundary;

  constructor(private readonly db: Database) {
    this.threads = new ThreadRepo(db);
    this.messages = new MessageRepo(db);
    this.canonical = new CanonicalAgentBoundary(db, () => {});
  }

  /** Call inside the canonical append transaction, before its receipt and publication. Errors still require terminal staging and finish. */
  project(reduction: CodexLiveReduction, endedAt?: string): CanonicalCodexSystemErrorResult {
    if (reduction.kind !== "reduced") throw new Error("Unsupported Codex event cannot be projected");
    const event = reduction.publication.event;
    if (event.threadId !== reduction.execution.threadId || event.turnExecutionId !== reduction.execution.executionId) {
      throw new Error("Codex event lacks exact execution ownership");
    }
    if (event.type === "system") return this.projectSystem(reduction, event);
    if (event.type === "error") return this.prepareError(reduction, event, endedAt);
    throw new Error(`Codex ${event.type} needs another feature owner`);
  }

  private projectSystem(reduction: Reduced, event: SystemEvent): CanonicalCodexSystemErrorResult {
    return this.db.transaction(() => {
      let published: SystemEvent = { ...event };
      for (const intent of reduction.writer) {
        if (!this.isSystemIntent(intent) || JSON.stringify(intent.event) !== JSON.stringify(event)) {
          throw new Error("Codex system intent does not match its publication");
        }
        published = this.applySystemIntent(reduction, intent, published);
      }
      return structuredClone({ kind: "system", event: published, after: reduction.publication.after } satisfies CanonicalCodexSystemErrorResult);
    })();
  }

  private isSystemIntent(intent: CodexLiveWriterIntent): intent is SystemIntent {
    return intent.kind === "notice-session" || intent.kind === "system-notice" || intent.kind === "session-cursor";
  }

  private applySystemIntent(reduction: Reduced, intent: SystemIntent, event: SystemEvent): SystemEvent {
    switch (intent.kind) {
      case "notice-session":
        if (event.subtype !== "provider.session.started") throw new Error("Codex notice session subtype is invalid");
        this.messages.beginNoticeSession(event.threadId, event.systemNotice?.sessionId);
        return event;
      case "system-notice": {
        if (!event.subtype.startsWith("provider.notice.") || !event.message) throw new Error("Codex notice is invalid");
        const sequence = this.messages.getLatestSequenceIncludingInternal(event.threadId) + 1;
        const message = this.messages.createSystemNotice(event.threadId, event.message ?? "", sequence, event.systemNotice);
        return { ...event, messageId: message.id };
      }
      case "session-cursor":
        this.applyCursor(reduction.execution.executionId, event);
        return event;
    }
  }

  private applyCursor(executionId: string, event: SystemEvent): void {
    if (event.subtype === "sdk_session_invalidated") {
      if (!this.threads.clearSdkSessionId(event.threadId)) throw new Error("Codex cursor thread is missing");
      return;
    }
    if (!event.subtype.startsWith("sdk_session_id:")) throw new Error("Codex cursor subtype is invalid");
    const cursor = event.subtype.slice("sdk_session_id:".length);
    if (!cursor) return;
    if (!this.threads.updateSdkSessionId(event.threadId, cursor)
      || !this.canonical.recordNativeCursor(executionId, {
        providerId: "codex", scope: "thread", value: cursor, provenance: "native",
      })) throw new Error("Codex cursor could not be persisted for this execution");
  }

  private prepareError(reduction: Reduced, event: Extract<AgentEvent, { type: "error" }>, endedAt?: string): CanonicalCodexSystemErrorResult {
    if (reduction.publication.after !== "terminal" || !endedAt || !Number.isFinite(Date.parse(endedAt))) {
      throw new Error("Codex error needs an errored terminal projection and end time");
    }
    const terminal = errorTerminalIntent(reduction, event);
    return structuredClone({
      kind: "error-terminal",
      event,
      after: "terminal",
      input: {
        threadId: reduction.execution.threadId,
        executionId: reduction.execution.executionId,
        outcome: "errored",
        endedAt,
        assistant: terminal.assistant,
        narrative: terminal.narrative,
      },
    } satisfies CanonicalCodexSystemErrorResult);
  }
}
