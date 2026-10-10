import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { nativeImage, type WebContents } from "electron";
import { BrowserHistorySchema, type BrowserHistory, type BrowserHistoryEntry, type BrowserServerThumbnail } from "@mcode/contracts";
import { browserPartitionFor } from "@mcode/shared/browser-partition";
import { normalizePreviewPageIdentity } from "@mcode/shared/browser-page-identity";
import { logger } from "@mcode/shared";

type BitmapSize = { width: number; height: number };
type CaptureImage = { resize(options: { width: number }): { toBitmap(): Buffer; getSize(): BitmapSize } };
type Guest = Pick<WebContents, "id" | "on" | "removeListener" | "isDestroyed" | "getURL" | "getTitle"> & { capturePage(): Promise<CaptureImage> };

/** Clock and Electron boundaries used by history capture tests. */
export interface BrowserHistoryStoreOptions {
  readonly userDataPath: () => string;
  readonly isRemoved: (workspaceId: string) => boolean;
  readonly now?: () => number;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly capturePage?: (guest: Guest) => Promise<CaptureImage>;
  readonly encodeJpeg?: (bitmap: Buffer, size: BitmapSize) => Buffer;
}

interface WorkspaceHistory {
  entries: BrowserHistoryEntry[];
  readonly attempts: Map<string, number>;
}

interface ObservedGuest {
  readonly workspaceId: string;
  readonly guest: Guest;
  revision: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  pending: Promise<void> | null;
  dispose: () => void;
}

/** Accepts bounded HTTP(S) URLs and removes credentials and fragments before persistence. */
export function sanitizeHistoryUrl(raw: string): string | null {
  if (raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.href.length <= 4096 ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Composites a premultiplied BGRA bitmap onto white. JPEG has no alpha, so a page that
 * never paints a background would otherwise encode as black, where a browser shows white.
 */
export function flattenOntoWhite(bitmap: Buffer): Buffer {
  const flat = Buffer.from(bitmap);
  for (let offset = 0; offset + 3 < flat.length; offset += 4) {
    const cover = 255 - flat[offset + 3]!;
    flat[offset] = Math.min(255, flat[offset]! + cover);
    flat[offset + 1] = Math.min(255, flat[offset + 1]! + cover);
    flat[offset + 2] = Math.min(255, flat[offset + 2]! + cover);
    flat[offset + 3] = 255;
  }
  return flat;
}

function thumbnailOrigin(raw: string): string | null {
  const sanitized = sanitizeHistoryUrl(raw);
  if (!sanitized) return null;
  const url = new URL(sanitized);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || NodeNet.isIP(host) !== 0 ? url.origin : null;
}

function newestEntries(entries: BrowserHistoryEntry[]): BrowserHistoryEntry[] {
  const seen = new Set<string>();
  return entries.sort((a, b) => b.lastVisitedAt - a.lastVisitedAt).filter((entry) => {
    const identity = normalizePreviewPageIdentity(entry.url);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).slice(0, 50);
}

function readEntries(path: string): BrowserHistoryEntry[] {
  if (!NodeFS.existsSync(path)) return [];
  try {
    if (NodeFS.statSync(path).size > 1_000_000) return [];
    const entries: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    const parsed = BrowserHistorySchema().safeParse({ entries, thumbnails: [] });
    if (!parsed.success) return [];
    return newestEntries(parsed.data.entries.flatMap((entry) => {
      const url = sanitizeHistoryUrl(entry.url);
      return url ? [{ ...entry, url, faviconUrl: entry.faviconUrl ? sanitizeHistoryUrl(entry.faviconUrl) : null }] : [];
    }));
  } catch {
    // A damaged local cache must not prevent opening the Browser.
    return [];
  }
}

/** Owns bounded per-workspace history and load-driven thumbnail captures. */
export class BrowserHistoryStore {
  private readonly workspaces = new Map<string, WorkspaceHistory>();
  private readonly guests = new Map<number, ObservedGuest>();
  private readonly now: () => number;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;
  private readonly capturePage: (guest: Guest) => Promise<CaptureImage>;
  private readonly encodeJpeg: (bitmap: Buffer, size: BitmapSize) => Buffer;

  /** Creates an isolated history owner; constructing it performs no disk access. */
  public constructor(private readonly options: BrowserHistoryStoreOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.setTimeout ?? setTimeout;
    this.cancel = options.clearTimeout ?? clearTimeout;
    this.capturePage = options.capturePage ?? ((guest) => guest.capturePage());
    this.encodeJpeg = options.encodeJpeg ?? ((bitmap, size) => nativeImage.createFromBitmap(bitmap, size).toJPEG(70));
  }

  private id(workspaceId: string): string {
    browserPartitionFor(workspaceId);
    return workspaceId.toLowerCase();
  }

  private directory(id: string): string {
    return NodePath.join(this.options.userDataPath(), "browser-profiles", id);
  }

  private state(id: string): WorkspaceHistory | undefined {
    if (this.options.isRemoved(id)) return undefined;
    let state = this.workspaces.get(id);
    if (!state) {
      state = { entries: readEntries(NodePath.join(this.directory(id), "history.json")), attempts: new Map() };
      this.workspaces.set(id, state);
    }
    return state;
  }

  private persist(id: string, state: WorkspaceHistory): void {
    if (this.options.isRemoved(id)) return;
    const directory = this.directory(id);
    NodeFS.mkdirSync(directory, { recursive: true });
    const path = NodePath.join(directory, "history.json");
    NodeFS.writeFileSync(`${path}.tmp`, JSON.stringify(state.entries));
    NodeFS.renameSync(`${path}.tmp`, path);
  }

  /** Reads recent pages and the saved thumbnails for their server origins. */
  public list(workspaceId: string): BrowserHistory {
    const id = this.id(workspaceId);
    const state = this.state(id);
    if (!state) return { entries: [], thumbnails: [] };
    const origins = new Set(state.entries.flatMap((entry) => thumbnailOrigin(entry.url) ?? []));
    const thumbnails = [...origins].flatMap((origin) => this.readThumbnail(id, origin) ?? []);
    return { entries: state.entries.map((entry) => ({ ...entry })), thumbnails };
  }

  /** Records a navigation without retaining userinfo or fragment identifiers. */
  public record(workspaceId: string, rawUrl: string, title: string | null = null): void {
    const id = this.id(workspaceId);
    const url = sanitizeHistoryUrl(rawUrl);
    if (!url) return;
    const state = this.state(id);
    if (!state) return;
    const entry = { url, title: title?.slice(0, 240) ?? null, faviconUrl: null, lastVisitedAt: this.now() };
    state.entries = newestEntries([entry, ...state.entries]);
    this.persist(id, state);
  }

  private update(workspaceId: string, rawUrl: string, metadata: Pick<Partial<BrowserHistoryEntry>, "title" | "faviconUrl">): void {
    const url = sanitizeHistoryUrl(rawUrl);
    const state = this.state(workspaceId);
    if (!url || !state) return;
    const entry = state.entries.find((candidate) => normalizePreviewPageIdentity(candidate.url) === normalizePreviewPageIdentity(url));
    if (!entry) return;
    Object.assign(entry, metadata);
    this.persist(workspaceId, state);
  }

  /** Removes every URL variant of a recent page without changing the current tab. */
  public remove(workspaceId: string, rawUrl: string): void {
    const id = this.id(workspaceId);
    const url = sanitizeHistoryUrl(rawUrl);
    if (!url) throw new TypeError("Expected a bounded HTTP(S) history URL");
    const state = this.state(id);
    if (!state) return;
    state.entries = state.entries.filter((entry) => normalizePreviewPageIdentity(entry.url) !== normalizePreviewPageIdentity(url));
    this.persist(id, state);
  }

  private thumbnailPath(id: string, origin: string): string {
    return NodePath.join(this.directory(id), "thumbnails", `${NodeCrypto.createHash("sha1").update(origin).digest("hex")}.jpg`);
  }

  private readThumbnail(id: string, origin: string): BrowserServerThumbnail | null {
    const path = this.thumbnailPath(id, origin);
    if (!NodeFS.existsSync(path)) return null;
    const stat = NodeFS.statSync(path);
    if (stat.size > 2_000_000) return null;
    return { origin, capturedAt: stat.mtimeMs, dataUrl: `data:image/jpeg;base64,${NodeFS.readFileSync(path).toString("base64")}` };
  }

  private cancelCapture(observed: ObservedGuest): void {
    this.cancel(observed.timer);
    observed.timer = undefined;
  }

  private scheduleCapture(observed: ObservedGuest): void {
    this.cancelCapture(observed);
    if (!thumbnailOrigin(observed.guest.getURL())) return;
    observed.timer = this.schedule(() => {
      observed.timer = undefined;
      void this.capture(observed);
    }, 1500);
  }

  private capture(observed: ObservedGuest): Promise<void> {
    this.cancelCapture(observed);
    observed.pending ??= this.captureOnce(observed).finally(() => { observed.pending = null; });
    return observed.pending;
  }

  private async captureOnce(observed: ObservedGuest): Promise<void> {
    if (observed.guest.isDestroyed()) return;
    const origin = thumbnailOrigin(observed.guest.getURL());
    const state = this.state(observed.workspaceId);
    if (!origin || !state) return;
    const path = this.thumbnailPath(observed.workspaceId, origin);
    const previous = state.attempts.get(origin) ?? this.lastCaptureTime(path);
    const capturedAt = this.now();
    if (capturedAt - previous < 60_000) return;
    state.attempts.set(origin, capturedAt);
    const revision = observed.revision;
    try {
      const image = await this.capturePage(observed.guest);
      if (!this.canSaveCapture(observed, state, revision) || state.attempts.get(origin) !== capturedAt) return;
      const thumbnail = image.resize({ width: 320 });
      const jpeg = this.encodeJpeg(flattenOntoWhite(thumbnail.toBitmap()), thumbnail.getSize());
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(`${path}.tmp`, jpeg);
      NodeFS.renameSync(`${path}.tmp`, path);
      NodeFS.utimesSync(path, capturedAt / 1000, capturedAt / 1000);
    } catch (error) {
      logger.warn("Browser thumbnail capture failed", { error });
    }
  }

  private canSaveCapture(observed: ObservedGuest, state: WorkspaceHistory, revision: number): boolean {
    return !this.options.isRemoved(observed.workspaceId) && this.workspaces.get(observed.workspaceId) === state && revision === observed.revision;
  }

  private lastCaptureTime(path: string): number {
    return NodeFS.existsSync(path) ? NodeFS.statSync(path).mtimeMs : -Infinity;
  }

  /** Captures a guest just before hiding or closing, sharing the origin cooldown. */
  public async captureGuest(guestId: number): Promise<void> {
    const observed = this.guests.get(guestId);
    if (observed) await this.capture(observed);
  }

  /** Records trusted adopted guests, including tabs created by browser automation. */
  public observe(workspaceId: string, guest: Guest): () => void {
    const id = this.id(workspaceId);
    if (this.options.isRemoved(id)) return () => undefined;
    const observed: ObservedGuest = { workspaceId: id, guest, revision: 0, timer: undefined, pending: null, dispose: () => undefined };
    let identity = "";
    const navigate = (_event: unknown, rawUrl: string) => {
      const url = sanitizeHistoryUrl(rawUrl);
      identity = url ? normalizePreviewPageIdentity(url) : "";
      this.record(id, rawUrl, guest.getTitle());
    };
    const inPage = (event: unknown, rawUrl: string, mainFrame: boolean) => {
      const url = sanitizeHistoryUrl(rawUrl);
      if (mainFrame && url && normalizePreviewPageIdentity(url) !== identity) navigate(event, rawUrl);
    };
    const started = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => {
      if (!mainFrame) return;
      observed.revision++;
      this.cancelCapture(observed);
    };
    const title = (_event: unknown, value: string) => this.update(id, guest.getURL(), { title: value.slice(0, 240) });
    const favicon = (_event: unknown, urls: string[]) => this.update(id, guest.getURL(), { faviconUrl: sanitizeHistoryUrl(urls[0] ?? "") });
    const finished = () => this.scheduleCapture(observed);
    const dispose = () => {
      this.cancelCapture(observed);
      this.guests.delete(guest.id);
      guest.removeListener("did-navigate", navigate);
      guest.removeListener("did-navigate-in-page", inPage);
      guest.removeListener("did-start-navigation", started);
      guest.removeListener("page-title-updated", title);
      guest.removeListener("page-favicon-updated", favicon);
      guest.removeListener("did-finish-load", finished);
      guest.removeListener("destroyed", dispose);
    };
    observed.dispose = dispose;
    this.guests.set(guest.id, observed);
    guest.on("did-navigate", navigate);
    guest.on("did-navigate-in-page", inPage);
    guest.on("did-start-navigation", started);
    guest.on("page-title-updated", title);
    guest.on("page-favicon-updated", favicon);
    guest.on("did-finish-load", finished);
    guest.on("destroyed", dispose);
    return dispose;
  }

  /** Cancels guests and invalidates captures before the profile directory is deleted. */
  public forget(workspaceId: string): void {
    const id = this.id(workspaceId);
    for (const observed of this.guests.values()) {
      if (observed.workspaceId === id) observed.dispose();
    }
    this.workspaces.delete(id);
  }
}
