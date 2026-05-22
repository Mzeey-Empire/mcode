import { describe, expect, it } from "vitest";
import { runPathDDeterministic } from "../path-d-deterministic.js";
import type { Thread, Message } from "@mcode/contracts";

const parent = {
  id: "t_parent",
  workspace_id: "w_1",
  title: "DB migration",
  branch: "main",
  provider: "claude",
  model: "claude-opus-4-7",
  status: "active",
  worktree_path: null,
  worktree_managed: true,
  sdk_session_id: null,
} as unknown as Thread;

const messages: Message[] = [
  {
    id: "m_1",
    thread_id: "t_parent",
    role: "user",
    content: "Should we use Postgres?",
    sequence: 1,
  } as unknown as Message,
  {
    id: "m_2",
    thread_id: "t_parent",
    role: "assistant",
    content: "Yes because...",
    sequence: 2,
  } as unknown as Message,
];

describe("runPathDDeterministic", () => {
  it("produces a HandoffArtifact with ladderStep D + generatedBy deterministic", async () => {
    const a = await runPathDDeterministic({
      parentThread: parent,
      messagesUpToFork: messages,
      forkedFromMessageId: "m_2",
      forkAnchorRole: "assistant",
      childThreadId: "t_child",
      reason: "quota",
    });
    expect(a.meta.ladderStep).toBe("D");
    expect(a.meta.generatedBy).toBe("deterministic");
    expect(a.meta.providerErrorOnGenerate).toBe("quota");
    expect(a.markdown.length).toBeGreaterThan(0);
  });

  it("characterCount matches markdown length", async () => {
    const a = await runPathDDeterministic({
      parentThread: parent,
      messagesUpToFork: messages,
      forkedFromMessageId: "m_2",
      forkAnchorRole: "assistant",
      childThreadId: "t_child",
      reason: null,
    });
    expect(a.meta.characterCount).toBe(a.markdown.length);
  });
});
