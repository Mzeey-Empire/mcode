import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs before importing SettingsService so the constructor's existsSync / watch
// calls don't hit the real filesystem.
vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => false),
  watch: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: vi.fn(() => "/fake/mcode"),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("../../transport/push.js", () => ({
  broadcast: vi.fn(),
}));

import { SettingsService } from "../settings-service.js";
import { broadcast } from "../../transport/push.js";

describe("SettingsService in-process change listener", () => {
  beforeEach(() => vi.clearAllMocks());

  it("on('change', cb) fires cb with the validated settings when update() is called", () => {
    const svc = new SettingsService();
    const listener = vi.fn();
    svc.on("change", listener);

    svc.update({});

    expect(listener).toHaveBeenCalledOnce();
    // The argument should be a Settings object — it will have the provider key.
    const received = listener.mock.calls[0]![0];
    expect(received).toHaveProperty("provider");
    // broadcast must also have been called (existing behaviour is intact)
    expect(broadcast).toHaveBeenCalled();
  });

  it("on('change', cb) returns an unsubscribe function that removes the listener", () => {
    const svc = new SettingsService();
    const listener = vi.fn();
    const unsub = svc.on("change", listener);

    unsub();
    svc.update({});

    expect(listener).not.toHaveBeenCalled();
  });
});
