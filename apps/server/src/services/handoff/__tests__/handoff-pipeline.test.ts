import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { HandoffPipelineService } from "../handoff-pipeline.js";

function mkDeps() {
  const parent = { id: "t_parent", title: "X", provider: "claude", sdk_session_id: "sdk_1", deleted_at: null } as any;
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
      get: vi.fn(),
    },
  } as any;
}

describe("HandoffPipelineService.orchestrate", () => {
  it("path B success builds a provider artifact with ladderStep B", async () => {
    const deps = mkDeps();
    deps.providerRegistry.get = vi.fn((id: string) => {
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
    const r = await svc.orchestrate({
      parentThreadId: "t_parent",
      forkedFromMessageId: "m_1",
      forkAnchorRole: "user",
      childThreadId: "t_child",
      childProviderId: "claude",
    });
    expect(r.meta.ladderStep).toBe("B");
    expect(r.meta.generatedBy).toBe("provider");
  });

  it("path B quota failure falls directly to D, skipping A", async () => {
    const deps = mkDeps();
    deps.providerRegistry.get = vi.fn(() => ({
      sessionForkOnResume: "clean",
      maxInputCharactersPerTurn: 180_000,
      runSideChannelQuery: vi.fn(async () => {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }),
    }));
    const svc = HandoffPipelineService.forTesting(deps);
    const r = await svc.orchestrate({
      parentThreadId: "t_parent",
      forkedFromMessageId: "m_1",
      forkAnchorRole: "user",
      childThreadId: "t_child",
      childProviderId: "claude",
    });
    expect(r.meta.ladderStep).toBe("D");
    expect(r.meta.providerErrorOnGenerate).toBe("quota");
  });

  it("mutating-resume provider uses path A and minimal mode", async () => {
    const deps = mkDeps();
    deps.providerRegistry.get = vi.fn(() => ({
      sessionForkOnResume: "mutating",
      maxInputCharactersPerTurn: 4_000,
      runHiddenTurn: vi.fn(async () => "# Handoff\n\n## Goal\nX"),
    }));
    const svc = HandoffPipelineService.forTesting(deps);
    const r = await svc.orchestrate({
      parentThreadId: "t_parent",
      forkedFromMessageId: "m_1",
      forkAnchorRole: "user",
      childThreadId: "t_child",
      childProviderId: "cursor",
    });
    expect(r.meta.ladderStep).toBe("A");
    expect(r.meta.mode).toBe("minimal");
  });

  it("unsupported-resume provider skips to D with reason null", async () => {
    const deps = mkDeps();
    deps.providerRegistry.get = vi.fn(() => ({
      sessionForkOnResume: "unsupported",
      maxInputCharactersPerTurn: 16_000,
    }));
    const svc = HandoffPipelineService.forTesting(deps);
    const r = await svc.orchestrate({
      parentThreadId: "t_parent",
      forkedFromMessageId: "m_1",
      forkAnchorRole: "user",
      childThreadId: "t_child",
      childProviderId: "codex",
    });
    expect(r.meta.ladderStep).toBe("D");
    expect(r.meta.providerErrorOnGenerate).toBeNull();
  });
});
