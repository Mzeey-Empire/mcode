import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { app, session, type Session } from "electron";
import { browserPartitionFor } from "@mcode/shared/browser-partition";
import { installBrowserSessionPolicy } from "./electron-session-policy.js";
import { disposePreviewSurfacesForWorkspace } from "../surfaces/registry.js";

/** Injectable Electron boundaries; file operations stay inside the supplied data directories. */
export interface BrowserProfilesOptions {
  readonly userDataPath: () => string;
  readonly sessionDataPath: () => string;
  readonly sessionFromPartition: (partition: string) => Session;
  readonly installPolicy: (profile: Session) => void;
  readonly releaseWorkspace: (workspaceId: string) => void;
  readonly removeLegacyPartition?: (path: string) => void;
}

function canonicalWorkspaceId(workspaceId: string): string {
  browserPartitionFor(workspaceId);
  return workspaceId.toLowerCase();
}

function profileIds(directory: string, prefix = ""): string[] {
  if (!NodeFS.existsSync(directory)) return [];
  const ids: string[] = [];
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const id = entry.name.slice(prefix.length);
    try {
      ids.push(canonicalWorkspaceId(id));
    } catch {
      // Unrelated directories are not owned by Browser profiles.
    }
  }
  return ids;
}

/** Owns one persistent Electron session and its local Browser data per workspace. */
export class BrowserProfiles {
  private readonly sessions = new Map<string, Session>();
  private readonly removals = new Map<string, Promise<void>>();
  private readonly removed = new Set<string>();
  private initialized = false;

  /** Creates a profile owner with injectable Electron services and data roots. */
  public constructor(private readonly options: BrowserProfilesOptions = {
    userDataPath: () => app.getPath("userData"),
    sessionDataPath: () => app.getPath("sessionData"),
    sessionFromPartition: (partition) => session.fromPartition(partition),
    installPolicy: installBrowserSessionPolicy,
    releaseWorkspace: disposePreviewSurfacesForWorkspace,
  }) {}

  /** Removes the retired jar once, before opening any Browser session. */
  public initialize(): void {
    if (this.initialized) return;
    const marker = NodePath.join(this.options.userDataPath(), "browser-profiles-migrated");
    if (!NodeFS.existsSync(marker)) {
      // Opening the retired session would lock its files; deleting its unopened directory clears every store.
      const legacyPath = NodePath.join(this.options.sessionDataPath(), "Partitions", `mcode-preview`);
      try {
        if (this.options.removeLegacyPartition) this.options.removeLegacyPartition(legacyPath);
        else NodeFS.rmSync(legacyPath, { recursive: true, force: true });
      } catch (error) {
        console.warn("Could not remove the legacy Browser partition; retrying next launch", error);
        this.initialized = true;
        return;
      }
      NodeFS.mkdirSync(this.options.userDataPath(), { recursive: true });
      NodeFS.writeFileSync(marker, "1\n");
    }
    this.initialized = true;
  }

  /** Returns this workspace's session with clipboard, download and request policy installed. */
  public sessionForWorkspace(workspaceId: string): Session {
    const id = canonicalWorkspaceId(workspaceId);
    this.initialize();
    if (this.removed.has(id)) throw new Error("Browser workspace was removed");
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const profile = this.options.sessionFromPartition(browserPartitionFor(id));
    this.options.installPolicy(profile);
    this.sessions.set(id, profile);
    return profile;
  }

  /** Reports whether this workspace was removed during this launch. */
  public isRemoved(workspaceId: string): boolean {
    return this.removed.has(canonicalWorkspaceId(workspaceId));
  }

  /** Clears only the requested store in this workspace's session. */
  public async clear(workspaceId: string, store: "cookies" | "cache"): Promise<void> {
    const profile = this.sessionForWorkspace(workspaceId);
    if (store === "cookies") await profile.clearStorageData({ storages: ["cookies"] });
    else await profile.clearCache();
  }

  /** Releases every workspace surface, clears its stores and deletes its history and thumbnails. */
  public remove(workspaceId: string): Promise<void> {
    const id = canonicalWorkspaceId(workspaceId);
    this.initialize();
    const pending = this.removals.get(id);
    if (pending) return pending;
    this.removed.add(id);
    const removal = this.removeProfile(id);
    this.removals.set(id, removal);
    void removal.catch(() => this.removals.delete(id));
    return removal;
  }

  private async removeProfile(id: string): Promise<void> {
    this.options.releaseWorkspace(id);
    const profile = this.sessions.get(id);
    if (profile) {
      await profile.clearStorageData();
      await profile.clearCache();
    } else {
      // Electron retains opened sessions until exit. Delete only partitions never opened this launch.
      NodeFS.rmSync(NodePath.join(this.options.sessionDataPath(), "Partitions", `mcode-browser-${id}`), { recursive: true, force: true });
    }
    NodeFS.rmSync(NodePath.join(this.options.userDataPath(), "browser-profiles", id), { recursive: true, force: true });
  }

  /** Removes profiles absent from a successful, complete server workspace list. */
  public async reconcile(liveWorkspaceIds: ReadonlySet<string>): Promise<void> {
    const live = new Set([...liveWorkspaceIds].map(canonicalWorkspaceId));
    this.initialize();
    const known = new Set([
      ...this.sessions.keys(),
      ...profileIds(NodePath.join(this.options.userDataPath(), "browser-profiles")),
      ...profileIds(NodePath.join(this.options.sessionDataPath(), "Partitions"), "mcode-browser-"),
    ]);
    await Promise.all([...known].filter((id) => !live.has(id)).map((id) => this.remove(id)));
  }
}

/** Process-wide owner of desktop Browser profiles. */
export const browserProfiles = new BrowserProfiles();
