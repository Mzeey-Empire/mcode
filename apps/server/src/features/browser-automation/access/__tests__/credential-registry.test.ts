import { describe, expect, it } from "vitest";
import { BROWSER_AUTOMATION_OPERATIONS } from "@mcode/contracts/models/browser-automation";
import { BrowserAutomationCredentialRegistry } from "../credential-registry.js";

function scope(session = "provider-session") {
  return {
    providerId: "cursor",
    providerSessionId: session,
    mcodeSessionId: "mcode-session",
    threadId: "thread-a",
    workspaceId: "workspace-a",
    worktreeIdentity: "worktree-a",
    permissionCapability: "privileged" as const,
    allowedOperations: [...BROWSER_AUTOMATION_OPERATIONS],
  };
}

describe("BrowserAutomationCredentialRegistry", () => {
  it("touches the issued credential and preserves every scope boundary", () => {
    const registry = new BrowserAutomationCredentialRegistry();
    const issued = registry.issue(scope());

    expect(registry.touch("unknown-credential")).toBeNull();
    expect(registry.touch(issued.credentialId)).toMatchObject({
      credentialId: issued.credentialId,
      providerId: "cursor",
      providerSessionId: "provider-session",
      mcodeSessionId: "mcode-session",
      threadId: "thread-a",
      workspaceId: "workspace-a",
      worktreeIdentity: "worktree-a",
    });
  });

  it("rejects expired and revoked credentials", () => {
    let now = 100;
    const registry = new BrowserAutomationCredentialRegistry({
      idleTtlMs: 10,
      absoluteTtlMs: 100,
      now: () => now,
    });
    const revoked = registry.issue(scope("revoked"));
    const expired = registry.issue(scope("expired"));
    expect(registry.revoke(revoked.credentialId)).toBe(true);
    expect(registry.touch(revoked.credentialId)).toBeNull();
    now = 111;
    expect(registry.touch(expired.credentialId)).toBeNull();
    expect(registry.size()).toBe(0);
  });

  it("touches live credentials and revokes one provider session without crossing sessions", () => {
    let now = 1_000;
    const registry = new BrowserAutomationCredentialRegistry({
      idleTtlMs: 100,
      absoluteTtlMs: 1_000,
      now: () => now,
    });
    const first = registry.issue(scope("first"));
    const second = registry.issue(scope("second"));
    now = 1_050;
    expect(registry.touch(first.credentialId)).toMatchObject({ credentialId: first.credentialId, providerSessionId: "first" });
    expect(registry.revokeProviderSession("cursor", "second")).toBe(1);
    expect(registry.touch(second.credentialId)).toBeNull();
    now = 1_101;
    expect(registry.touch(first.credentialId)).not.toBeNull();
  });

  it("returns null from touch once a credential idles out or is revoked", () => {
    let now = 1_000;
    const registry = new BrowserAutomationCredentialRegistry({ idleTtlMs: 100, absoluteTtlMs: 1_000, now: () => now });
    const idle = registry.issue(scope("idle"));
    const revoked = registry.issue(scope("revoked"));
    registry.revoke(revoked.credentialId);
    now = 1_100;
    expect(registry.touch(idle.credentialId)).toBeNull();
    expect(registry.touch(revoked.credentialId)).toBeNull();
  });

  it("extends idle expiry on use without extending the absolute lifetime", () => {
    let now = 1_000;
    const registry = new BrowserAutomationCredentialRegistry({
      idleTtlMs: 100,
      absoluteTtlMs: 250,
      now: () => now,
    });
    const issued = registry.issue(scope("bounded-lifetime"));

    now = 1_090;
    expect(registry.touch(issued.credentialId)).not.toBeNull();
    now = 1_180;
    expect(registry.touch(issued.credentialId)).not.toBeNull();
    now = 1_251;
    expect(registry.touch(issued.credentialId)).toBeNull();
  });

  it("evicts the least recently used credential when the bounded capacity is full", () => {
    let now = 1;
    const registry = new BrowserAutomationCredentialRegistry({ maxCredentials: 2, now: () => now });
    const first = registry.issue(scope("first"));
    now++;
    const second = registry.issue(scope("second"));
    now++;
    expect(registry.touch(first.credentialId)).not.toBeNull();
    now++;
    const third = registry.issue(scope("third"));

    expect(registry.touch(first.credentialId)).not.toBeNull();
    expect(registry.touch(second.credentialId)).toBeNull();
    expect(registry.touch(third.credentialId)).not.toBeNull();
    expect(registry.size()).toBe(2);
  });

  it("rejects duplicate operations and evaluate without privileged permission", () => {
    const registry = new BrowserAutomationCredentialRegistry();
    expect(() => registry.issue({ ...scope(), allowedOperations: ["inspect", "inspect"] })).toThrow();
    expect(() => registry.issue({ ...scope(), permissionCapability: "interact", allowedOperations: ["evaluate"] })).toThrow();
    expect(() => registry.issue({ ...scope(), permissionCapability: "observe", allowedOperations: ["evaluate"] })).toThrow();
  });

  it("allows browser_tabs only for mutation-capable credentials", () => {
    const registry = new BrowserAutomationCredentialRegistry();
    const interact = registry.issue({
      ...scope(),
      permissionCapability: "interact",
      allowedOperations: ["tabs"],
    });
    expect(registry.touch(interact.credentialId)?.allowedOperations).toEqual(["tabs"]);
    expect(() => registry.issue({
      ...scope(),
      permissionCapability: "observe",
      allowedOperations: ["tabs"],
    })).toThrow();
  });

  it("stays bounded under concurrent issuance", async () => {
    const registry = new BrowserAutomationCredentialRegistry({ maxCredentials: 16 });
    await Promise.all(
      Array.from({ length: 100 }, (_, index) => Promise.resolve(registry.issue(scope(`session-${index}`)))),
    );
    expect(registry.size()).toBe(16);
  });
});
