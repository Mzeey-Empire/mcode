import type {
  ForkRequest,
  HandoffArtifact,
  HandoffMeta,
  SessionForker,
} from "@mcode/contracts";

/** Provides the isolated Copilot query used to build a clean handoff artifact. */
export interface CopilotCleanForkCapable {
  runSideChannelQuery(args: {
    parentThreadId: string;
    parentSdkSessionId: string;
    prompt: string;
    abortSignal?: AbortSignal;
    conversationHistory?: string;
    cwd: string;
  }): Promise<string>;
}

/** Builds full Path B handoff artifacts through Copilot's isolated side channel. */
export class CopilotCleanForker implements SessionForker {
  constructor(private readonly provider: CopilotCleanForkCapable) {}

  /** Queries an isolated session with supplied parent history and returns its handoff artifact. */
  async fork(request: ForkRequest): Promise<HandoffArtifact> {
    const markdown = await this.provider.runSideChannelQuery({
      parentThreadId: request.parentThreadId,
      parentSdkSessionId: request.parentSdkSessionId ?? "",
      prompt: request.prompt,
      abortSignal: request.abortSignal,
      conversationHistory: request.conversationHistory,
      cwd: request.cwd,
    });
    const parent = request.parentThread;
    const meta: HandoffMeta = {
      schemaVersion: 1,
      parentThreadId: request.parentThreadId,
      forkedFromMessageId: request.forkedFromMessageId,
      forkAnchorRole: request.forkAnchorRole,
      childThreadId: request.childThreadId,
      generatedBy: "provider",
      provider: parent.provider,
      ladderStep: "B",
      mode: "full",
      generatedAt: new Date().toISOString(),
      characterCount: markdown.length,
      parentSdkSessionId: parent.sdk_session_id ?? null,
      providerErrorOnGenerate: null,
      regenerationHistory: [],
      attachments: [],
      ...(request.historyBudget && { historyBudget: request.historyBudget }),
    };
    return { markdown, meta };
  }
}
