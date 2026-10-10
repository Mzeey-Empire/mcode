import { describe, expect, it } from "vitest";
import {
  mapApprovalChoiceToReply,
  synthesizeOpenCodeApprovalRequest,
  synthesizeOpenCodeQuestionRequest,
} from "../opencode-permission-mapper.js";

describe("mapApprovalChoiceToReply", () => {
  it("maps approve-once to once, session approval to always, and deny/cancel to reject", () => {
    expect(mapApprovalChoiceToReply("once")).toBe("once");
    expect(mapApprovalChoiceToReply("always")).toBe("always");
    expect(mapApprovalChoiceToReply("deny")).toBe("reject");
    expect(mapApprovalChoiceToReply("cancelled")).toBe("reject");
  });
});

describe("synthesizeOpenCodeApprovalRequest", () => {
  it("keeps all scope, the native tool id, and a complete always description", () => {
    const request = synthesizeOpenCodeApprovalRequest({ threadId: "owner", properties: { id: "per_1", action: "bash", resources: ["echo hi", "git status"], tool: { callID: "tool-1" } } });
    expect(request?.requestId).toBe("per_1");
    expect(request?.threadId).toBe("owner");
    expect(request?.body.toolCallId).toBe("tool-1");
    expect(request?.body.subject).toEqual({ kind: "tool", toolName: "bash", preview: '{"action":"bash","resources":["echo hi","git status"]}' });
    expect(request?.body.choices).toEqual([
      { id: "once", intent: "allow_once", label: "Allow once" },
      { id: "always", intent: "allow_scoped", label: "Allow for this session", description: "echo hi, git status" },
      { id: "reject", intent: "deny", label: "Deny" },
    ]);
  });

  it("omits only the scoped choice when its whole description does not fit", () => {
    const pattern = "x".repeat(501);
    const request = synthesizeOpenCodeApprovalRequest({ threadId: "owner", properties: { id: "per_1", action: "bash", resources: [pattern] } });
    expect(request?.body.choices).toEqual([
      { id: "once", intent: "allow_once", label: "Allow once" },
      { id: "reject", intent: "deny", label: "Deny" },
    ]);
    expect(request?.body.subject).toEqual({ kind: "tool", toolName: "bash", preview: '{"action":"bash","resources":["' + pattern + '"]}' });
  });

  it("omits an unstatable always choice and supports the legacy action field", () => {
    const request = synthesizeOpenCodeApprovalRequest({ threadId: "owner", properties: { id: "per_1", permission: "edit", metadata: { secret: true } } });
    expect(request?.body.subject).toEqual({ kind: "tool", toolName: "edit", preview: '{"action":"edit","resources":[]}' });
    expect(request?.body.choices.map((choice) => choice.id)).toEqual(["once", "reject"]);
  });

  it("preserves oversized authorization scope for automatic denial", () => {
    const action = "x".repeat(501);
    const resource = "y".repeat(70_000);
    const request = synthesizeOpenCodeApprovalRequest({ threadId: "owner", properties: { id: "per_1", action, resources: [resource] } });
    expect(request?.body.subject).toEqual({ kind: "tool", toolName: action, preview: '{"action":"' + action + '","resources":["' + resource + '"]}' });
  });

  it("retains a usable routing id even when display data is unreadable", () => {
    expect(synthesizeOpenCodeApprovalRequest({ threadId: "owner", properties: { id: "per_1" } })?.requestId).toBe("per_1");
    expect(synthesizeOpenCodeApprovalRequest({ threadId: "owner", properties: {} })).toBeNull();
    expect(synthesizeOpenCodeApprovalRequest({ threadId: "owner", properties: { id: "", action: "bash" } })).toBeNull();
    expect(synthesizeOpenCodeApprovalRequest({ threadId: "owner", properties: { id: "x".repeat(129), action: "bash" } })).toBeNull();
  });
});

describe("synthesizeOpenCodeQuestionRequest", () => {
  it("builds bounded canonical questions with exact reply labels", () => {
    const result = synthesizeOpenCodeQuestionRequest({
      threadId: "thread-1",
      properties: {
        id: "que_1",
        sessionID: "ses_1",
        questions: [{
          header: "Deploy",
          question: "Deploy now?",
          options: [
            { label: "Yes", description: "Ship it" },
            { label: "No", description: "Wait" },
          ],
          multiple: true,
          custom: true,
        }],
      },
    });
    expect(result?.requestId).toBe("que_1");
    expect(result?.threadId).toBe("thread-1");
    expect(result?.body.subject).toEqual({
      kind: "question",
      questions: [{
        header: "Deploy",
        question: "Deploy now?",
        options: [
          { label: "Yes", description: "Ship it" },
          { label: "No", description: "Wait" },
        ],
        multiple: true,
        custom: true,
      }],
    });
  });

  it("returns null without a usable id or questions", () => {
    expect(synthesizeOpenCodeQuestionRequest({ threadId: "t", properties: {} })).toBeNull();
    expect(synthesizeOpenCodeQuestionRequest({
      threadId: "t",
      properties: { id: "que_1", questions: [] },
    })).toBeNull();
    expect(synthesizeOpenCodeQuestionRequest({
      threadId: "t",
      properties: { id: "que_1", questions: [{ header: "H" }] },
    })).toBeNull();
  });

  it("rejects oversized request identities and reply labels instead of changing them", () => {
    expect(synthesizeOpenCodeQuestionRequest({
      threadId: "thread-1",
      properties: {
        id: `que_${"x".repeat(128)}`,
        questions: [{ header: "Deploy", question: "Deploy?", options: [{ label: "Yes" }] }],
      },
    })).toBeNull();
    expect(synthesizeOpenCodeQuestionRequest({
      threadId: "thread-1",
      properties: {
        id: "que_1",
        questions: [{
          header: "Deploy",
          question: "Deploy?",
          options: [{ label: `Y${"e".repeat(100)}` }],
        }],
      },
    })).toBeNull();
  });
});
