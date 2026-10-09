import * as NodeEvents from "node:events";
import { logger } from "@mcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishAgentPermissionEvents } from "../permission-publication.js";

function buildPublication() {
  const events = new NodeEvents.EventEmitter();
  const resolvePermission = vi.fn(() => true);
  const publishPermissionRequest = vi.fn();
  const publishPermissionResolved = vi.fn();
  const stopSession = vi.fn(async (_threadId: string) => undefined);
  publishAgentPermissionEvents({
    providerRegistry: { resolveAll: () => [{ id: "claude", on: events.on.bind(events), resolvePermission }] },
    publishPermissionRequest,
    publishPermissionResolved,
    stopSession,
  });
  return { events, resolvePermission, publishPermissionRequest, publishPermissionResolved, stopSession };
}

const unreadableRequest = {
  requestId: "request-1",
  threadId: "thread-1",
  toolName: "private-tool",
  title: "private-title",
  input: { command: "private-command" },
  operation: "sk-secret-12345",
};

afterEach(() => vi.restoreAllMocks());

describe("agent permission publication", () => {
  it("publishes validated provider permission lifecycle events", () => {
    const publication = buildPublication();

    publication.events.emit("permission_request", {
      requestId: "request-1",
      threadId: "thread-1",
      toolName: "Bash",
      input: { command: "bun test" },
    });
    publication.events.emit("permission_resolved", { requestId: "request-1", decision: "allow" });

    expect(publication.publishPermissionRequest).toHaveBeenCalledWith({
      requestId: "request-1",
      threadId: "thread-1",
      toolName: "Bash",
      input: { command: "bun test" },
    });
    expect(publication.publishPermissionResolved).toHaveBeenCalledWith({
      requestId: "request-1",
      decision: "allow",
    });
  });

  it("publishes an unreadable stand-in before denying upstream and publishing the denial", () => {
    const publication = buildPublication();
    publication.events.emit("permission_request", unreadableRequest);

    expect(publication.publishPermissionRequest.mock.calls).toEqual([[{
      requestId: "request-1", threadId: "thread-1", toolName: "Unreadable request",
      title: "Mcode couldn't read this request", input: {},
    }]]);
    expect(publication.resolvePermission.mock.calls).toEqual([["request-1", "deny"]]);
    expect(publication.publishPermissionResolved.mock.calls).toEqual([[{ requestId: "request-1", decision: "deny" }]]);
    expect(publication.publishPermissionRequest).toHaveBeenCalledBefore(publication.resolvePermission);
    expect(publication.resolvePermission).toHaveBeenCalledBefore(publication.publishPermissionResolved);
    expect(publication.stopSession).not.toHaveBeenCalled();
  });

  it.each(["returns false", "throws"])("cancels and stops the thread when denying %s", (failure) => {
    const publication = buildPublication();
    publication.resolvePermission.mockImplementation(() => {
      if (failure === "throws") throw new Error("sk-secret-12345");
      return false;
    });
    publication.events.emit("permission_request", unreadableRequest);

    expect(publication.resolvePermission.mock.calls).toEqual([["request-1", "deny"]]);
    expect(publication.publishPermissionResolved.mock.calls).toEqual([[{ requestId: "request-1", decision: "cancelled" }]]);
    expect(publication.stopSession.mock.calls).toEqual([["thread-1"]]);
    expect(publication.publishPermissionRequest).toHaveBeenCalledBefore(publication.resolvePermission);
    expect(publication.resolvePermission).toHaveBeenCalledBefore(publication.publishPermissionResolved);
    expect(publication.publishPermissionResolved).toHaveBeenCalledBefore(publication.stopSession);
  });

  it("handles and logs a rejected session stop without exposing the error", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const publication = buildPublication();
    publication.resolvePermission.mockReturnValue(false);
    publication.stopSession.mockRejectedValue(new Error("sk-secret-12345"));
    publication.events.emit("permission_request", unreadableRequest);
    await Promise.resolve();

    expect(error.mock.calls).toEqual([["Failed to stop session after unreadable permission request", {
      providerId: "claude", requestId: "request-1", threadId: "thread-1",
    }]]);
  });

  it("logs only provider, request id and schema issue paths and codes", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const publication = buildPublication();
    publication.events.emit("permission_request", unreadableRequest);

    expect(warn.mock.calls).toEqual([["Provider permission request violated its contract", {
      providerId: "claude", requestId: "request-1",
      issues: [{ path: ["operation"], code: "invalid_enum_value" }],
    }]]);
    for (const value of ["sk-secret-12345", "private-tool", "private-title", "private-command"]) {
      expect(JSON.stringify(warn.mock.calls)).not.toContain(value);
    }
  });

  it.each([
    null,
    { requestId: "request-1" },
    { requestId: "", threadId: "thread-1" },
    { requestId: "request-1", threadId: "" },
    { requestId: 42, threadId: "thread-1" },
    { requestId: "request-1", threadId: 42 },
  ])("logs invalid routing without publishing or answering: %j", (request) => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const publication = buildPublication();
    publication.events.emit("permission_request", request);

    expect(publication.publishPermissionRequest).not.toHaveBeenCalled();
    expect(publication.publishPermissionResolved).not.toHaveBeenCalled();
    expect(publication.resolvePermission).not.toHaveBeenCalled();
    expect(publication.stopSession).not.toHaveBeenCalled();
    expect(error.mock.calls).toEqual([["Provider permission request has invalid routing", { providerId: "claude" }]]);
  });

  it.each([
    { requestId: 42, decision: "allow" },
    { requestId: "request-1", decision: "unknown" },
  ])("does not publish malformed permission resolutions: %j", (payload) => {
    const publication = buildPublication();
    publication.events.emit("permission_resolved", payload);
    expect(publication.publishPermissionResolved).not.toHaveBeenCalled();
  });
});
