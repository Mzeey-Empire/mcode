import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

/**
 * We isolate the serverRequest routing by extracting the pure logic into a
 * helper exported from codex-app-server.ts. Spawning the real subprocess
 * is overkill for this unit; the integration is covered by manual UI testing.
 */
import type { CodexApprovalRequest } from "../../private/codex/codex-app-server.js";
import { routeCodexServerRequest } from "../../private/codex/codex-app-server.js";
import { CodexPlanQuestions } from "../../private/codex/codex-plan-questions.js";
import { logger } from "@mcode/shared";
import type { NativePlanQuestionBatch, PlanQuestionSettlement } from "@mcode/contracts";

const questionParams = {
  threadId: "native-thread", turnId: "native-turn", itemId: "item",
  questions: [{ id: "tone", header: "Tone", question: "Which greeting?", isOther: true, isSecret: false,
    options: [{ label: "Brief", description: "One sentence" }, { label: "Detailed", description: "A paragraph" }] }],
};

function questionFixture(settlementGate?: Promise<void>) {
  const questions = new CodexPlanQuestions();
  const batches: NativePlanQuestionBatch[] = [];
  const settlements: PlanQuestionSettlement[] = [];
  const sendResponse = vi.fn(async (_id: number, _response: unknown) => {});
  const cancelRequest = vi.fn(async (_id: number) => {});
  questions.bind({ requested: async batch => { batches.push(batch); },
    settled: async (_batch, status) => { await settlementGate; settlements.push(status); } });
  const request = (params: unknown) => routeCodexServerRequest({
    msg: { id: 90, method: "item/tool/requestUserInput", params }, approvalPolicy: "never",
    approvalHandler: undefined, sendResponse, cancelRequest,
    questionHandler: pending => questions.request("session", "thread", "native-thread", "native-turn", pending),
  });
  return { questions, batches, settlements, sendResponse, cancelRequest, request };
}

describe("native questions beside approval requests", () => {
  it.each(["answer", "dismiss"])("keeps a concurrent %s from expiring an answer awaiting its durable receipt", async action => {
    const receipt = Promise.withResolvers<void>();
    const f = questionFixture(receipt.promise);
    await f.request(questionParams);
    const batch = f.batches[0]!;
    const answers = [{ questionId: batch.questions[0]!.id, selectedOptionId: "0", freeText: null }];
    const first = f.questions.answer("thread", batch.requestId, answers);
    try {
      await vi.waitFor(() => expect(f.sendResponse.mock.calls).toEqual([[90, { answers: { tone: { answers: ["Brief"] } } }]]));
      await expect(f.questions.answer("thread", batch.requestId, action === "answer" ? answers : "dismiss"))
        .rejects.toBeInstanceOf(Error);
      expect(f.settlements).toEqual([]);
    } finally { receipt.resolve(); await first; }
    expect(f.settlements).toEqual(["answered"]);
  });

  it.each(["answer", "dismiss"])("keeps the first answer's settlement when a concurrent %s arrives", async action => {
    const f = questionFixture();
    const write = Promise.withResolvers<void>();
    f.sendResponse.mockImplementation(() => write.promise);
    await f.request(questionParams);
    const batch = f.batches[0]!;
    const answers = [{ questionId: batch.questions[0]!.id, selectedOptionId: "0", freeText: null }];
    const first = f.questions.answer("thread", batch.requestId, answers);
    try {
      await expect(f.questions.answer("thread", batch.requestId, action === "answer" ? answers : "dismiss"))
        .rejects.toBeInstanceOf(Error);
      expect(f.settlements).toEqual([]);
    } finally { write.resolve(); await first; }
    expect(f.settlements).toEqual(["answered"]);
    expect(f.sendResponse.mock.calls).toEqual([[90, { answers: { tone: { answers: ["Brief"] } } }]]);
  });

  it("cancels secret questions without publishing or logging their text", async () => {
    const f = questionFixture();
    vi.mocked(logger.warn).mockClear();
    await f.request({ ...questionParams, questions: questionParams.questions.map(question => ({ ...question, isSecret: true })) });
    expect(f.cancelRequest.mock.calls).toEqual([[90]]);
    expect(f.batches).toEqual([]);
    expect(f.sendResponse.mock.calls).toEqual([]);
    expect(vi.mocked(logger.warn).mock.calls).toEqual([["Codex secret questions are unsupported"]]);
  });

  it("logs only validation paths and cancels a question without the required options", async () => {
    const f = questionFixture();
    vi.mocked(logger.warn).mockClear();
    await f.request({ ...questionParams, questions: questionParams.questions.map(question => ({ ...question, options: [] })) });
    expect(f.cancelRequest.mock.calls).toEqual([[90]]);
    expect(f.batches).toEqual([]);
    expect(f.sendResponse.mock.calls).toEqual([]);
    expect(vi.mocked(logger.warn).mock.calls).toEqual([
      ["Codex question request failed validation", { paths: [["questions", 0, "options"]] }],
    ]);
  });
});

describe("routeCodexServerRequest", () => {
  let sendResponse: Mock<(id: number, result: unknown) => void>;

  beforeEach(() => {
    sendResponse = vi.fn<(id: number, result: unknown) => void>();
  });

  it("auto-approves v2 methods when approvalPolicy is 'never'", async () => {
    await routeCodexServerRequest({
      msg: { id: 1, method: "item/commandExecution/requestApproval", params: {} },
      approvalPolicy: "never",
      approvalHandler: undefined,
      sendResponse,
    });
    expect(sendResponse).toHaveBeenCalledWith(1, { decision: "acceptForSession" });
  });

  it("auto-approves permissions method with full access when policy is 'never'", async () => {
    await routeCodexServerRequest({
      msg: { id: 2, method: "item/permissions/requestApproval", params: {} },
      approvalPolicy: "never",
      approvalHandler: undefined,
      sendResponse,
    });
    expect(sendResponse).toHaveBeenCalledWith(2, {
      permissions: {
        fileSystem: { read: [], write: [] },
        network: { enabled: true },
      },
      scope: "session",
    });
  });

  it("auto-approves legacy methods with approved_for_session when policy is 'never'", async () => {
    await routeCodexServerRequest({
      msg: { id: 3, method: "applyPatchApproval", params: {} },
      approvalPolicy: "never",
      approvalHandler: undefined,
      sendResponse,
    });
    expect(sendResponse).toHaveBeenCalledWith(3, { decision: "approved_for_session" });
  });

  it("auto-denies in supervised mode when no handler is set", async () => {
    await routeCodexServerRequest({
      msg: { id: 4, method: "item/commandExecution/requestApproval", params: {} },
      approvalPolicy: "on-request",
      approvalHandler: undefined,
      sendResponse,
    });
    expect(sendResponse).toHaveBeenCalledWith(4, { decision: "decline" });
  });

  it("auto-denies legacy methods in supervised mode with 'denied'", async () => {
    await routeCodexServerRequest({
      msg: { id: 5, method: "applyPatchApproval", params: {} },
      approvalPolicy: "on-request",
      approvalHandler: undefined,
      sendResponse,
    });
    expect(sendResponse).toHaveBeenCalledWith(5, { decision: "denied" });
  });

  it("waits for the response write before acknowledging delivery", async () => {
    const write = Promise.withResolvers<void>();
    const acknowledge = vi.fn();
    const task = routeCodexServerRequest({
      msg: { id: 42, method: "item/commandExecution/requestApproval", params: { command: "bun run lint" } },
      approvalPolicy: "on-request",
      approvalHandler: async (request: CodexApprovalRequest) => {
        request.responseWritten = acknowledge;
        return { decision: "decline" };
      },
      sendResponse: () => write.promise,
    });
    await Promise.resolve();
    expect(acknowledge.mock.calls).toEqual([]);
    write.resolve();
    await task;
    expect(acknowledge.mock.calls).toEqual([[true]]);
  });

  it("invokes the handler in supervised mode and relays its result", async () => {
    const handler = vi.fn().mockResolvedValue({ decision: "accept" });
    await routeCodexServerRequest({
      msg: { id: 6, method: "item/commandExecution/requestApproval", params: { command: "ls" } },
      approvalPolicy: "on-request",
      approvalHandler: handler,
      sendResponse,
    });
    expect(handler).toHaveBeenCalledWith({
      rpcId: 6,
      method: "item/commandExecution/requestApproval",
      params: { command: "ls" },
    });
    expect(sendResponse).toHaveBeenCalledWith(6, { decision: "accept" });
  });

  it("falls back to mapped safe-deny when the handler rejects", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    await routeCodexServerRequest({
      msg: { id: 7, method: "item/commandExecution/requestApproval", params: {} },
      approvalPolicy: "on-request",
      approvalHandler: handler,
      sendResponse,
    });
    expect(sendResponse).toHaveBeenCalledWith(7, { decision: "decline" });
  });

  it("falls back to mapped safe-deny for permissions method when handler rejects", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    await routeCodexServerRequest({
      msg: { id: 8, method: "item/permissions/requestApproval", params: { permissions: {} } },
      approvalPolicy: "on-request",
      approvalHandler: handler,
      sendResponse,
    });
    expect(sendResponse).toHaveBeenCalledWith(8, { permissions: {}, scope: "turn" });
  });

  it("ignores messages without a numeric id", async () => {
    await routeCodexServerRequest({
      msg: { method: "item/commandExecution/requestApproval", params: {} },
      approvalPolicy: "on-request",
      approvalHandler: undefined,
      sendResponse,
    });
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
