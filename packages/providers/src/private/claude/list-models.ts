import { query, type ModelInfo, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "@mcode/shared";
import { CLAUDE_STATIC_MODELS, withClaudeLifecycle } from "@mcode/contracts/providers/claude-static-fallback";
import type { ProviderModelInfo } from "@mcode/contracts/providers/models";
import type { ReasoningLevel } from "@mcode/contracts/models/settings";
import * as NodeOS from "node:os";
import type { ClaudeOwnedProcess } from "./claude-process.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;
type ProbeOptions = Pick<Options, "pathToClaudeCodeExecutable" | "env">;

const cache = new Map<string | undefined, { models: Promise<ProviderModelInfo[]>; timestamp: number }>();
const loggedFailures = new Set<string>();
const lastGood = new Map<string | undefined, ProviderModelInfo[]>();

function fromCliModel(info: ModelInfo, id: string): ProviderModelInfo {
  return withClaudeLifecycle({
    supportsReasoning: info.supportsEffort ?? Boolean(info.supportedEffortLevels?.length),
    supportedReasoningEfforts: info.supportsEffort === false ? [] : info.supportedEffortLevels,
    id,
    supportsFastMode: info.supportsFastMode === true,
    name: info.displayName.trim() || id,
  });
}

/** Claude Code builds that report no effort fields leave the catalog's efforts in place. */
function withCliCapabilities(known: ProviderModelInfo, info: ModelInfo): ProviderModelInfo {
  const capabilities = { ...known, supportsFastMode: info.supportsFastMode === true };
  if (info.supportsEffort === undefined && info.supportedEffortLevels === undefined) return capabilities;
  const efforts = info.supportsEffort === false ? [] : info.supportedEffortLevels ?? known.supportedReasoningEfforts ?? [];
  return {
    ...capabilities,
    supportsReasoning: efforts.length > 0,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: known.defaultReasoningEffort && efforts.includes(known.defaultReasoningEffort)
      ? known.defaultReasoningEffort : undefined,
  };
}

function mapModels(reported: ModelInfo[]): ProviderModelInfo[] {
  const models = new Map(CLAUDE_STATIC_MODELS.map((model) => [model.id, model]));
  const seen = new Set<string>();
  for (const info of reported) {
    let id = (info.resolvedModel?.trim() || info.value.trim()).replace(/\[1m\]$/, "");
    const undated = id.replace(/-\d{8}$/, "");
    if (CLAUDE_STATIC_MODELS.some((model) => model.id === undated)) id = undated;
    if (!/^claude-[a-z0-9-]+$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const known = models.get(id);
    models.set(id, known ? withCliCapabilities(known, info) : fromCliModel(info, id));
  }
  return [...models.values()];
}

async function probeModels(options: ProbeOptions, createProcess: () => ClaudeOwnedProcess): Promise<ProviderModelInfo[]> {
  const ownedProcess = createProcess();
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
  let q: ReturnType<typeof query> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    q = query({ prompt, options: {
      ...options,
      ...(options.pathToClaudeCodeExecutable?.endsWith(".js") ? { executable: "node" } : {}),
      abortController: abort,
      spawnClaudeCodeProcess: ownedProcess.spawn,
      cwd: NodeOS.tmpdir(),
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
      tools: [],
      settingSources: ["user"],
      // Discovery must honor user model settings without running their session hooks.
      settings: { disableAllHooks: true },
    } });
    const init = await Promise.race([
      q.initializationResult(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude model probe timed out")), PROBE_TIMEOUT_MS);
      }),
    ]);
    return mapModels(init.models);
  } finally {
    clearTimeout(timer);
    abort.abort();
    try {
      q?.close();
    } finally {
      await ownedProcess.retire();
    }
  }
}

function logFailure(error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  if (loggedFailures.has(reason)) return;
  loggedFailures.add(reason);
  logger.warn("Claude model discovery failed; using last good list or static catalog", { reason });
}

async function fetchModels(options: ProbeOptions, createProcess: () => ClaudeOwnedProcess): Promise<ProviderModelInfo[]> {
  try {
    const models = await probeModels(options, createProcess);
    lastGood.set(options.pathToClaudeCodeExecutable, models);
    return models;
  } catch (error) {
    logFailure(error);
    return lastGood.get(options.pathToClaudeCodeExecutable) ?? [...CLAUDE_STATIC_MODELS];
  }
}

/**
 * Effort levels the last successful discovery reported for a model, or undefined before any discovery. Reads only
 * memory, so a send never waits on a probe. An empty list means the model takes no effort.
 */
export function discoveredClaudeEfforts(executable: string | undefined, modelId: string): readonly ReasoningLevel[] | undefined {
  const models = lastGood.get(executable);
  const model = models?.find((entry) => entry.id === modelId) ?? models?.find((entry) => entry.id === modelId.replace(/-\d{8}$/, ""));
  if (!model) return undefined;
  return model.supportsReasoning === false ? [] : model.supportedReasoningEfforts ?? [];
}

/** Clear discovery state between tests; production refreshes through the five-minute TTL. */
export function resetModelCache(): void {
  cache.clear();
  lastGood.clear();
  loggedFailures.clear();
}

/** Discover Claude Code's models, caching success or fallback and sharing one in-flight probe. */
export async function listClaudeModels(resolveOptions: () => ProbeOptions, createProcess: () => ClaudeOwnedProcess): Promise<ProviderModelInfo[]> {
  let options: ProbeOptions;
  try {
    options = resolveOptions();
  } catch (error) {
    logFailure(error);
    return [...CLAUDE_STATIC_MODELS];
  }
  const key = options.pathToClaudeCodeExecutable;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.models;
  const entry = { models: fetchModels(options, createProcess), timestamp: Infinity };
  cache.set(key, entry);
  void entry.models.then(() => { entry.timestamp = Date.now(); });
  return entry.models;
}
