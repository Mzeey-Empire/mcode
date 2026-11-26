import { describe, expect, it } from "vitest";
import {
  mapApprovalChoiceToReply,
  synthesizeOpenCodeApprovalRequest,
  synthesizeOpenCodeQuestionRequest,
} from "../opencode-permission-mapper.js";

const AGENT = { kind: "agent" } as const;

describe("mapApprovalChoiceToReply", () => {
  it("maps approve-once to once, session approval to always, and deny/cancel to reject", () => {
    expect(mapApprovalChoiceToReply("once")).toBe("once");
    expect(mapApprovalChoiceToReply("always")).toBe("always");
    expect(mapApprovalChoiceToReply("deny")).toBe("reject");
    expect(mapApprovalChoiceToReply("cancelled")).toBe("reject");
  });
});

describe("synthesizeOpenCodeApprovalRequest", () => {
  it("shows an OpenCode 1.18 bash ask as its command and describes always by the granted patterns", () => {
    const request = synthesizeOpenCodeApprovalRequest({ threadId: "owner", origin: AGENT, properties: {
      id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["node math.js"], metadata: { command: "node math.js" },
      always: ["node *"], tool: { messageID: "msg_1", callID: "tool-1" },
    } });
    expect(request?.requestId).toBe("per_1");
    expect(request?.threadId).toBe("owner");
    expect(request?.body.toolCallId).toBe("tool-1");
    expect(request?.body.subject).toEqual({ kind: "command", command: "node math.js" });
    expect(request?.body.choices).toEqual([
      { id: "once", intent: "allow_once", label: "Allow once" },
      { id: "always", intent: "allow_scoped", label: "Always allow", description: "node *" },
      { id: "reject", intent: "deny", label: "Deny" },
    ]);
  });

  it("keeps all v2 scope and describes always by the saved list, not the requested resources", () => {
    const request = synthesizeOpenCodeApprovalRequest({ threadId: "owner", origin: AGENT, properties: { id: "per_1", action: "read", resources: ["src/a.ts", "src/b.ts"], save: ["src/*"] } });
    expect(request?.body.subject).toEqual({ kind: "tool", toolName: "read", preview: '{"action":"read","resources":["src/a.ts","src/b.ts"]}' });
    expect(request?.body.choices.find((choice) => choice.id === "always")?.description).toBe("src/*");
  });

  it("offers no always choice when the ask names nothing it would grant", () => {
    const request = synthesizeOpenCodeApprovalRequest({ threadId: "owner", origin: AGENT, properties: { id: "per_1", action: "bash", resources: ["echo hi"] } });
    expect(request?.body.choices.map((choice) => choice.id)).toEqual(["once", "reject"]);
  });

  it("omits only the scoped choice when its whole description does not fit", () => {
    const pattern = "x".repeat(501);
    const request = synthesizeOpenCodeApprovalRequest({ threadId: "owner", origin: AGENT, properties: { id: "per_1", action: "bash", resources: [pattern], save: [pattern] } });
    expect(request?.body.choices).toEqual([
      { id: "once", intent: "allow_once", label: "Allow once" },
      { id: "reject", intent: "deny", label: "Deny" },
    ]);
    expect(request?.body.subject).toEqual({ kind: "tool", toolName: "bash", preview: '{"action":"bash","resources":["' + pattern + '"]}' });
  });

  it("omits an unstatable always choice and supports the legacy action field", () => {
    const request = synthesizeOpenCodeApprovalRequest({ threadId: "owner", origin: AGENT, properties: { id: "per_1", permission: "edit", metadata: { secret: true } } });
    expect(request?.body.subject).toEqual({ kind: "tool", toolName: "edit", preview: '{"action":"edit","resources":[]}' });
    expect(request?.body.choices.map((choice) => choice.id)).toEqual(["once", "reject"]);
  });

  it("preserves oversized authorization scope for automatic denial", () => {
    const action = "x".repeat(501);
    const resource = "y".repeat(70_000);
    const request = synthesizeOpenCodeApprovalRequest({ threadId: "owner", origin: AGENT, properties: { id: "per_1", action, resources: [resource] } });
    expect(request?.body.subject).toEqual({ kind: "tool", toolName: action, preview: '{"action":"' + action + '","resources":["' + resource + '"]}' });
  });

  it("retains a usable routing id even when display data is unreadable", () => {
    expect(synthesizeOpenCodeApprovalRequest({ threadId: "owner", origin: AGENT, properties: { id: "per_1" } })?.requestId).toBe("per_1");
    expect(synthesizeOpenCodeApprovalRequest({ threadId: "owner", origin: AGENT, properties: {} })).toBeNull();
    expect(synthesizeOpenCodeApprovalRequest({ threadId: "owner", origin: AGENT, properties: { id: "", action: "bash" } })).toBeNull();
    expect(synthesizeOpenCodeApprovalRequest({ threadId: "owner", origin: AGENT, properties: { id: "x".repeat(129), action: "bash" } })).toBeNull();
  });
});

describe("synthesizeOpenCodeQuestionRequest", () => {
  it("builds bounded canonical questions with exact reply labels", () => {
    const result = synthesizeOpenCodeQuestionRequest({
      threadId: "thread-1",
      origin: AGENT,
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
    expect(synthesizeOpenCodeQuestionRequest({ threadId: "t", origin: AGENT, properties: {} })).toBeNull();
    expect(synthesizeOpenCodeQuestionRequest({
      threadId: "t",
      origin: AGENT,
      properties: { id: "que_1", questions: [] },
    })).toBeNull();
    expect(synthesizeOpenCodeQuestionRequest({
      threadId: "t",
      origin: AGENT,
      properties: { id: "que_1", questions: [{ header: "H" }] },
    })).toBeNull();
  });

  it("rejects oversized request identities and reply labels instead of changing them", () => {
    expect(synthesizeOpenCodeQuestionRequest({
      threadId: "thread-1",
      origin: AGENT,
      properties: {
        id: `que_${"x".repeat(128)}`,
        questions: [{ header: "Deploy", question: "Deploy?", options: [{ label: "Yes" }] }],
      },
    })).toBeNull();
    expect(synthesizeOpenCodeQuestionRequest({
      threadId: "thread-1",
      origin: AGENT,
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
