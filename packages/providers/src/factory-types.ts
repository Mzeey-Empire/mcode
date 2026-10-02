import type { Provider } from "@mcode/agent-model";
import type {
  IAgentProvider,
  IGoalCapable,
  ISessionEvictable,
  ICompletionCapable,
  Settings,
  SkillInfo,
  StoredAttachment,
  SessionForker,
} from "@mcode/contracts";
import type { ProviderHostPorts } from "./host-ports.js";
import type { CodexCanonicalEventRouting } from "./private/codex/codex-canonical-event-publisher.js";

/** Configuration validated by every inert Provider factory. */
export interface ProviderFactoryConfiguration {
  cliPath: string;
  idleSessionTtlMs: number;
}

/** Input accepted by each public Provider factory. */
export interface ProviderFactoryInput {
  configuration: ProviderFactoryConfiguration;
  host: ProviderHostPorts;
  codex?: CodexProviderPorts;
  cursor?: CursorProviderPorts;
  devin?: DevinProviderPorts;
  claude?: ClaudeProviderPorts;
  copilot?: CopilotProviderPorts;
}

/** Narrow generation operation composed with the server's handoff policy. */
export interface ClaudeSideChannelGenerator {
  readonly id: "claude";
  runSideChannelQuery(args: {
    parentThreadId: string;
    parentSdkSessionId: string;
    prompt: string;
    abortSignal?: AbortSignal;
    conversationHistory?: string;
    cwd: string;
  }): Promise<string>;
}

/** Server-owned handoff composition required by the Claude factory. */
export interface ClaudeProviderPorts {
  createForker(generator: ClaudeSideChannelGenerator): SessionForker;
}

/** Exact canonical turn and delivery attempt that produced Claude events. */
export type ClaudeCanonicalEventRouting = import("./private/canonical-live-event-publisher.js").CanonicalLiveEventRouting;

/** Usable Claude provider with the narrow controls required by server callers. */
export type ClaudeProviderBoundary = IGoalCapable & ISessionEvictable & ICompletionCapable & ProviderBoundary & ClaudeSideChannelGenerator & {
  waitForSessionExit(sessionId: string, timeoutMs?: number): Promise<void>;
  setPlanAnswerMode(threadId: string, enabled: boolean): void;
  setCanonicalTurnDeliveryFailureHandler(handler: (routing: ClaudeCanonicalEventRouting, error: Error) => void | Promise<void>): void;
};

/** Normalized launch data supplied by the server's CLI discovery authority. */
export interface CopilotProviderPorts {
  launch: {
    resolve(): Promise<{ cliPath: string; env: Record<string, string>; githubToken?: string }>;
  };
}

/** Usable Copilot Provider returned by its public factory. */
export type CopilotProviderBoundary = IAgentProvider & ProviderBoundary & {
  setCanonicalTurnDeliveryFailureHandler(handler: (routing: { threadId: string; turnId: string; executionId: string; deliveryAttempt: number }, error: Error) => Promise<void>): void;
};

/** Server-owned authorities required by the Codex Provider. */
export interface CodexProviderPorts {
  settings: {
    get(): { cliPath: string; fastMode: boolean } | Promise<{ cliPath: string; fastMode: boolean }>;
  };
  attachments: {
    persistGeneratedImageFromPath(threadId: string, sourcePath: string): StoredAttachment;
  };
  catalog: {
    listModels(): Promise<import("@mcode/contracts").ProviderModelInfo[]>;
    currentSkills(cwd?: string): SkillInfo[];
    currentPrompts(): SkillInfo[];
    refreshCustomPrompts(): Promise<{ prompts: SkillInfo[] }>;
    shutdown(): Promise<void>;
  };
}

/** Server-owned authorities required by the Cursor Provider. */
export interface CursorProviderPorts {
  settings: {
    get(): Settings;
  };
  skills: {
    list(cwd: string, provider: "cursor"): SkillInfo[];
  };
}

/** Server-owned authorities required by the Devin Provider. */
export interface DevinProviderPorts {
  settings: {
    get(): Settings;
  };
}

/** Prepared Provider boundary returned without CLI inspection or process startup. */
export interface ProviderBoundary {
  readonly id: "claude" | "codex" | "copilot" | "cursor" | "devin" | "opencode";
  readonly descriptor: Provider;
}

/** Usable Codex Provider returned by its public factory. */
export type CodexProviderBoundary = IAgentProvider & ProviderBoundary & {
  setCanonicalTurnEventDeliveryEnabled(enabled: boolean): void;
  setCanonicalTurnDeliveryFailureHandler(handler: (routing: CodexCanonicalEventRouting, error: Error) => void | Promise<void>): void;
  fenceCanonicalTurnEvents(routing: CodexCanonicalEventRouting, options?: { discardQueued?: boolean }): Promise<void>;
  waitForCanonicalTurnEvents(routing: CodexCanonicalEventRouting): Promise<void>;
  retireCanonicalTurnEvents(routing: CodexCanonicalEventRouting): Promise<void>;
};

/** Usable Cursor Provider returned by its public factory. */
export type CursorProviderBoundary = IAgentProvider & ProviderBoundary & {
  onSkillRegistryDebouncedInvalidation(): void;
};

/** Usable Devin Provider returned by its public factory. */
export type DevinProviderBoundary = IAgentProvider & ProviderBoundary;
