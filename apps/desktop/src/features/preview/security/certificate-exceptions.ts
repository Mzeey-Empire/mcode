import { app, type Certificate, type Event, type Session, type WebContents } from "electron";
import {
  BrowserCertificateFailureSchema,
  type BrowserCertificateFailure,
  type BrowserCertificateState,
} from "@mcode/contracts";

type CertificateGuest = Pick<WebContents, "session" | "getURL" | "on">;

function activeHttpsHost(guest: CertificateGuest): string | null {
  const url = URL.parse(guest.getURL());
  return url?.protocol === "https:" ? url.hostname : null;
}

/** Owns launch-only host/fingerprint trust; only the Browser chrome may add exceptions. */
export class BrowserCertificateExceptions {
  private readonly exceptions = new Map<string, Set<string>>();
  private readonly failures = new WeakMap<CertificateGuest, BrowserCertificateFailure>();
  private readonly observed = new WeakSet<CertificateGuest>();
  private registered = false;

  /** Resolves only exact sessions owned by live project profiles. */
  public constructor(private readonly workspaceForSession: (profile: Session) => string | null) {}

  /** Installs one app listener; unrelated Electron sessions retain default rejection. */
  public register(): void {
    if (this.registered) return;
    this.registered = true;
    app.on("certificate-error", (event, guest, url, error, certificate, callback, isMainFrame) => {
      this.handle(event, guest, url, error, certificate, callback, isMainFrame);
    });
  }

  /** Answers Electron from the current exception set and records only main-frame rejections. */
  public handle(
    event: Pick<Event, "preventDefault">,
    guest: CertificateGuest,
    url: string,
    error: string,
    certificate: Pick<Certificate, "fingerprint" | "subjectName" | "issuerName" | "validStart" | "validExpiry">,
    callback: (trusted: boolean) => void,
    isMainFrame: boolean,
  ): void {
    const workspaceId = this.workspaceForSession(guest.session);
    if (!workspaceId) return;
    const host = new URL(url).hostname;
    if (this.exceptions.get(workspaceId)?.has(`${host}\0${certificate.fingerprint}`)) {
      event.preventDefault();
      callback(true);
      return;
    }
    if (isMainFrame) {
      this.observe(guest);
      const failure = BrowserCertificateFailureSchema().safeParse({
        host, error, fingerprint: certificate.fingerprint,
        subjectName: certificate.subjectName.slice(0, 500),
        issuerName: certificate.issuerName.slice(0, 500),
        validStart: certificate.validStart, validExpiry: certificate.validExpiry,
      });
      this.failures.delete(guest);
      if (failure.success) this.failures.set(guest, failure.data);
    }
    callback(false);
  }

  /** Reads the latest failure and whether this guest's HTTPS host has user trust. */
  public state(guest: CertificateGuest): BrowserCertificateState {
    const workspaceId = this.workspaceForSession(guest.session);
    if (!workspaceId) return { failure: null, exceptionInUse: false };
    const host = activeHttpsHost(guest);
    const pairs = this.exceptions.get(workspaceId);
    return {
      failure: this.failures.get(guest) ?? null,
      exceptionInUse: host !== null && [...(pairs ?? [])].some((pair) => pair.startsWith(`${host}\0`)),
    };
  }

  /** Trusts only the fingerprint rejected for this guest's current main-frame navigation. */
  public proceed(guest: CertificateGuest, fingerprint: string): boolean {
    const workspaceId = this.workspaceForSession(guest.session);
    const failure = this.failures.get(guest);
    if (!workspaceId || !failure || failure.fingerprint !== fingerprint) return false;
    const pairs = this.exceptions.get(workspaceId) ?? new Set<string>();
    pairs.add(`${failure.host}\0${failure.fingerprint}`);
    this.exceptions.set(workspaceId, pairs);
    return true;
  }

  /** Removes all certificates trusted for the active host and closes its profile's TLS connections. */
  public async revoke(guest: CertificateGuest): Promise<void> {
    const workspaceId = this.workspaceForSession(guest.session);
    const host = activeHttpsHost(guest);
    if (!workspaceId || !host) return;
    const pairs = this.exceptions.get(workspaceId);
    if (pairs) {
      for (const pair of pairs) {
        if (pair.startsWith(`${host}\0`)) pairs.delete(pair);
      }
    }
    await guest.session.closeAllConnections();
  }

  /** Drops every exception when its profile is removed. */
  public forget(workspaceId: string): void {
    this.exceptions.delete(workspaceId);
  }

  private observe(guest: CertificateGuest): void {
    if (this.observed.has(guest)) return;
    this.observed.add(guest);
    // A delayed Proceed click must not authorize a warning from an earlier navigation.
    guest.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.failures.delete(guest);
    });
    guest.on("did-navigate", () => this.failures.delete(guest));
  }
}
