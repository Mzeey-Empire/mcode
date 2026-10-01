import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database } from "bun:sqlite";
import { createCursorProvider, type ProviderFactoryInput, type ProviderHostPorts } from "@mcode/providers";
import { SettingsSchema, type ForkRequest } from "@mcode/contracts";
import { openReadOnlyDatabase } from "../../../../runtime/persistence/sqlite/read-only-database.js";
import { createOwnedTestDatabase, type OwnedTestDatabase } from "../../../projects/testing/owned-test-database.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { MessageRepo } from "../../../agents/conversation/persistence/message-repo.js";
import type { Client } from "@agentclientprotocol/sdk";

/**
 * Slice 1 proof: forking a Cursor thread runs the handoff through the clean
 * side-channel (path B) and leaves the parent's canonical session untouched.
 */
describe("Cursor clean side-channel fork", () => {
  let db: Database;
  let owned: OwnedTestDatabase;
  let threadRepo: ThreadRepo;
  let messageRepo: MessageRepo;
  let provider: ReturnType<typeof createCursorProvider>;

  const SUMMARY = "Parent was fixing the auth middleware; tests added next.";

  beforeEach(() => {
    owned = createOwnedTestDatabase();
    db = openReadOnlyDatabase(owned.db.filename);
    threadRepo = new ThreadRepo(db, owned.writer);
    messageRepo = new MessageRepo(db, owned.writer);

    owned.db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run(
      "ws-1",
      "test",
      "/tmp/test",
    );

    const host: ProviderHostPorts = {
      runtime: { platform: "linux", architecture: "x64", nodeAbi: "127" },
      environment: { snapshot: () => ({}) },
      processes: { attach: () => undefined, terminateTree: async () => undefined },
      browser: {
        stage: () => ({ leaseId: "lease", expiresAt: Date.now() + 1_000 }),
        releaseSession: () => 0,
        isConfigured: () => false,
        issue: () => null,
        refresh: (leaseId) => ({ ok: false, leaseId, reason: "not-found" }),
        release: (leaseId) => ({ leaseId, released: false }),
        revokeCredential: () => false,
      },
      threadControl: { bootstrap: async () => null, close: async () => undefined },
      grants: { consume: () => false },
      events: { submit: async () => { throw new Error("The handoff side-channel must not publish runtime events"); } },
    };
    const input: ProviderFactoryInput = {
      configuration: { cliPath: "cursor-agent", idleSessionTtlMs: 30 * 60 * 1_000 },
      host,
      cursor: {
        settings: { get: () => SettingsSchema().parse({ provider: { cursor: { idleSessionTtlMinutes: 30 } } }) },
        skills: { list: () => [] },
      },
    };
    provider = createCursorProvider(input);
    expect(provider.id).toBe("cursor");

    // Replace the real `cursor-agent acp` spawn with a fake transport that
    // streams a summary chunk back through the client (no subprocess, no
    // events). `prompt` mimics the agent answering on the loaded session id.
    (provider as unknown as { sideChannel: { connector: unknown } }).sideChannel.connector = (args: {
      cwd: string;
      client: Client;
    }) => {
      let loadedSessionId = "";
      return Promise.resolve({
        loadSession: (a: { sessionId: string }) => {
          loadedSessionId = a.sessionId;
          return Promise.resolve({});
        },
        prompt: async () => {
          await args.client.sessionUpdate({
            sessionId: loadedSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: SUMMARY },
            },
          });
          return {};
        },
        dispose: () => {},
      });
    };
  });

  afterEach(async () => {
    await provider.shutdown();
    await owned.writer.barrier();
    db.close(true);
    await owned.close();
  });

  it("produces a path-B handoff without mutating the parent session", async () => {
    const parent = await threadRepo.create("ws-1", "Fix auth bug", "direct", "main", true, "cursor");
    await messageRepo.create(parent.id, "user", "Fix the auth bug", 1);
    await messageRepo.create(parent.id, "assistant", "Fixed the middleware.", 2);
    await threadRepo.updateSdkSessionId(parent.id, "cursor-parent-session");
    const seededParent = threadRepo.findById(parent.id)!;

    const child = await threadRepo.create("ws-1", "Branch: add tests", "direct", "main", true, "cursor", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-2",
    });

    const beforeRows = messageRepo.listIncludingInternal(parent.id);
    const beforeInternalCount = beforeRows.filter((m) => m.is_internal).length;
    const beforeMaxSequence = Math.max(...beforeRows.map((m) => m.sequence));

    const req: ForkRequest = {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-2",
      forkAnchorRole: "assistant",
      prompt: "Summarize the parent thread for handoff.",
      cwd: "/tmp/test",
      parentSdkSessionId: seededParent.sdk_session_id,
      conversationHistory: "user: Fix the auth bug\nassistant: Fixed the middleware.",
      messagesUpToFork: [],
      parentThread: seededParent,
      childThreadId: child.id,
    };

    const artifact = await provider.forker.fork(req);

    expect(artifact.markdown).toContain(SUMMARY);
    expect(artifact.markdown.length).toBeGreaterThan(0);
    expect(artifact.meta.ladderStep).toBe("B");
    expect(artifact.meta.generatedBy).toBe("provider");

    const afterRows = messageRepo.listIncludingInternal(parent.id);
    const afterInternalCount = afterRows.filter((m) => m.is_internal).length;
    const afterMaxSequence = Math.max(...afterRows.map((m) => m.sequence));

    expect(afterInternalCount).toBe(beforeInternalCount);
    expect(afterInternalCount).toBe(0);
    expect(afterRows).toHaveLength(beforeRows.length);
    expect(afterMaxSequence).toBe(beforeMaxSequence);
  });

  it("degrades to a transient error (path-D trigger) when the parent has no session", async () => {
    const parent = await threadRepo.create("ws-1", "No session", "direct", "main", true, "cursor");
    await messageRepo.create(parent.id, "user", "Do a thing", 1);
    const seededParent = threadRepo.findById(parent.id)!;
    const child = await threadRepo.create("ws-1", "child", "direct", "main", true, "cursor", {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-1",
    });

    const req: ForkRequest = {
      parentThreadId: parent.id,
      forkedFromMessageId: "msg-1",
      forkAnchorRole: "user",
      prompt: "Summarize.",
      cwd: "/tmp/test",
      parentSdkSessionId: null,
      messagesUpToFork: [],
      parentThread: seededParent,
      childThreadId: child.id,
    };

    await expect(provider.forker.fork(req)).rejects.toMatchObject({ code: "ETIMEDOUT" });
  });
});
