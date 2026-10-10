import * as NodeFS from "node:fs";
import * as NodeEvents from "node:events";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const makeSession = () => {
    const cookies = new Map([["fixture", "1"]]);
    return {
      cookies,
      on: vi.fn(),
      webRequest: { onCompleted: vi.fn() },
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      clearStorageData: vi.fn(async () => { cookies.clear(); }),
      clearCache: vi.fn(async () => undefined),
    };
  };
  const sessions = new Map<string, ReturnType<typeof makeSession>>();
  return {
    sessions,
    session: { fromPartition: vi.fn((partition: string) => {
      let profile = sessions.get(partition);
      if (!profile) { profile = makeSession(); sessions.set(partition, profile); }
      return profile;
    }) },
    ipcMain: { on: vi.fn() },
    nativeImage: { createFromBitmap: vi.fn(() => ({ toJPEG: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) })) },
  };
});
vi.mock("electron", () => electron);

import { session } from "electron";
import { BrowserProfiles } from "../browser-profiles.js";
import { installBrowserSessionPolicy } from "../electron-session-policy.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const partitionA = "persist:mcode-browser-11111111-1111-4111-8111-111111111111";
const partitionB = "persist:mcode-browser-22222222-2222-4222-8222-222222222222";
let root: string;
const releaseWorkspace = vi.fn();

function owner(removeLegacyPartition?: (path: string) => void): BrowserProfiles {
  return new BrowserProfiles({
    userDataPath: () => root,
    sessionDataPath: () => NodePath.join(root, "session-data"),
    sessionFromPartition: (partition) => session.fromPartition(partition),
    installPolicy: installBrowserSessionPolicy,
    releaseWorkspace,
    removeLegacyPartition,
  });
}

function seedProfile(id: string): void {
  const profile = NodePath.join(root, "browser-profiles", id);
  NodeFS.mkdirSync(profile, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(profile, "history.json"), "history");
  NodeFS.writeFileSync(NodePath.join(profile, "thumbnail.png"), "thumbnail");
  NodeFS.mkdirSync(NodePath.join(root, "session-data", "Partitions", `mcode-browser-${id}`), { recursive: true });
}

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-browser-profiles-"));
  electron.sessions.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  NodeFS.rmSync(root, { recursive: true, force: true });
});

function historyGuest(id: number, url: string) {
  const image = { resize: () => ({ toBitmap: () => Buffer.alloc(4), getSize: () => ({ width: 1, height: 1 }) }) };
  return Object.assign(new NodeEvents.EventEmitter(), {
    id, getURL: () => url, getTitle: () => "Fixture", isDestroyed: () => false,
    capturePage: vi.fn(async () => image),
  });
}

describe("BrowserProfiles", () => {
  it("continues startup when the legacy partition is locked and retries next launch", () => {
    const legacy = NodePath.join(root, "session-data", "Partitions", `mcode-preview`);
    const marker = NodePath.join(root, "browser-profiles-migrated");
    NodeFS.mkdirSync(legacy, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(legacy, "Cookies"), "legacy cookies");
    const error = Object.assign(new Error("Locked file"), { code: "EBUSY" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const remove = vi.fn(() => { throw error; });
    try {
      const profiles = owner(remove);
      expect(() => profiles.initialize()).not.toThrow();
      expect(NodeFS.existsSync(marker)).toBe(false);
      expect(NodeFS.readFileSync(NodePath.join(legacy, "Cookies"), "utf8")).toBe("legacy cookies");
      expect(() => profiles.sessionForWorkspace(A)).not.toThrow();
      expect(electron.session.fromPartition.mock.calls).toEqual([[partitionA]]);
      expect(remove.mock.calls).toEqual([[legacy]]);
      expect(warn).toHaveBeenCalledWith("Could not remove the legacy Browser partition; retrying next launch", error);
      owner((path) => NodeFS.rmSync(path, { recursive: true, force: true })).initialize();
      expect(NodeFS.existsSync(legacy)).toBe(false);
      expect(NodeFS.readFileSync(marker, "utf8")).toBe("1\n");
    } finally {
      warn.mockRestore();
    }
  });

  it("installs policy before returning each workspace session, once", () => {
    const profiles = owner();
    const a = profiles.sessionForWorkspace(A);
    const b = profiles.sessionForWorkspace(B);
    expect(a).not.toBe(b);
    expect(profiles.sessionForWorkspace(A)).toBe(a);
    for (const key of [partitionA, partitionB]) {
      const profile = electron.sessions.get(key)!;
      expect(profile.on).toHaveBeenCalledTimes(1);
      expect(profile.on).toHaveBeenCalledWith("will-download", expect.any(Function));
      expect(profile.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
      expect(profile.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
      expect(profile.webRequest.onCompleted).toHaveBeenCalledWith({ urls: ["http://*/*", "https://*/*"] }, expect.any(Function));
    }
    expect(electron.session.fromPartition.mock.calls).toEqual([[partitionA], [partitionB]]);
  });

  it("clears cookies and cache only for the requested workspace", async () => {
    const profiles = owner();
    profiles.sessionForWorkspace(A);
    profiles.sessionForWorkspace(B);
    await profiles.clear(A, "cookies");
    await profiles.clear(A, "cache");
    const a = electron.sessions.get(partitionA)!;
    const b = electron.sessions.get(partitionB)!;
    expect([...a.cookies]).toEqual([]);
    expect([...b.cookies]).toEqual([["fixture", "1"]]);
    expect(a.clearStorageData.mock.calls).toEqual([[{ storages: ["cookies"] }]]);
    expect(a.clearCache).toHaveBeenCalledTimes(1);
    expect(b.clearStorageData).not.toHaveBeenCalled();
    expect(b.clearCache).not.toHaveBeenCalled();
  });

  it("releases guests before clearing, deletes history and thumbnails, and removes idempotently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    NodeFS.mkdirSync(NodePath.join(root, "session-data", "Partitions", `mcode-browser-${A}`), { recursive: true });
    const profiles = owner();
    profiles.sessionForWorkspace(A);
    const captured = historyGuest(1, "http://localhost:5173/fixture");
    const delayed = historyGuest(2, "http://127.0.0.1:5173/pending");
    for (const guest of [captured, delayed]) {
      profiles.history.observe(A, guest);
      guest.emit("did-navigate", {}, guest.getURL());
    }
    await profiles.history.captureGuest(captured.id);
    expect(profiles.history.list(A).entries.map((entry) => entry.url)).toEqual([delayed.getURL(), captured.getURL()]);
    expect(profiles.history.list(A).thumbnails.map((thumbnail) => thumbnail.origin)).toEqual(["http://localhost:5173"]);
    expect(NodeFS.readdirSync(NodePath.join(root, "browser-profiles", A, "thumbnails"))).toHaveLength(1);
    delayed.emit("did-finish-load");
    expect(vi.getTimerCount()).toBe(1);
    const first = profiles.remove(A);
    expect(profiles.remove(A)).toBe(first);
    await first;
    await profiles.remove(A);
    const a = electron.sessions.get(partitionA)!;
    expect(releaseWorkspace.mock.calls).toEqual([[A]]);
    expect(releaseWorkspace.mock.invocationCallOrder[0]).toBeLessThan(a.clearStorageData.mock.invocationCallOrder[0]!);
    expect(a.clearStorageData.mock.calls).toEqual([[]]);
    expect(a.clearCache).toHaveBeenCalledTimes(1);
    expect(NodeFS.existsSync(NodePath.join(root, "browser-profiles", A))).toBe(false);
    expect(profiles.history.list(A)).toEqual({ entries: [], thumbnails: [] });
    expect(captured.eventNames()).toEqual([]);
    expect(delayed.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    profiles.history.record(A, "http://localhost/late");
    delayed.emit("did-finish-load");
    await profiles.history.captureGuest(delayed.id);
    expect(delayed.capturePage).not.toHaveBeenCalled();
    expect(NodeFS.existsSync(NodePath.join(root, "browser-profiles", A))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(root, "session-data", "Partitions", `mcode-browser-${A}`))).toBe(true);
    expect(() => profiles.sessionForWorkspace(A)).toThrow();
    await owner().reconcile(new Set());
    expect(NodeFS.existsSync(NodePath.join(root, "session-data", "Partitions", `mcode-browser-${A}`))).toBe(false);
    expect(electron.session.fromPartition).toHaveBeenCalledTimes(1);
  });

  it("does not recreate a removed profile when an in-flight capture finishes", async () => {
    const profiles = owner();
    const guest = historyGuest(3, "http://localhost/fixture");
    const image = await guest.capturePage();
    let finish: (value: typeof image) => void = () => { throw new Error("capture not started"); };
    guest.capturePage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    profiles.history.observe(A, guest);
    guest.emit("did-navigate", {}, guest.getURL());
    const capture = profiles.history.captureGuest(guest.id);
    await profiles.remove(A);
    finish(image);
    await capture;
    expect(profiles.history.list(A)).toEqual({ entries: [], thumbnails: [] });
    expect(NodeFS.existsSync(NodePath.join(root, "browser-profiles", A))).toBe(false);
    expect(guest.eventNames()).toEqual([]);
  });

  it("reconciles only absent profiles without opening their partitions", async () => {
    seedProfile(A);
    seedProfile(B);
    NodeFS.mkdirSync(NodePath.join(root, "session-data", "Partitions", "unrelated"));
    await owner().reconcile(new Set([B]));
    expect(NodeFS.existsSync(NodePath.join(root, "browser-profiles", A))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(root, "session-data", "Partitions", `mcode-browser-${A}`))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(root, "browser-profiles", B, "history.json"), "utf8")).toBe("history");
    expect(NodeFS.existsSync(NodePath.join(root, "session-data", "Partitions", `mcode-browser-${B}`))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(root, "session-data", "Partitions", "unrelated"))).toBe(true);
    expect(electron.session.fromPartition).not.toHaveBeenCalled();
    await expect(owner().remove(A)).resolves.toBeUndefined();
  });

  it("deletes the unopened old jar once and leaves a second launch untouched", () => {
    const legacy = NodePath.join(root, "session-data", "Partitions", `mcode-preview`);
    NodeFS.mkdirSync(legacy, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(legacy, "Cookies"), "old shared cookies");
    owner().initialize();
    expect(NodeFS.existsSync(legacy)).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(root, "browser-profiles-migrated"), "utf8")).toBe("1\n");
    NodeFS.mkdirSync(legacy);
    NodeFS.writeFileSync(NodePath.join(legacy, "sentinel"), "untouched");
    owner().initialize();
    expect(NodeFS.readFileSync(NodePath.join(legacy, "sentinel"), "utf8")).toBe("untouched");
    expect(electron.session.fromPartition).not.toHaveBeenCalled();
  });

  it("validates the complete list before deleting anything", async () => {
    seedProfile(A);
    await expect(owner().reconcile(new Set(["../escape"]))).rejects.toThrow(TypeError);
    expect(NodeFS.existsSync(NodePath.join(root, "browser-profiles", A))).toBe(true);
    expect(() => owner().sessionForWorkspace("../escape")).toThrow(TypeError);
  });
});
