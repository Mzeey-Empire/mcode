import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const sender = {};
  return {
    sender,
    window: { webContents: sender, isDestroyed: vi.fn(() => false) },
    fromWebContents: vi.fn(),
    handlers: new Map<string, (event: unknown, value: unknown) => unknown>(),
    profiles: { initialize: vi.fn(), remove: vi.fn(), reconcile: vi.fn() },
  };
});
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: fake.fromWebContents },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, value: unknown) => unknown) => fake.handlers.set(channel, handler),
  },
}));
vi.mock("../browser-profiles.js", () => ({ browserProfiles: fake.profiles }));

import { registerBrowserProfileHandlers } from "../profile-handlers.js";

const ID = "ABCDEFAB-1234-4234-8234-ABCDEFABCDEF";
const canonicalId = "abcdefab-1234-4234-8234-abcdefabcdef";

function invoke(operation: "remove" | "reconcile", value: unknown, sender: object = fake.sender): unknown {
  const handler = fake.handlers.get(`preview:profiles.${operation}`);
  if (!handler) throw new Error("Missing profile handler");
  return handler({ sender }, value);
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.window.isDestroyed.mockReturnValue(false);
  fake.fromWebContents.mockReturnValue(fake.window);
  registerBrowserProfileHandlers();
});

describe("Browser profile IPC validation", () => {
  it.each(["remove", "reconcile"] as const)("rejects unowned, destroyed and guest senders for %s", (operation) => {
    const value = operation === "remove" ? ID : [ID];
    fake.fromWebContents.mockReturnValueOnce(null);
    expect(() => invoke(operation, value)).toThrow();
    fake.window.isDestroyed.mockReturnValueOnce(true);
    expect(() => invoke(operation, value)).toThrow();
    expect(() => invoke(operation, value, {})).toThrow();
    expect(fake.profiles.remove).not.toHaveBeenCalled();
    expect(fake.profiles.reconcile).not.toHaveBeenCalled();
  });

  it.each(["../x", "not-a-uuid", 42, null])("rejects invalid IDs before removing or reconciling: %s", (value) => {
    expect(() => invoke("remove", value)).toThrow(TypeError);
    expect(() => invoke("reconcile", [ID, value])).toThrow(TypeError);
    expect(fake.profiles.remove).not.toHaveBeenCalled();
    expect(fake.profiles.reconcile).not.toHaveBeenCalled();
  });

  it.each([
    { value: null }, { value: {} }, { value: ID },
    { value: Array.from({ length: 10_001 }, () => ID) },
  ])("rejects non-array or oversized reconciliation input", ({ value }) => {
    expect(() => invoke("reconcile", value)).toThrow(TypeError);
    expect(fake.profiles.remove).not.toHaveBeenCalled();
    expect(fake.profiles.reconcile).not.toHaveBeenCalled();
  });

  it("accepts and canonicalizes removal and complete lists up to 10000 entries", () => {
    invoke("remove", ID);
    invoke("reconcile", Array.from({ length: 10_000 }, () => ID));
    invoke("reconcile", []);
    expect(fake.profiles.remove.mock.calls).toEqual([[canonicalId]]);
    expect(fake.profiles.reconcile.mock.calls).toEqual([[new Set([canonicalId])], [new Set()]]);
  });
});
