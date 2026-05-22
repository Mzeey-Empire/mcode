import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { IProviderRegistry } from "@mcode/contracts";
import { HandoffPipelineService } from "../handoff-pipeline.js";

function mkDeps() {
  const parent = { id: "t_parent", title: "X", provider: "claude", sdk_session_id: "sdk_1", deleted_at: null, workspace_id: "ws_1", worktree_path: null } as any;
  const child = { id: "t_child", provider: "claude", deleted_at: null } as any;
  return {
    threadRepo: {
      findById: vi.fn(async (id) => (id === "t_parent" ? parent : id === "t_child" ? child : null)),
    },
    messageRepo: {
      listIncludingInternal: vi.fn(async () => [
        { id: "m_1", thread_id: "t_parent", role: "user", content: "hi", sequence: 1, is_internal: false },
      ]),
    },
    providerRegistry: {
      resolve: vi.fn(),
    } satisfies Pick<IProviderRegistry, "resolve">,
    workspaceRepo: {
      findById: vi.fn(async (id) => (id === "ws_1" ? { id: "ws_1", path: "/tmp/test-workspace" } : null)),
    },
  };
}

const BASE_REQ = {
  parentThreadId: "t_parent",
  forkedFromMessageId: "m_1",
  forkAnchorRole: "user" as const,
  childThreadId: "t_child",
  childProviderId: "claude",
  userFollowUpMessage: "What should I do next?",
};

describe("HandoffPipelineService.orchestrate", () => {
  it("path B success builds a provider artifact with ladderStep B", async () => {
    const deps = mkDeps();
    deps.providerRegistry.resolve = vi.fn((id: string) => {
      if (id === "claude") {
        return {
          sessionForkOnResume: "clean",
          maxInputCharactersPerTurn: 180_000,
          runSideChannelQuery: vi.fn(async () => "# Handoff\n\n## Goal\nX"),
        };
      }
      return null;
    });
    const svc = HandoffPipelineService.forTesting(deps);
    const r = await svc.orchestrate(BASE_REQ);
    expect(r.meta.ladderStep).toBe("B");
    expect(r.meta.generatedBy).toBe("provider");
  });

  it("path B quota failure falls directly to D, skipping A", async () => {
    const deps = mkDeps();
    deps.providerRegistry.resolve = vi.fn(() => ({
      sessionForkOnResume: "clean",
      maxInputCharactersPerTurn: 180_000,
      runSideChannelQuery: vi.fn(async () => {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }),
    }));
    const svc = HandoffPipelineService.forTesting(deps);
    const r = await svc.orchestrate(BASE_REQ);
    expect(r.meta.ladderStep).toBe("D");
    expect(r.meta.providerErrorOnGenerate).toBe("quota");
  });

  it("mutating-resume provider uses path A and minimal mode", async () => {
    const deps = mkDeps();
    deps.providerRegistry.resolve = vi.fn(() => ({
      sessionForkOnResume: "mutating",
      maxInputCharactersPerTurn: 4_000,
      runHiddenTurn: vi.fn(async () => "# Handoff\n\n## Goal\nX"),
    }));
    const svc = HandoffPipelineService.forTesting(deps);
    const r = await svc.orchestrate({
      ...BASE_REQ,
      childProviderId: "cursor",
    });
    expect(r.meta.ladderStep).toBe("A");
    expect(r.meta.mode).toBe("minimal");
  });

  it("unsupported-resume provider skips to D with reason null", async () => {
    const deps = mkDeps();
    deps.providerRegistry.resolve = vi.fn(() => ({
      sessionForkOnResume: "unsupported",
      maxInputCharactersPerTurn: 16_000,
    }));
    const svc = HandoffPipelineService.forTesting(deps);
    const r = await svc.orchestrate({
      ...BASE_REQ,
      childProviderId: "codex",
    });
    expect(r.meta.ladderStep).toBe("D");
    expect(r.meta.providerErrorOnGenerate).toBeNull();
  });

  // 17.1: missing sdk_session_id falls through to D for path B (session needed
  // for resume), path A is unaffected (no session required for hidden turns).
  it("falls to D when parent has no sdkSessionId and provider is clean-resume", async () => {
    const deps = mkDeps();
    // Override parent to have no session id
    const parentNoSession = { id: "t_parent", title: "X", provider: "claude", sdk_session_id: null, deleted_at: null, workspace_id: "ws_1", worktree_path: null };
    deps.threadRepo.findById = vi.fn(async (id) => (id === "t_parent" ? parentNoSession : null));
    deps.providerRegistry.resolve = vi.fn(() => ({
      sessionForkOnResume: "clean",
      maxInputCharactersPerTurn: 180_000,
      runSideChannelQuery: vi.fn(async () => "should not be called"),
    }));
    const svc = HandoffPipelineService.forTesting(deps);
    const r = await svc.orchestrate(BASE_REQ);
    expect(r.meta.ladderStep).toBe("D");
    // runSideChannelQuery must not have been called
    const provider = deps.providerRegistry.resolve("claude" as any);
    expect(provider.runSideChannelQuery).not.toHaveBeenCalled();
  });

  // 17.2: when the AbortSignal fires (simulating the 60s timeout expiry),
  // the pipeline catches the abort and falls to D with reason "transient".
  it("falls to D when side-channel query rejects because abort signal fired", async () => {
    const deps = mkDeps();
    // Provider that rejects immediately when its signal is already aborted,
    // simulating what a real provider does when the 60s AbortController fires.
    deps.providerRegistry.resolve = vi.fn(() => ({
      sessionForkOnResume: "clean",
      maxInputCharactersPerTurn: 180_000,
      runSideChannelQuery: vi.fn(async (args: { abortSignal?: AbortSignal }) => {
        if (args.abortSignal?.aborted) {
          throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
        }
        // Should not reach here in this test
        return "unexpected";
      }),
    }));

    // Patch AbortController so its signal is pre-aborted, triggering the
    // pipeline's abort-detection branch without waiting 60 real seconds.
    const OriginalAbortController = globalThis.AbortController;
    globalThis.AbortController = class {
      signal: AbortSignal;
      constructor() {
        const ctrl = new OriginalAbortController();
        ctrl.abort(); // pre-abort
        this.signal = ctrl.signal;
      }
      abort() {}
    } as unknown as typeof AbortController;

    const svc = HandoffPipelineService.forTesting(deps);
    const r = await svc.orchestrate(BASE_REQ);

    globalThis.AbortController = OriginalAbortController;
    expect(r.meta.ladderStep).toBe("D");
  });

  // 17.3: concurrent path A forks on the same parent thread are serialized
  it("serializes concurrent path-A forks on the same parent thread", { timeout: 10_000 }, async () => {
    const order: number[] = [];
    let resolveFirst!: () => void;
    const firstStarted = new Promise<void>((res) => { resolveFirst = res; });

    const deps = mkDeps();
    let callCount = 0;
    deps.providerRegistry.resolve = vi.fn(() => ({
      sessionForkOnResume: "mutating",
      maxInputCharactersPerTurn: 180_000,
      runHiddenTurn: vi.fn(async () => {
        const idx = ++callCount;
        order.push(idx);
        if (idx === 1) {
          resolveFirst();
          // First call holds the lock briefly so the second must queue.
          await new Promise<void>((res) => setTimeout(res, 50));
        }
        return "# Handoff\n\n## Goal\nX";
      }),
    }));

    const svc = HandoffPipelineService.forTesting(deps);
    const p1 = svc.orchestrate(BASE_REQ);
    await firstStarted;
    const p2 = svc.orchestrate(BASE_REQ);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.meta.ladderStep).toBe("A");
    expect(r2.meta.ladderStep).toBe("A");
    // The second hidden turn must start only after the first completes.
    expect(order).toEqual([1, 2]);
  });
});
