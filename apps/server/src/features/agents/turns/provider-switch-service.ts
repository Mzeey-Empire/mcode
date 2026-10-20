import { inject, injectable } from "tsyringe";
import {
  type CanonicalAgentEventEnvelope,
  type IAgentProvider,
  type IProviderRegistry,
  type ProviderId,
  type ProviderModelInfo,
  type Thread,
} from "@mcode/contracts";
import { ProviderTurnError, SESSION_RESUME_UNAVAILABLE_CODE } from "@mcode/providers";
import { logger } from "@mcode/shared";
import { broadcast } from "../../../application/transport/push.js";
import { HandoffStorage } from "../../handoff/persistence/handoff-storage.js";
import { HandoffBudgetExhaustedError, handoffInputCharacterCap, loadHandoffMessages, planSwitchHandoff } from "../../handoff/v2/index.js";
import type { SwitchHandoffPlan } from "../../handoff/v2/index.js";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { ThreadProviderSessionRepo } from "../../thread-control/persistence/thread-provider-session-repo.js";
import type { ResolvedProviderSession } from "../../thread-control/persistence/thread-provider-session-repo.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { subscribeCommittedCanonicalEvents } from "../canonical/committed-canonical-events.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import { TurnRecoveryService } from "../recovery/turn-recovery-service.js";
import { sendAdmittedTurn } from "../transport/turn-message-dispatch.js";
import { ToolCallRecordRepo } from "../tools/persistence/tool-call-record-repo.js";
import { reconcileSwitchOptions, type DroppedOption } from "./provider-switch-options.js";
import type { RuntimeReleaseCause, SendMessageCommand } from "./turn-admission-dispatch-coordinator.js";
import { turnConversationWriteOperations } from "./turn-conversation-write-operations.js";

/** Settings a switching send writes to the thread once the target accepts the turn. */
export type ProviderSwitchSettings = Parameters<ThreadRepo["updateSettings"]>[1] & { readonly model: string };

/** What a switch decided about its history and target session. */
export interface PlannedSwitch {
  readonly handoff: SwitchHandoffPlan;
  /** The target's native session to continue, or null when it starts a fresh one. */
  readonly resumeSessionId: string | null;
  /** A session recorded for the target before this switch that the switch will not continue. */
  readonly staleSessionId: string | null;
  readonly dropped: readonly DroppedOption[];
  /** Set when the history cannot fit the target; the turn is refused and the user's message stays whole. */
  readonly refusal: Error | null;
}

interface ArmedSwitch {
  readonly turnId: string;
  readonly settings: ProviderSwitchSettings;
  accepted: boolean;
  resumeUnavailable: boolean;
  committing: Promise<void> | null;
  /** Settles when the turn's terminal event commits, which can land after the runtime is released. */
  readonly terminal: Promise<void>;
  readonly settleTerminal: () => void;
  unsubscribe: () => void;
}

/**
 * One send that changes the thread's provider. The thread keeps its provider, model and session until the
 * target accepts the turn, so a target that fails first leaves the thread exactly as it was.
 */
export interface ProviderSwitchTicket {
  readonly fromProvider: ProviderId;
  readonly toProvider: ProviderId;
  /** The command to admit: the caller's, with options the target cannot honour removed once planned. */
  command: SendMessageCommand;
  plan: PlannedSwitch | null;
  armed: ArmedSwitch | null;
}

/** A write that fails once is usually a busy database; a second failure is not worth blocking the turn for. */
const COMMIT_ATTEMPTS = 2;

const FALLBACK_SELECTION_KEYS = [
  "model", "permissionMode", "reasoningLevel", "provider", "interactionMode", "orchestrationMode",
  "contextWindow", "thinking", "codexFastMode", "devinMode",
] as const satisfies readonly (keyof SendMessageCommand)[];

/** Runs the provider-neutral part of a cross-provider switch: handoff, target session, and commit on acceptance. */
@injectable()
export class ProviderSwitchService {
  private dispatch: ((command: SendMessageCommand) => Promise<void>) | undefined;
  /** The armed switch per thread; a thread runs one turn at a time, so an older arm is stale. */
  private readonly armedByThread = new Map<string, ProviderSwitchTicket>();

  constructor(
    @inject(ThreadRepo) private readonly threads: ThreadRepo,
    @inject(ThreadProviderSessionRepo) private readonly sessions: ThreadProviderSessionRepo,
    @inject(MessageRepo) private readonly messages: MessageRepo,
    @inject(ToolCallRecordRepo) private readonly toolCalls: ToolCallRecordRepo,
    @inject(HandoffStorage) private readonly storage: HandoffStorage,
    @inject("IProviderRegistry") private readonly providers: IProviderRegistry,
    @inject(TurnRecoveryService) private readonly recovery: Pick<TurnRecoveryService, "retryErroredTurn">,
    @inject(ApplicationDatabaseWriter) private readonly writer: Pick<ApplicationDatabaseWriter, "execute">,
  ) {}

  /** Bind the runtime's send, used to start the fresh attempt after a resume fails. */
  bindDispatch(dispatch: (command: SendMessageCommand) => Promise<void>): void {
    this.dispatch = dispatch;
  }

  /**
   * Return a ticket when the command asks for a provider other than the thread's, else null. The ticket's
   * command also reports runtime release back to the service.
   */
  open(command: SendMessageCommand, currentProvider: string | null): ProviderSwitchTicket | null {
    const target = command.provider;
    if (!target || command.providerOriginated || !currentProvider || target === currentProvider) return null;
    const ticket: ProviderSwitchTicket = {
      fromProvider: currentProvider as ProviderId,
      toProvider: target,
      command,
      plan: null,
      armed: null,
    };
    ticket.command = {
      ...command,
      onRuntimeReleased: (cause) => {
        command.onRuntimeReleased?.(cause);
        void this.release(ticket, cause);
      },
    };
    return ticket;
  }

  /**
   * Choose the target session and build the handoff. Runs once the thread is reserved so the history
   * read includes the previous turn's final rows.
   */
  async plan(ticket: ProviderSwitchTicket, input: { thread: Thread; throughSequence: number }): Promise<void> {
    const { thread, throughSequence } = input;
    const target = this.providers.resolve(ticket.toProvider);
    const row = this.sessions.find(thread.id, ticket.toProvider);
    const resume = this.resumeCandidate(ticket, thread.id, target);
    const reconciled = await reconcileCommand(ticket.command, ticket.toProvider, target);
    const rows = loadHandoffMessages({ messageRepo: this.messages, toolCallRecordRepo: this.toolCalls, threadId: thread.id });
    const outcome = this.tryPlan(ticket, thread, rows, throughSequence, resume?.lastSeenSequence ?? null);
    const plan = settledPlan({ ticket, outcome, resume, staleSessionId: row?.sessionId ?? null, dropped: reconciled.dropped, throughSequence });
    ticket.plan = plan;
    // A delta continues the target's session or fails; only a fresh session may start from nothing.
    ticket.command = { ...reconciled.command, ...(plan.resumeSessionId ? { resumeRequired: true } : { forceFreshSession: true }) };
  }

  private resumeCandidate(ticket: ProviderSwitchTicket, threadId: string, target: IAgentProvider): ResolvedProviderSession | null {
    if (ticket.command.forceFreshSession === true || !supportsSessionResume(target)) return null;
    return this.sessions.resolve(threadId, ticket.toProvider);
  }

  private tryPlan(
    ticket: ProviderSwitchTicket,
    thread: Thread,
    rows: ReturnType<typeof loadHandoffMessages>,
    throughSequence: number,
    resumeWatermark: number | null,
  ): SwitchHandoffPlan | Error {
    const command = ticket.command;
    try {
      return planSwitchHandoff({
        threadId: thread.id,
        fromProvider: ticket.fromProvider,
        toProvider: ticket.toProvider,
        rows,
        throughSequence,
        resumeWatermark,
        contextWindow: thread.context_window ?? null,
        inputCharacterCap: handoffInputCharacterCap(this.providers.resolve(ticket.toProvider)),
        userText: command.content,
        attachments: attachmentKinds(command),
      });
    } catch (error) {
      if (!(error instanceof HandoffBudgetExhaustedError)) throw error;
      return new ProviderTurnError(
        `Switching to ${ticket.toProvider} needs more context than its window allows. ${error.message}`,
        { kind: "fatal", code: error.code },
        { cause: error },
      );
    }
  }

  /**
   * Start watching the turn. The first provider frame commits the switch; a turn that ends without one
   * leaves the thread untouched.
   */
  arm(ticket: ProviderSwitchTicket, input: { threadId: string; turnId: string; settings: ProviderSwitchSettings }): void {
    this.armedByThread.get(input.threadId)?.armed?.unsubscribe();
    let settleTerminal: () => void = () => undefined;
    const terminal = new Promise<void>((resolve) => { settleTerminal = resolve; });
    const armed: ArmedSwitch = {
      turnId: input.turnId,
      settings: input.settings,
      accepted: false,
      resumeUnavailable: false,
      committing: null,
      terminal,
      settleTerminal,
      unsubscribe: () => undefined,
    };
    armed.unsubscribe = subscribeCommittedCanonicalEvents((events) => this.observe(ticket, input.threadId, armed, events));
    ticket.armed = armed;
    this.armedByThread.set(input.threadId, ticket);
  }

  /** Stop watching a ticket whose admission failed before the runtime took it over. */
  discard(ticket: ProviderSwitchTicket): void {
    ticket.armed?.unsubscribe();
    ticket.armed = null;
    const threadId = ticket.command.threadId;
    if (this.armedByThread.get(threadId) === ticket) this.armedByThread.delete(threadId);
  }

  private observe(
    ticket: ProviderSwitchTicket,
    threadId: string,
    armed: ArmedSwitch,
    events: readonly CanonicalAgentEventEnvelope[],
  ): void {
    for (const event of events) {
      if (event.routing.turnId !== armed.turnId) continue;
      const payload = event.payload;
      if (payload.type === "turn.provider-started" && !armed.accepted) {
        armed.accepted = true;
        armed.committing = this.commit(ticket, threadId, armed);
      }
      if (payload.type === "turn.errored" && payload.failure?.code === SESSION_RESUME_UNAVAILABLE_CODE) {
        armed.resumeUnavailable = true;
      }
      if (isTerminal(payload.type)) {
        armed.settleTerminal();
        if (armed.accepted) armed.unsubscribe();
      }
    }
  }

  private async commit(ticket: ProviderSwitchTicket, threadId: string, armed: ArmedSwitch): Promise<void> {
    const plan = ticket.plan;
    if (!plan) return;
    if (!(await this.saveSwitch(ticket, threadId, armed, plan))) return;
    await this.writeAudit(ticket, threadId, plan);
  }

  /** Save the accepted switch, retrying once; a switch that still cannot be saved is reported in the timeline. */
  private async saveSwitch(ticket: ProviderSwitchTicket, threadId: string, armed: ArmedSwitch, plan: PlannedSwitch): Promise<boolean> {
    for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt += 1) {
      try {
        await this.threads.commitProviderSwitch(threadId, { ...armed.settings, provider: ticket.toProvider }, plan.staleSessionId);
        broadcast("thread.modelUpdated", { threadId, model: armed.settings.model, provider: ticket.toProvider });
        return true;
      } catch (error) {
        logger.error("Provider switch accepted by the target but not saved", {
          threadId, toProvider: ticket.toProvider, attempt, error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.reportUnsavedSwitch(threadId, ticket.toProvider);
    return false;
  }

  /**
   * The target is already running the turn but the thread still names the old provider. The next send
   * from the composer switches again and replays the history, so this tells the user why the header lags.
   */
  private async reportUnsavedSwitch(threadId: string, toProvider: ProviderId): Promise<void> {
    try {
      await this.writer.execute(turnConversationWriteOperations.systemNotice, {
        threadId,
        content: `This turn is running on ${toProvider}, but the switch to it was not saved. Send again to finish switching.`,
        notice: { kind: "warning", presentation: "timeline", scope: "turn" },
      });
    } catch (error) {
      logger.error("Provider switch failure notice was not written", {
        threadId, error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async writeAudit(ticket: ProviderSwitchTicket, threadId: string, plan: PlannedSwitch): Promise<void> {
    try {
      await this.storage.writeSwitchAudit(threadId, {
        fromProvider: ticket.fromProvider,
        toProvider: ticket.toProvider,
        coveredSequences: plan.handoff.selection.selectedSequences,
        omittedSequences: plan.handoff.selection.omittedSequences,
        budgetBytes: plan.handoff.selection.budgetBytes,
        droppedOptions: plan.dropped,
        history: plan.handoff.selection.text,
      });
    } catch (error) {
      // The audit copy is a record of what was sent; losing it must not undo a switch the target accepted.
      logger.error("Provider switch audit was not written", {
        threadId, error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The runtime freed the thread: settle the switch, and retry on a fresh session if the resume failed. */
  private async release(ticket: ProviderSwitchTicket, cause?: RuntimeReleaseCause): Promise<void> {
    if (cause === "admission-failed") return this.discard(ticket);
    const armed = ticket.armed;
    if (!armed) return;
    try {
      await armed.committing;
      // Release can fire before the terminal event commits; the resume verdict rides on that event.
      if (!armed.accepted) await armed.terminal;
    } finally {
      armed.unsubscribe();
    }
    if (this.armedByThread.get(ticket.command.threadId) === ticket) this.armedByThread.delete(ticket.command.threadId);
    if (armed.accepted || !armed.resumeUnavailable || ticket.plan?.resumeSessionId == null) return;
    await this.retryFresh(ticket, armed).catch((error: unknown) => {
      logger.error("Fresh-session retry after a failed provider resume did not start", {
        threadId: ticket.command.threadId, error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async retryFresh(ticket: ProviderSwitchTicket, armed: ArmedSwitch): Promise<void> {
    const dispatch = this.dispatch;
    if (!dispatch) throw new Error("Provider switch dispatch is not bound");
    const { threadId } = ticket.command;
    const selection = pickSelection(ticket.command);
    const runtime = { sendMessage: dispatch };
    // The fresh attempt reuses the user's row: the history it replays then ends before that row, and the
    // timeline shows the message once.
    await this.recovery.retryErroredTurn({ threadId, turnId: armed.turnId }, (retry) => sendAdmittedTurn(runtime, {
      ...retry,
      ...selection,
      forceFreshSession: true,
    }), { reuseUserMessage: true });
  }
}

/** Replace only the keys that carry the composer's selection, so the recovery command keeps its own content and attachments. */
function pickSelection(command: SendMessageCommand): Partial<SendMessageCommand> {
  const selection: Partial<SendMessageCommand> = {};
  for (const key of FALLBACK_SELECTION_KEYS) {
    if (command[key] !== undefined) Object.assign(selection, { [key]: command[key] });
  }
  return selection;
}

function isTerminal(type: string): boolean {
  return type === "turn.completed" || type === "turn.errored" || type === "turn.interrupted" || type === "turn.cancelled";
}

function settledPlan(input: {
  readonly ticket: ProviderSwitchTicket;
  readonly outcome: SwitchHandoffPlan | Error;
  readonly resume: ResolvedProviderSession | null;
  readonly staleSessionId: string | null;
  readonly dropped: readonly DroppedOption[];
  readonly throughSequence: number;
}): PlannedSwitch {
  const { outcome, resume, throughSequence } = input;
  const refusal = outcome instanceof Error ? outcome : null;
  const handoff = outcome instanceof Error ? emptyHandoff(input.ticket, input.ticket.command.threadId, throughSequence) : outcome;
  const resumeSessionId = handoff.mode === "delta" ? resume?.sessionId ?? null : null;
  return {
    handoff,
    resumeSessionId,
    staleSessionId: resumeSessionId ? null : input.staleSessionId,
    dropped: input.dropped,
    refusal,
  };
}

function supportsSessionResume(provider: IAgentProvider): boolean {
  return provider.descriptor.capabilities.some((capability) => (
    capability.name === "session-resume" && capability.support === "supported"
  ));
}

function attachmentKinds(command: SendMessageCommand): { kind: "image" | "file" }[] {
  const supplied = [
    ...(command.attachments ?? []),
    ...(command.persistedUserMessage?.persistedAttachments ?? []),
    ...(command.persistedAttachmentData?.persisted ?? []),
  ].map((attachment) => ({ kind: attachment.mimeType.startsWith("image/") ? "image" as const : "file" as const }));
  const staged = (command.stagedDraftImageIds ?? []).map(() => ({ kind: "image" as const }));
  return [...supplied, ...staged];
}

async function reconcileCommand(command: SendMessageCommand, toProvider: ProviderId, target: IAgentProvider) {
  const targetModel = await findModel(target, command.model);
  const { options, dropped } = reconcileSwitchOptions({
    options: {
      reasoningLevel: command.reasoningLevel,
      contextWindow: command.contextWindow,
      thinking: command.thinking,
      codexFastMode: command.codexFastMode,
      devinMode: command.devinMode,
    },
    toProvider,
    targetModel,
  });
  return {
    dropped,
    command: {
      ...command,
      reasoningLevel: options.reasoningLevel,
      contextWindow: options.contextWindow,
      thinking: options.thinking,
      codexFastMode: options.codexFastMode,
      devinMode: options.devinMode,
    } satisfies SendMessageCommand,
  };
}

async function findModel(provider: IAgentProvider, modelId: string | undefined): Promise<ProviderModelInfo | null> {
  if (!modelId) return null;
  try {
    return (await provider.listModels()).find((model) => model.id === modelId) ?? null;
  } catch (error) {
    // The catalog only refines which reasoning levels are offered; an unreachable one must not block the send.
    logger.warn("Model catalog unavailable while reconciling a provider switch", {
      provider: provider.id, error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function emptyHandoff(ticket: ProviderSwitchTicket, threadId: string, throughSequence: number): SwitchHandoffPlan {
  return {
    mode: "fresh",
    preamble: "",
    selection: { text: "", selectedSequences: [], omittedSequences: [], budgetBytes: 0 },
    coverage: {
      threadId, kind: "switch", fromProvider: ticket.fromProvider, toProvider: ticket.toProvider,
      fromSequence: throughSequence + 1, toSequence: throughSequence,
    },
  };
}
