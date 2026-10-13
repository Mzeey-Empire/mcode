import "reflect-metadata";
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequestBody, ApprovalRequestEnvelope, ApprovalRespondResult, ApprovalResponse } from "@mcode/contracts";
import { ApprovalService } from "../approval-service.js";
import { ApprovalNoteRepo } from "../approval-note-repo.js";
import { createThreadPersistenceTestRuntime } from "../../../thread-control/testing/thread-persistence-test-runtime.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../canonical/canonical-agent-writer-client.js";

const note = "Only lint the web app";
const response = { choiceId: "deny", note };
type Delivery = "native" | "steer" | "next_turn";

class Adapter extends NodeEvents.EventEmitter {
  readonly id = "codex";
  pending: ApprovalRequestEnvelope[] = [];
  calls = 0;
  answers: ApprovalResponse[] = [];
  delivered: string[] = [];
  result: ApprovalRespondResult;
  error = false;
  afterAcknowledgement = () => {};

  constructor(delivery: Delivery) {
    super();
    this.result = { status: "resolved", noteDelivery: delivery };
  }

  listPendingApprovals() { return this.pending; }

  async resolveApproval(_requestId: string, answer: ApprovalResponse): Promise<ApprovalRespondResult> {
    this.calls++;
    this.answers.push(answer);
    if (this.error) throw new Error("Provider connection lost");
    if (this.result.status === "resolved") {
      if (!("autoDeny" in answer) && answer.note && this.result.noteDelivery !== "next_turn") this.delivered.push(answer.note);
      this.pending = [];
      this.afterAcknowledgement();
    }
    return this.result;
  }
}

async function setup(delivery: Delivery = "next_turn") {
  const runtime = createThreadPersistenceTestRuntime();
  const workspace = await new WorkspaceRepo(runtime.reader, runtime.writer).create("Approval fixture", "/approval-fixture");
  const thread = await new ThreadRepo(runtime.reader, runtime.writer).create(workspace.id, "Approval", "direct", "main");
  const notes = new ApprovalNoteRepo(runtime.reader, runtime.writer);
  const adapter = new Adapter(delivery);
  const body: ApprovalRequestBody = { requestedAt: "2026-10-13T10:00:00Z", subject: { kind: "command", command: "bun run lint" },
    choices: [{ id: "allow", intent: "allow_once", label: "Allow once" }, { id: "deny", intent: "deny", label: "Deny" }],
    noteChoiceId: "deny", noteDelivery: delivery, origin: { kind: "agent" } };
  adapter.pending = [{ requestId: "request", threadId: thread.id, body }];
  const restart = async () => {
    const service = new ApprovalService({ resolveAll: () => [adapter] }, notes);
    await service.start({ publishApprovalRequest() {}, publishApprovalResolved() {}, async stopSession() {} });
    return service;
  };
  const service = await restart();
  const canonical = new CanonicalAgentBoundary(runtime.reader, runtime.writer, new CanonicalAgentWriterClient(runtime.writer), () => {});
  const admit = (targetThreadId = thread.id, existingMessageId?: string) => canonical.startParentTurn({
    thread: { id: targetThreadId, workspaceId: workspace.id, providerId: "codex", createdAt: "2026-10-13T10:00:00Z" },
    turnId: NodeCrypto.randomUUID(), executionId: NodeCrypto.randomUUID(), permissionMode: "supervised", providerIdentities: [],
    approvalNoteRequestId: "request",
    userMessage: existingMessageId ? { kind: "existing", messageId: existingMessageId }
      : { kind: "create", messageId: NodeCrypto.randomUUID(), content: note, sequence: 1 },
  });
  const crashBeforeRecording = () => vi.spyOn(notes, "settle").mockRejectedValueOnce(new Error("Server exited before recording the answer"));
  return { ...runtime, notes, adapter, thread, service, restart, admit, crashBeforeRecording };
}

describe("durable approval notes", () => {
  it.each<Delivery>(["native", "steer", "next_turn"])("replays a lost %s response without delivering again", async (delivery) => {
    const test = await setup(delivery);
    await test.service.respondToApproval("request", response);
    expect(await test.service.respondToApproval("request", response)).toEqual({ status: "resolved", noteDelivery: delivery });
    expect(test.adapter.calls).toBe(1);
    expect(test.adapter.delivered).toEqual(delivery === "next_turn" ? [] : [note]);
    expect(test.notes.find("request")).toMatchObject({ threadId: test.thread.id, state: delivery === "next_turn" ? "queued" : "delivered" });
    expect(await test.service.respondToApproval("request", { ...response, note: "Do something else" }))
      .toEqual({ status: "failed", message: "This request was already answered" });
  });

  it("coalesces duplicate responds before the adapter is called", async () => {
    const test = await setup("native");
    expect(await Promise.all([test.service.respondToApproval("request", response), test.service.respondToApproval("request", response)]))
      .toEqual([{ status: "resolved", noteDelivery: "native" }, { status: "resolved", noteDelivery: "native" }]);
    expect(test.adapter.calls).toBe(1);
    expect(test.adapter.delivered).toEqual([note]);
  });

  it("retains a failed attempt and delivers once when the pending request is retried", async () => {
    const test = await setup("native");
    test.adapter.error = true;
    expect(await test.service.respondToApproval("request", response)).toMatchObject({ status: "failed" });
    expect(test.notes.find("request")?.state).toBe("pending");
    expect(test.adapter.delivered).toEqual([]);
    test.adapter.error = false;
    expect(await test.service.respondToApproval("request", response)).toEqual({ status: "resolved", noteDelivery: "native" });
    expect(test.adapter.delivered).toEqual([note]);
    expect(test.notes.find("request")?.state).toBe("delivered");
  });

  it("lets Allow replace a note whose adapter call failed", async () => {
    const test = await setup("native");
    test.adapter.error = true;
    await test.service.respondToApproval("request", response);
    test.adapter.error = false;
    expect(await test.service.respondToApproval("request", { choiceId: "allow" })).toEqual({ status: "resolved", noteDelivery: "native" });
    expect(test.adapter.answers.at(-1)).toEqual({ choiceId: "allow" });
    expect(test.adapter.delivered).toEqual([]);
    expect(test.notes.find("request")).toBeNull();
  });

  it("delivers a different note after the first note's adapter call failed", async () => {
    const test = await setup("native");
    test.adapter.error = true;
    await test.service.respondToApproval("request", response);
    test.adapter.error = false;
    const edited = "Only lint the server";
    expect(await test.service.respondToApproval("request", { choiceId: "deny", note: edited })).toEqual({ status: "resolved", noteDelivery: "native" });
    expect(test.adapter.delivered).toEqual([edited]);
    expect(test.notes.find("request")).toMatchObject({ note: edited, state: "delivered" });
  });

  it("forgets the oldest replayable answer once 1,000 newer answers are held", async () => {
    const test = await setup("native");
    const [request] = test.adapter.pending;
    const answer = async (requestId: string) => {
      test.adapter.pending = [{ ...request, requestId }];
      return test.service.respondToApproval(requestId, { choiceId: "allow" });
    };
    for (let index = 0; index < 1_000; index++) await answer(`request-${index}`);
    expect(await test.service.respondToApproval("request-0", { choiceId: "allow" })).toEqual({ status: "resolved", noteDelivery: "native" });
    await answer("request-1000");
    expect(await test.service.respondToApproval("request-0", { choiceId: "allow" })).toEqual({ status: "not_pending" });
    expect(await test.service.respondToApproval("request-1", { choiceId: "allow" })).toEqual({ status: "resolved", noteDelivery: "native" });
  });

  it.each<Delivery>(["native", "steer", "next_turn"])("recovers a failed %s attempt when the adapter answers not_pending", async (delivery) => {
    const test = await setup(delivery);
    test.adapter.error = true;
    await test.service.respondToApproval("request", response);
    test.adapter.error = false;
    test.adapter.result = { status: "not_pending" };
    const state = delivery === "next_turn" ? "queued" : "delivery_unknown";
    expect(await Promise.all([
      test.service.respondToApproval("request", response), test.service.respondToApproval("request", response),
    ])).toEqual([{ status: "not_pending", note: state }, { status: "not_pending", note: state }]);
    expect(await test.service.listNotes()).toEqual([{ requestId: "request", threadId: test.thread.id, note, state }]);
    expect(test.adapter.delivered).toEqual([]);
  });

  it.each<Delivery>(["native", "steer", "next_turn"])("recovers a crash after %s acknowledgement and before the status write", async (delivery) => {
    const test = await setup(delivery);
    test.adapter.afterAcknowledgement = () => {
      expect(test.notes.find("request")).toMatchObject({ note, threadId: test.thread.id, delivery, state: "pending" });
    };
    test.crashBeforeRecording();
    await expect(test.service.respondToApproval("request", response)).rejects.toThrow();
    expect(test.notes.find("request")?.state).toBe("pending");
    expect(test.adapter.delivered).toEqual(delivery === "next_turn" ? [] : [note]);
    const restarted = await test.restart();
    const state = delivery === "next_turn" ? "queued" : "delivery_unknown";
    expect(await restarted.listNotes()).toEqual([{ requestId: "request", threadId: test.thread.id, note, state }]);
    expect(await restarted.respondToApproval("request", response)).toEqual(delivery === "next_turn"
      ? { status: "resolved", noteDelivery: "next_turn" } : { status: "not_pending", note: "delivery_unknown" });
    expect(test.adapter.calls).toBe(1);
  });

  it("records an acknowledged note when shutdown begins during the adapter call", async () => {
    const test = await setup("native");
    test.adapter.afterAcknowledgement = () => test.service.blockNewResponses();
    expect(await test.service.respondToApproval("request", response)).toEqual({ status: "resolved", noteDelivery: "native" });
    expect(test.notes.find("request")?.state).toBe("delivered");
    await expect(test.service.respondToApproval("request", response)).rejects.toThrow("ApprovalService is shutting down");
    const restarted = await test.restart();
    expect(await restarted.listNotes()).toEqual([]);
    expect(test.adapter.delivered).toEqual([note]);
  });

  it("holds an unanswered steer and replays its unknown result during this service run", async () => {
    const test = await setup("steer");
    test.adapter.result = { status: "resolved", noteDelivery: "unknown" };
    await test.service.respondToApproval("request", response);
    expect(await test.service.respondToApproval("request", response)).toEqual({ status: "resolved", noteDelivery: "unknown" });
    expect(test.notes.find("request")?.state).toBe("delivery_unknown");
    await expect(test.admit()).rejects.toMatchObject({ code: "note_already_delivered" });
    expect(test.reader.query("SELECT content FROM messages WHERE role = 'user'").all()).toEqual([]);
  });

  it("admits one message after Send again in two windows and rejects the second claim", async () => {
    const test = await setup("native");
    test.crashBeforeRecording();
    await expect(test.service.respondToApproval("request", response)).rejects.toThrow();
    const service = await test.restart();
    expect(await Promise.all([service.resendNote("request"), service.resendNote("request")])).toEqual([{ status: "queued" }, { status: "queued" }]);
    const claims = await Promise.allSettled([test.admit(), test.admit()]);
    expect(claims.map((claim) => claim.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejection = claims.find((claim) => claim.status === "rejected");
    expect(rejection).toMatchObject({ reason: { code: "note_already_delivered" } });
    expect(test.reader.query("SELECT content FROM messages WHERE role = 'user'").all()).toEqual([{ content: note }]);
    expect(await service.resendNote("request")).toEqual({ status: "closed" });
    expect(await service.removeNote("request")).toEqual({ status: "closed" });
  });

  it("rolls back a note claim with a failed user-message projection and rejects another thread", async () => {
    const test = await setup();
    await test.service.respondToApproval("request", response);
    await expect(test.admit("other-thread")).rejects.toMatchObject({ code: "note_already_delivered" });
    await expect(test.admit(test.thread.id, "missing-message")).rejects.toThrow();
    expect(test.notes.find("request")?.state).toBe("queued");
    await expect(test.admit()).resolves.toMatchObject({ outcome: "committed" });
    expect(await test.service.listNotes()).toEqual([]);
  });

  it("returns the closed-note error before a second caller can reserve the still-running thread", async () => {
    const test = await setup();
    await test.service.respondToApproval("request", response);
    let active = false;
    const admit = async () => {
      if (active) throw new Error("Thread already has an active agent session");
      active = true;
      await test.admit();
    };
    const claims = await Promise.allSettled([
      test.service.admitNote("request", test.thread.id, admit),
      test.service.admitNote("request", test.thread.id, admit),
    ]);
    expect(claims[0].status).toBe("fulfilled");
    expect(claims[1]).toMatchObject({ status: "rejected", reason: { code: "note_already_delivered" } });
    expect(test.reader.query("SELECT content FROM messages WHERE role = 'user'").all()).toEqual([{ content: note }]);
  });

  it.each(["next_turn", "unknown"] as const)("restores edits and tombstones removed %s notes", async (delivery) => {
    const test = await setup();
    test.adapter.result = { status: "resolved", noteDelivery: delivery };
    await test.service.respondToApproval("request", response);
    expect(await test.service.updateNote("request", "Only run web tests")).toEqual({ status: "updated" });
    test.service.blockNewResponses();
    const restarted = await test.restart();
    expect(await restarted.listNotes()).toEqual([{ requestId: "request", threadId: test.thread.id, note: "Only run web tests",
      state: delivery === "next_turn" ? "queued" : "delivery_unknown" }]);
    expect(await restarted.removeNote("request")).toEqual({ status: "removed" });
    expect(test.notes.find("request")?.state).toBe("removed");
    expect(await (await test.restart()).listNotes()).toEqual([]);
    expect(await restarted.updateNote("request", "Changed again")).toEqual({ status: "closed" });
    await expect(test.admit()).rejects.toMatchObject({ code: "note_already_delivered" });
  });

  it.each([{ choiceId: "allow", note }, { choiceId: "deny", note: "  " }])("rejects invalid note responses before recording intent", async (answer) => {
    const test = await setup();
    expect(await test.service.respondToApproval("request", answer)).toMatchObject({ status: "failed" });
    expect(test.notes.find("request")).toBeNull();
    expect(test.adapter.calls).toBe(0);
  });
});
