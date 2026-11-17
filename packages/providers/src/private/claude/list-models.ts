import { query, type ModelInfo, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "@mcode/shared";
import { CLAUDE_STATIC_MODELS, withClaudeLifecycle } from "@mcode/contracts/providers/claude-static-fallback";
import type { ProviderModelInfo } from "@mcode/contracts/providers/models";

const CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;
type ProbeOptions = Pick<Options, "pathToClaudeCodeExecutable" | "env">;

let cachedModels: ProviderModelInfo[] | null = null;
let cacheTimestamp = 0;
let inflight: Promise<ProviderModelInfo[]> | null = null;
let loggedFailure = false;

function reasoningMetadata(info: ModelInfo, metadata: ProviderModelInfo | undefined): Partial<ProviderModelInfo> {
  const efforts = info.supportsEffort === false
    ? []
    : info.supportedEffortLevels ?? metadata?.supportedReasoningEfforts;
  const defaultEffort = metadata?.defaultReasoningEffort;
  return {
    supportsReasoning: info.supportsEffort ?? metadata?.supportsReasoning,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: defaultEffort && efforts?.includes(defaultEffort) ? defaultEffort : undefined,
  };
}

function fromCliModel(info: ModelInfo, id: string): ProviderModelInfo {
  const metadata = CLAUDE_STATIC_MODELS.find((model) => model.id === id);
  return withClaudeLifecycle({
    ...metadata,
    ...reasoningMetadata(info, metadata),
    id,
    name: info.displayName.trim() || id,
    supportsFastMode: info.supportsFastMode,
  });
}

function mapModels(reported: ModelInfo[]): ProviderModelInfo[] {
  const models = new Map<string, ProviderModelInfo>();
  for (const info of reported) {
    if (!info.value.trim() || info.value === "default") continue;
    const id = info.resolvedModel?.trim() || info.value.trim();
    if (models.has(id)) continue;
    models.set(id, fromCliModel(info, id));
  }
  const order = new Map(CLAUDE_STATIC_MODELS.map((model, index) => [model.id, index]));
  return [...models.values()].sort((a, b) =>
    (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
}

async function probeModels(options: ProbeOptions): Promise<ProviderModelInfo[]> {
  const abort = new AbortController();
  // Keep stdin open without yielding a user message: initialization spends no tokens.
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise((resolve) => {
        if (abort.signal.aborted) resolve({ done: true, value: undefined });
        else abort.signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
      }),
    }),
  };
  const q = query({ prompt, options: {
    ...options,
    abortController: abort,
    persistSession: false,
    tools: [],
    settingSources: ["user"],
    // Discovery must honor user model settings without running their session hooks.
    settings: { disableAllHooks: true },
  } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const init = await Promise.race([
      q.initializationResult(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude model probe timed out")), PROBE_TIMEOUT_MS);
      }),
    ]);
    const models = mapModels(init.models);
    if (!models.length) throw new Error("Claude Code reported no selectable models");
    return models;
  } finally {
    clearTimeout(timer);
    abort.abort();
    q.close();
  }
}

async function fetchModels(resolveOptions: () => ProbeOptions): Promise<ProviderModelInfo[]> {
  let models: ProviderModelInfo[];
  try {
    models = await probeModels(resolveOptions());
  } catch (error) {
    if (!loggedFailure) {
      logger.warn("Claude model discovery failed; using static catalog", {
        reason: error instanceof Error ? error.message : "Unknown error",
      });
      loggedFailure = true;
    }
    models = [...CLAUDE_STATIC_MODELS];
  }
  cachedModels = models;
  cacheTimestamp = Date.now();
  return models;
}

/** Clear discovery state between tests; production refreshes through the five-minute TTL. */
export function resetModelCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
  inflight = null;
  loggedFailure = false;
}

/** Discover Claude Code's models, caching success or fallback and sharing one in-flight probe. */
export async function listClaudeModels(resolveOptions: () => ProbeOptions): Promise<ProviderModelInfo[]> {
  if (cachedModels && Date.now() - cacheTimestamp < CACHE_TTL_MS) return cachedModels;
  if (inflight) return inflight;
  inflight = fetchModels(resolveOptions).finally(() => { inflight = null; });
  return inflight;
}
