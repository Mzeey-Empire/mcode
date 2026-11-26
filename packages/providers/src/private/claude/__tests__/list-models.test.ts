import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { query, type ModelInfo, type SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "@mcode/shared";
import { CLAUDE_STATIC_MODELS } from "@mcode/contracts/providers/claude-static-fallback";
import { discoveredClaudeEfforts, listClaudeModels as discoverModels, resetModelCache } from "../list-models.js";
import { ClaudeOwnedProcess } from "../claude-process.js";
import { mockShutdownHost } from "../../__tests__/helpers/mock-shutdown-host.js";
import * as NodeOS from "node:os";

const listClaudeModels = (options: Parameters<typeof discoverModels>[0]) => discoverModels(options,
  () => new ClaudeOwnedProcess(mockShutdownHost(() => {}).processes, "probe", () => {}, undefined, async () => {}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

const reported: ModelInfo[] = [
  { value: "sonnet", resolvedModel: "claude-sonnet-6", displayName: "Sonnet 6", description: "",
    supportsEffort: true, supportedEffortLevels: ["low", "high"], supportsFastMode: true },
  { value: "claude-sonnet-6", displayName: "Duplicate", description: "" },
  { value: "default", displayName: "Default", description: "" },
];

describe("listClaudeModels", () => {
  it("maps Fast independently of effort metadata for catalog and new models", async () => {
    initialize.mockResolvedValue({ models: [
      { value: "claude-opus-5-5", displayName: "Opus", description: "", supportsFastMode: true },
      { value: "claude-opus-6", displayName: "Opus 6", description: "", supportsFastMode: true },
      { value: "claude-sonnet-5-5", displayName: "Sonnet", description: "" },
    ] });
    const models = await listClaudeModels(resolveOptions);
    expect(models.find((model) => model.id === "claude-opus-5-5")?.supportsFastMode).toBe(true);
    expect(models.find((model) => model.id === "claude-opus-6")?.supportsFastMode).toBe(true);
    expect(models.find((model) => model.id === "claude-sonnet-5-5")?.supportsFastMode).toBe(false);
  });
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
    expect(result.slice(0, -1)).toEqual(CLAUDE_STATIC_MODELS);
    expect(result.at(-1)).toEqual({
      id: "claude-sonnet-6",
      name: "Sonnet 6", supportsReasoning: true, supportedReasoningEfforts: ["low", "high"], supportsFastMode: true,
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

  it("keeps static metadata but honors CLI effort restrictions", async () => {
    initialize.mockResolvedValue({ models: [{
      value: "claude-opus-5", displayName: "Opus", description: "", supportsEffort: false,
    }] });
    const result = await listClaudeModels(resolveOptions);
    expect(result.find((model) => model.id === "claude-opus-5")).toEqual({
      ...CLAUDE_STATIC_MODELS.find((model) => model.id === "claude-opus-5"),
      supportsReasoning: false, supportedReasoningEfforts: [], defaultReasoningEffort: undefined, supportsFastMode: false,
    });
  });

  it("exposes the reported efforts for sends only after a successful discovery for that executable", async () => {
    expect(discoveredClaudeEfforts("/installed/claude", "claude-sonnet-6")).toBeUndefined();
    initialize.mockResolvedValue({ models: [
      ...reported,
      { value: "claude-opus-5", displayName: "Opus", description: "", supportsEffort: false },
    ] });
    await listClaudeModels(resolveOptions);
    expect(discoveredClaudeEfforts("/installed/claude", "claude-sonnet-6")).toEqual(["low", "high"]);
    expect(discoveredClaudeEfforts("/installed/claude", "claude-opus-5-20261117")).toEqual([]);
    expect(discoveredClaudeEfforts("/other/claude", "claude-sonnet-6")).toBeUndefined();
  });

  it("keeps catalog efforts when Claude Code reports none for a known model", async () => {
    initialize.mockResolvedValue({ models: [{ value: "claude-opus-5", displayName: "Opus", description: "" }] });
    expect((await listClaudeModels(resolveOptions)).find((model) => model.id === "claude-opus-5"))
      .toEqual({ ...CLAUDE_STATIC_MODELS.find((model) => model.id === "claude-opus-5"), supportsFastMode: false });
  });

  it.each([
    [["low", "medium"], undefined],
    [["low", "high"], "high"],
  ] as const)("uses CLI efforts %j and retains only a supported default", async (levels, defaultEffort) => {
    initialize.mockResolvedValue({ models: [{
      value: "claude-opus-5-20261117[1m]", displayName: "CLI Opus", description: "",
      supportsEffort: true, supportedEffortLevels: [...levels],
    }] });
    expect((await listClaudeModels(resolveOptions)).find((model) => model.id === "claude-opus-5"))
      .toEqual({
        ...CLAUDE_STATIC_MODELS.find((model) => model.id === "claude-opus-5"),
        supportsReasoning: true, supportedReasoningEfforts: [...levels], defaultReasoningEffort: defaultEffort, supportsFastMode: false,
      });
  });

  it("retains the last successful list across failed refreshes only for its executable", async () => {
    const good = await listClaudeModels(resolveOptions);
    initialize.mockRejectedValue(new Error("CLI unavailable"));
    for (let refresh = 0; refresh < 2; refresh++) {
      await vi.advanceTimersByTimeAsync(300_001);
      expect(await listClaudeModels(resolveOptions)).toBe(good);
    }
    expect(await listClaudeModels(() => ({ pathToClaudeCodeExecutable: "/other/claude" })))
      .toEqual(CLAUDE_STATIC_MODELS);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("runs a JavaScript CLI entry point with node", async () => {
    await listClaudeModels(() => ({ pathToClaudeCodeExecutable: "/installed/cli.js" }));
    expect(vi.mocked(query).mock.calls[0]?.[0].options).toMatchObject({
      pathToClaudeCodeExecutable: "/installed/cli.js", executable: "node",
    });
  });

  it("shares concurrent probes and reuses the cached result until expiry", async () => {
    const [a, b] = await Promise.all([listClaudeModels(resolveOptions), listClaudeModels(resolveOptions)]);
    expect(a.slice(0, -1)).toEqual(CLAUDE_STATIC_MODELS);
    expect(a.at(-1)?.id).toBe("claude-sonnet-6");
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
    expect((await listClaudeModels(resolveOptions)).at(-1)?.id).toBe("claude-sonnet-6");
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

  it.each([
    ["alias only", "sonnet"],
    ["Bedrock", "us.anthropic.claude-sonnet-5-5"],
    ["invalid id", "claude-sonnet/6"],
  ])("keeps the static catalog for %s", async (_, value) => {
    initialize.mockResolvedValue({ models: [{ value, displayName: "CLI name", description: "" }] });
    expect(await listClaudeModels(resolveOptions)).toEqual(CLAUDE_STATIC_MODELS);
  });

  it("keys both in-flight and cached discovery by executable path only", async () => {
    const first = listClaudeModels(resolveOptions);
    initialize.mockResolvedValue({ models: [{ value: "claude-opus-6", displayName: "Opus 6", description: "" }] });
    const second = listClaudeModels(() => ({ pathToClaudeCodeExecutable: "/other/claude" }));
    expect((await first).at(-1)?.id).toBe("claude-sonnet-6");
    expect((await second).at(-1)?.id).toBe("claude-opus-6");
    expect(await listClaudeModels(() => ({ pathToClaudeCodeExecutable: "/other/claude", env: { OTHER: "value" } })))
      .toBe(await second);
    expect(await listClaudeModels(resolveOptions)).toBe(await first);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("isolates initialization from project files and MCP servers", async () => {
    await listClaudeModels(resolveOptions);
    expect(vi.mocked(query).mock.calls[0]?.[0].options).toMatchObject({
      cwd: NodeOS.tmpdir(), strictMcpConfig: true, mcpServers: {},
      settings: { disableAllHooks: true }, persistSession: false, tools: [],
      spawnClaudeCodeProcess: expect.any(Function),
    });
  });

  it("logs each distinct failure once across refreshes", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    for (const reason of ["Signed out", "Signed out", "CLI failed", "CLI failed"]) {
      initialize.mockRejectedValue(new Error(reason));
      expect(await listClaudeModels(resolveOptions)).toEqual(CLAUDE_STATIC_MODELS);
      await vi.advanceTimersByTimeAsync(300_001);
    }
    expect(warn.mock.calls.map((call) => call[1])).toEqual([{ reason: "Signed out" }, { reason: "CLI failed" }]);
  });
});
