import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserCertificateStateSchema } from "@mcode/contracts";

const electron = vi.hoisted(() => {
  const makeSession = () => ({
    clearStorageData: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    closeAllConnections: vi.fn(async () => undefined),
  });
  const sessions = new Map<string, ReturnType<typeof makeSession>>();
  return {
    app: { on: vi.fn() },
    ipcMain: { on: vi.fn() },
    sessions,
    session: { fromPartition: vi.fn((partition: string) => {
      let profile = sessions.get(partition);
      if (!profile) { profile = makeSession(); sessions.set(partition, profile); }
      return profile;
    }) },
  };
});
vi.mock("electron", () => electron);

import { session, type Session } from "electron";
import { BrowserProfiles } from "../browser-profiles.js";
import { BrowserCertificateExceptions } from "../certificate-exceptions.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const certificate = {
  fingerprint: "AA:BB:CC", subjectName: "localhost", issuerName: "Local development",
  validStart: 1_700_000_000, validExpiry: 1_800_000_000,
};
const failure = { host: "localhost", error: "net::ERR_CERT_AUTHORITY_INVALID", ...certificate };

class Guest extends NodeEvents.EventEmitter {
  public url = "https://localhost:4443/";
  public constructor(public readonly session: Session) { super(); }
  public getURL(): string { return this.url; }
}

let root: string;
let profiles: BrowserProfiles;
let trust: BrowserCertificateExceptions;
let guest: Guest;

beforeEach(() => {
  vi.clearAllMocks();
  electron.sessions.clear();
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-certificates-"));
  profiles = new BrowserProfiles({
    userDataPath: () => root, sessionDataPath: () => root,
    sessionFromPartition: (partition) => session.fromPartition(partition),
    installPolicy: () => undefined, releaseWorkspace: () => undefined,
  });
  trust = profiles.certificates;
  guest = new Guest(profiles.sessionForWorkspace(A));
  trust.register();
});

afterEach(() => NodeFS.rmSync(root, { recursive: true, force: true }));

function rejectCertificate(target = guest, options: { url?: string; fingerprint?: string; mainFrame?: boolean } = {}) {
  const event = { preventDefault: vi.fn() };
  const callback = vi.fn();
  const listener = electron.app.on.mock.calls[0]![1];
  listener(event, target, options.url ?? target.url, "net::ERR_CERT_AUTHORITY_INVALID",
    { ...certificate, fingerprint: options.fingerprint ?? certificate.fingerprint }, callback, options.mainFrame ?? true);
  return { event, callback };
}

function proceed(target = guest): void {
  rejectCertificate(target);
  expect(trust.proceed(target, certificate.fingerprint)).toBe(true);
}

describe("Browser certificate exceptions", () => {
  it("rejects a main frame and returns bounded certificate details in Unix seconds", () => {
    const { event, callback } = rejectCertificate();
    expect(callback.mock.calls).toEqual([[false]]);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(BrowserCertificateStateSchema().parse(trust.state(guest))).toEqual({ failure, exceptionInUse: false });
  });

  it("answers a trusted pair from the single installed app listener", () => {
    trust.register();
    expect(electron.app.on.mock.calls.map(([name]) => name)).toEqual(["certificate-error"]);
    proceed();
    const { event, callback } = rejectCertificate();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(callback.mock.calls).toEqual([[true]]);
    guest.emit("did-navigate");
    expect(trust.state(guest)).toEqual({ failure: null, exceptionInUse: true });
  });

  it("never records subresource rejections or replaces a main-frame warning with one", () => {
    const { callback } = rejectCertificate(guest, { mainFrame: false });
    expect(callback.mock.calls).toEqual([[false]]);
    expect(trust.state(guest)).toEqual({ failure: null, exceptionInUse: false });
    rejectCertificate();
    rejectCertificate(guest, { url: "https://cdn.test/asset", mainFrame: false });
    expect(trust.state(guest).failure).toEqual(failure);
  });

  it("leaves non-profile sessions to Electron without consulting certificate data or answering", () => {
    proceed();
    const outsider = new Guest(session.fromPartition("app-window"));
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    const unreadCertificate = { ...certificate, get fingerprint(): string { throw new Error("must not read certificate"); } };
    trust.handle(event, outsider, "not even a URL", "certificate error", unreadCertificate, callback, true);
    expect(callback).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(trust.state(outsider)).toEqual({ failure: null, exceptionInUse: false });
    expect(trust.proceed(outsider, certificate.fingerprint)).toBe(false);
  });

  it("allows Proceed only for the latest failure of that guest, including failed initial loads", () => {
    guest.url = "about:blank";
    expect(trust.proceed(guest, certificate.fingerprint)).toBe(false);
    rejectCertificate(guest, { url: "https://localhost:4443/" });
    expect(trust.proceed(guest, "different fingerprint")).toBe(false);
    const sibling = new Guest(guest.session);
    expect(trust.proceed(sibling, certificate.fingerprint)).toBe(false);
    expect(trust.proceed(guest, certificate.fingerprint)).toBe(true);
    expect(rejectCertificate(sibling).callback.mock.calls).toEqual([[true]]);
  });

  it("invalidates an earlier host's warning on main-frame navigation but not subframe navigation", () => {
    rejectCertificate();
    guest.emit("did-start-navigation", {}, "https://cdn.test/", false, false);
    expect(trust.state(guest).failure).toEqual(failure);
    guest.url = "https://different.test/";
    guest.emit("did-start-navigation", {}, guest.url, false, true);
    expect(trust.proceed(guest, certificate.fingerprint)).toBe(false);
    expect(trust.state(guest)).toEqual({ failure: null, exceptionInUse: false });
    expect(rejectCertificate(guest, { url: "https://localhost/" }).callback.mock.calls).toEqual([[false]]);
  });

  it("does not transfer trust to another host or another fingerprint on the same host", () => {
    proceed();
    const changed = rejectCertificate(guest, { fingerprint: "DD:EE:FF" });
    expect(changed.callback.mock.calls).toEqual([[false]]);
    expect(trust.proceed(guest, certificate.fingerprint)).toBe(false);
    expect(trust.state(guest).failure?.fingerprint).toBe("DD:EE:FF");
    expect(rejectCertificate(guest, { url: "https://other.test/" }).callback.mock.calls).toEqual([[false]]);
  });

  it("shares a profile's trust across tabs while isolating two workspaces", () => {
    proceed();
    const sameWorkspace = new Guest(profiles.sessionForWorkspace(A));
    const otherWorkspace = new Guest(profiles.sessionForWorkspace(B));
    expect(rejectCertificate(sameWorkspace).callback.mock.calls).toEqual([[true]]);
    expect(rejectCertificate(otherWorkspace).callback.mock.calls).toEqual([[false]]);
    expect(trust.state(otherWorkspace)).toEqual({ failure, exceptionInUse: false });
  });

  it("revokes every fingerprint for the active host, closes connections, and preserves other hosts", async () => {
    proceed();
    rejectCertificate(guest, { fingerprint: "DD:EE:FF" });
    expect(trust.proceed(guest, "DD:EE:FF")).toBe(true);
    const otherHost = new Guest(guest.session);
    otherHost.url = "https://localhost.example/";
    proceed(otherHost);
    await trust.revoke(guest);
    expect(guest.session.closeAllConnections).toHaveBeenCalledOnce();
    expect(trust.state(guest).exceptionInUse).toBe(false);
    expect(rejectCertificate().callback.mock.calls).toEqual([[false]]);
    expect(rejectCertificate(guest, { fingerprint: "DD:EE:FF" }).callback.mock.calls).toEqual([[false]]);
    expect(rejectCertificate(otherHost).callback.mock.calls).toEqual([[true]]);
  });

  it("reports trust only for HTTPS and leaves it intact across cookie and cache clearing", async () => {
    proceed();
    await profiles.clear(A, "cookies");
    await profiles.clear(A, "cache");
    expect(rejectCertificate().callback.mock.calls).toEqual([[true]]);
    guest.url = "http://localhost:4443/";
    expect(trust.state(guest).exceptionInUse).toBe(false);
    await trust.revoke(guest);
    expect(guest.session.closeAllConnections).not.toHaveBeenCalled();
    guest.url = "https://localhost:4443/";
    expect(trust.state(guest).exceptionInUse).toBe(true);
  });

  it("removing a profile rejects its old guests and leaves other workspaces trusted", async () => {
    proceed();
    const otherWorkspace = new Guest(profiles.sessionForWorkspace(B));
    proceed(otherWorkspace);
    await profiles.remove(A);
    expect(profiles.workspaceForSession(guest.session)).toBeNull();
    expect(trust.state(guest)).toEqual({ failure: null, exceptionInUse: false });
    expect(trust.proceed(guest, certificate.fingerprint)).toBe(false);
    expect(rejectCertificate().callback).not.toHaveBeenCalled();
    expect(rejectCertificate(otherWorkspace).callback.mock.calls).toEqual([[true]]);
  });

  it("does not carry a trusted certificate across an app relaunch on the same data directory", () => {
    proceed();
    expect(rejectCertificate().callback.mock.calls).toEqual([[true]]);

    electron.sessions.clear();
    electron.app.on.mockClear();
    const relaunched = new BrowserProfiles({
      userDataPath: () => root, sessionDataPath: () => root,
      sessionFromPartition: (partition) => session.fromPartition(partition),
      installPolicy: () => undefined, releaseWorkspace: () => undefined,
    });
    relaunched.certificates.register();
    const reopened = new Guest(relaunched.sessionForWorkspace(A));

    expect(relaunched.certificates.state(reopened)).toEqual({ failure: null, exceptionInUse: false });
    expect(rejectCertificate(reopened).callback.mock.calls).toEqual([[false]]);
  });

  it("forgetting a workspace removes its trust even while its session remains alive", () => {
    proceed();
    trust.forget(A);
    expect(trust.state(guest).exceptionInUse).toBe(false);
    expect(rejectCertificate().callback.mock.calls).toEqual([[false]]);
  });
});
