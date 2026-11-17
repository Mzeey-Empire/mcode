import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { query, type ModelInfo, type SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "@mcode/shared";
import { CLAUDE_STATIC_MODELS } from "@mcode/contracts/providers/claude-static-fallback";
import { listClaudeModels, resetModelCache } from "../list-models.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

const reported: ModelInfo[] = [
  { value: "sonnet", resolvedModel: "claude-sonnet-6", displayName: "Sonnet 6", description: "",
    supportsEffort: true, supportedEffortLevels: ["low", "high"], supportsFastMode: true },
  { value: "claude-sonnet-6", displayName: "Duplicate", description: "" },
  { value: "claude-opus-5", displayName: "Opus 5", description: "",
    supportsEffort: true, supportedEffortLevels: ["medium", "high"] },
  { value: "default", displayName: "Default", description: "" },
];

describe("listClaudeModels", () => {
  const close = vi.fn();
  const initialize = vi.fn<() => Promise<Pick<SDKControlInitializeResponse, "models">>>();
  const resolveOptions = () => ({ pathToClaudeCodeExecutable: "/installed/claude", env: {} });
  let signal: AbortSignal | undefined;
  let prompt: AsyncIterable<unknown> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    resetModelCache();
    vi.mocked(query).mockReset();
    close.mockClear();
    initialize.mockReset().mockResolvedValue({ models: reported });
    // The SDK subprocess is the external boundary; its unused Query surface is irrelevant here.
    vi.mocked(query).mockImplementation((input) => {
      signal = input.options?.abortController?.signal;
      prompt = typeof input.prompt === "string" ? undefined : input.prompt;
      return Object.assign({ initializationResult: initialize, close });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("includes new CLI models, deduplicates resolved aliases, and preserves static ordering and metadata", async () => {
    const result = await listClaudeModels(resolveOptions);
    expect(result.map((model) => model.id)).toEqual(["claude-opus-5", "claude-sonnet-6"]);
    expect(result[0]).toMatchObject({
      contextWindow: 1_000_000, lifecycle: "legacy", supportedReasoningEfforts: ["medium", "high"],
      defaultReasoningEffort: "high",
    });
    expect(result[1]).toMatchObject({
      name: "Sonnet 6", supportsReasoning: true, supportedReasoningEfforts: ["low", "high"],
      supportsFastMode: true,
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
  });

  it("never sends a prompt and closes the waiting input after initialization", async () => {
    let finish: ((value: Pick<SDKControlInitializeResponse, "models">) => void) | undefined;
    initialize.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const result = listClaudeModels(resolveOptions);
    const next = prompt?.[Symbol.asyncIterator]().next();
    finish?.({ models: reported });
    await result;
    expect(await next).toEqual({ done: true, value: undefined });
  });

  it("uses CLI capability restrictions over static capabilities", async () => {
    initialize.mockResolvedValue({ models: [{
      value: "claude-opus-5", displayName: "Opus", description: "", supportsEffort: false,
    }] });
    expect(await listClaudeModels(resolveOptions)).toMatchObject([{
      supportsReasoning: false, supportedReasoningEfforts: [], defaultReasoningEffort: undefined,
    }]);
  });

  it("shares concurrent probes and reuses the cached result until expiry", async () => {
    const [a, b] = await Promise.all([listClaudeModels(resolveOptions), listClaudeModels(resolveOptions)]);
    expect(a.map((model) => model.id)).toEqual(["claude-opus-5", "claude-sonnet-6"]);
    expect(b).toBe(a);
    expect(await listClaudeModels(resolveOptions)).toBe(a);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_001);
    await listClaudeModels(resolveOptions);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("caches failures, logs the reason once, and retries after expiry", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    initialize.mockRejectedValue(new Error("Sign-in required"));
    expect(await listClaudeModels(resolveOptions)).toEqual(CLAUDE_STATIC_MODELS);
    expect(await listClaudeModels(resolveOptions)).toEqual(CLAUDE_STATIC_MODELS);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_001);
    expect(await listClaudeModels(resolveOptions)).toEqual(CLAUDE_STATIC_MODELS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), { reason: "Sign-in required" });
    initialize.mockResolvedValue({ models: reported });
    await vi.advanceTimersByTimeAsync(300_001);
    expect((await listClaudeModels(resolveOptions)).map((model) => model.id))
      .toEqual(["claude-opus-5", "claude-sonnet-6"]);
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("bounds initialization and closes a stalled probe before serving fallback", async () => {
    initialize.mockImplementation(() => new Promise(() => {}));
    const result = listClaudeModels(resolveOptions);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual(CLAUDE_STATIC_MODELS);
    expect(close).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(await listClaudeModels(resolveOptions)).toEqual(CLAUDE_STATIC_MODELS);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("falls back when the executable cannot resolve or spawn", async () => {
    expect(await listClaudeModels(() => { throw new Error("Claude missing"); })).toEqual(CLAUDE_STATIC_MODELS);
    expect(query).not.toHaveBeenCalled();
    resetModelCache();
    vi.mocked(query).mockImplementation(() => { throw new Error("Spawn failed"); });
    expect(await listClaudeModels(resolveOptions)).toEqual(CLAUDE_STATIC_MODELS);
  });

  it("falls back rather than returning an empty picker", async () => {
    initialize.mockResolvedValue({ models: [] });
    expect(await listClaudeModels(resolveOptions)).toEqual(CLAUDE_STATIC_MODELS);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
