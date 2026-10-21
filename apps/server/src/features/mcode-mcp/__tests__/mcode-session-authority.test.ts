import { describe, expect, it } from "vitest";
import {
  constantTimeCredentialEqual,
  McodeSessionAuthority,
  McodeThreadControlDeniedError,
} from "../mcode-session-authority.js";

const attachRequest = (overrides: Partial<Parameters<McodeSessionAuthority["attach"]>[0]> = {}) => ({
  providerId: "claude",
  sessionId: "mcode-source",
  threadId: "source",
  threadControl: true,
  ...overrides,
});

const turn = (overrides: Partial<Parameters<McodeSessionAuthority["activate"]>[0]> = {}) => ({
  sessionId: "mcode-source",
  sourceThreadId: "source",
  sourceTurnId: "turn-one",
  sourceProviderId: "claude",
  permissionMode: "supervised" as const,
  ...overrides,
});

const session = { providerId: "claude", sessionId: "mcode-source", threadId: "source", threadControl: true };

describe("McodeSessionAuthority", () => {
  it("keeps one opaque credential per session while rotating its active turn lease", () => {
    const authority = new McodeSessionAuthority();

    const first = authority.activate(turn());
    const retry = authority.activate(turn());
    const nextTurn = authority.activate(turn({ sourceTurnId: "turn-two", permissionMode: "full" }));

    expect(retry.credential).toBe(first.credential);
    expect(nextTurn.credential).toBe(first.credential);
    expect(authority.authorizeThreadControl(session, "call-1")).toMatchObject({
      type: "internal",
      userId: "local-user",
      sourceTurnId: "turn-two",
      sourceToolCallId: "call-1",
      permissionMode: "full",
    });
  });

  it("fails closed after revocation and aborts the lease signal", () => {
    const authority = new McodeSessionAuthority();
    authority.activate(turn({ sourceProviderId: "codex" }));
    const signal = authority.signal("mcode-source")!;

    authority.revoke("mcode-source");

    expect(signal.aborted).toBe(true);
    expect(() => authority.authorizeThreadControl(session, "call-1")).toThrow(McodeThreadControlDeniedError);
    expect(authority.signal("mcode-source")).toBeUndefined();
  });

  it("rejects unequal credential lengths before constant-time comparison", () => {
    expect(constantTimeCredentialEqual("credential", "credential")).toBe(true);
    expect(constantTimeCredentialEqual("credential", "credential-extra")).toBe(false);
  });

  it("creates the entry when a turn is activated before attach and keeps one token", () => {
    const authority = new McodeSessionAuthority();
    const lease = authority.activate(turn());

    expect(authority.resolve(lease.credential)).toBeNull();
    const attached = authority.attach(attachRequest());

    expect(attached.token).toBe(lease.credential);
    expect(authority.resolve(attached.token)).toEqual({
      providerId: "claude",
      sessionId: "mcode-source",
      threadId: "source",
      threadControl: true,
    });
  });

  it("returns the same token for a repeated attach and updates the listing flag", () => {
    const authority = new McodeSessionAuthority();
    const first = authority.attach(attachRequest({ threadControl: false }));
    const second = authority.attach(attachRequest({ threadControl: true }));

    expect(second.token).toBe(first.token);
    expect(authority.resolve(first.token)?.threadControl).toBe(true);
    expect(authority.attach(attachRequest({ sessionId: "mcode-other" })).token).not.toBe(first.token);
  });

  it("rotates the token on retire while a turn is active, so the old token stops resolving", () => {
    const authority = new McodeSessionAuthority();
    const { token } = authority.attach(attachRequest());
    authority.activate(turn());

    authority.retire("mcode-source");

    expect(authority.resolve(token)).toBeNull();
    const reattached = authority.attach(attachRequest());
    expect(reattached.token).not.toBe(token);
    expect(authority.authorizeThreadControl(authority.resolve(reattached.token)!, "call")).toMatchObject({
      sourceTurnId: "turn-one",
    });
  });

  it("closes the session on retire when no turn is active", () => {
    const authority = new McodeSessionAuthority();
    const { token } = authority.attach(attachRequest());

    authority.retire("mcode-source");

    expect(authority.resolve(token)).toBeNull();
    expect(authority.attach(attachRequest()).token).not.toBe(token);
  });

  it("does not let a late turn revive a session that retired without one", () => {
    const authority = new McodeSessionAuthority();
    authority.attach(attachRequest());
    authority.retire("mcode-source");

    const { credential } = authority.activate(turn());

    expect(authority.resolve(credential)).toBeNull();
  });

  it("aborts the previous turn's signal when a new turn activates", () => {
    const authority = new McodeSessionAuthority();
    authority.activate(turn());
    const previous = authority.signal("mcode-source");

    authority.activate(turn({ sourceTurnId: "turn-two" }));

    expect(previous?.aborted).toBe(true);
    expect(authority.signal("mcode-source")?.aborted).toBe(false);
  });

  it("refuses thread control without an active lease and bounds the tool call id", () => {
    const authority = new McodeSessionAuthority();
    const { token } = authority.attach(attachRequest());
    const session = authority.resolve(token)!;

    expect(() => authority.authorizeThreadControl(session, "call"))
      .toThrow(expect.objectContaining({ reason: "no_active_turn" }));
    authority.activate(turn());
    expect(authority.authorizeThreadControl(session, "call")).toMatchObject({ sourceThreadId: "source" });
    expect(() => authority.authorizeThreadControl(session, ""))
      .toThrow(expect.objectContaining({ reason: "invalid_tool_call" }));
    expect(() => authority.authorizeThreadControl(session, "x".repeat(129)))
      .toThrow(expect.objectContaining({ reason: "invalid_tool_call" }));
  });

  it("scopes thread-control authority to the resolving session", () => {
    const authority = new McodeSessionAuthority();
    const a = authority.attach(attachRequest({ sessionId: "mcode-a", threadId: "a" }));
    authority.attach(attachRequest({ sessionId: "mcode-b", threadId: "b" }));
    authority.activate(turn({ sessionId: "mcode-a", sourceThreadId: "a" }));
    authority.activate(turn({ sessionId: "mcode-b", sourceThreadId: "b" }));

    expect(authority.authorizeThreadControl(authority.resolve(a.token)!, "call").sourceThreadId).toBe("a");
  });
});
