/**
 * Authorizes one Read of an exact file path for one turn, such as the plan file
 * supplied to an implementation turn. Other paths and repeated reads follow
 * the normal permission flow. The turn owner clears unused grants on completion.
 */
import * as NodePath from "node:path";
import { inject, injectable } from "tsyringe";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";

interface ScopedGrant {
  /** Tool the grant authorises (always "Read" today). */
  toolName: string;
  /** The single absolute path authorised, resolved for stable comparison. */
  resolvedPath: string;
  /** One-shot latch: set on first successful consume. */
  used: boolean;
}

/** Normalise a path so grant issuance and consumption compare equal. */
function normalizePath(p: string, platform: NodeJS.Platform): string {
  // resolve() collapses separators and `.`/`..`; lower-case the drive/letters
  // on Windows where the filesystem is case-insensitive.
  const resolved = NodePath.resolve(p);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

@injectable()
export class ScopedPreGrantService {
  /** threadId -> active grants for that thread's current granted Turn. */
  private readonly grantsByThread = new Map<string, ScopedGrant[]>();

  constructor(@inject("HostRuntime") private readonly hostRuntime?: HostRuntime) {}

  /**
   * Authorise a one-shot Read of `path` on `threadId`'s next Turn. Call
   * {@link clear} when that Turn ends to enforce Turn-scoping.
   */
  issue(args: { threadId: string; toolName: string; path: string }): void {
    const list = this.grantsByThread.get(args.threadId) ?? [];
    list.push({ toolName: args.toolName, resolvedPath: normalizePath(args.path, this.platform()), used: false });
    this.grantsByThread.set(args.threadId, list);
  }

  /**
   * Try to consume a grant for a tool call. Returns true (and latches the grant
   * used) only when an UNUSED grant for this thread matches the tool name and
   * the exact resolved path. Path-scoped, one-shot.
   */
  tryConsume(args: { threadId: string; toolName: string; path: string }): boolean {
    const list = this.grantsByThread.get(args.threadId);
    if (!list || list.length === 0) return false;
    const target = normalizePath(args.path, this.platform());
    const grant = list.find(
      (g) => !g.used && g.toolName === args.toolName && g.resolvedPath === target,
    );
    if (!grant) return false;
    grant.used = true; // one-shot
    return true;
  }

  /** Turn-scoped cleanup: drop every grant for a thread when its granted Turn ends. */
  clear(threadId: string): void {
    this.grantsByThread.delete(threadId);
  }

  /** Whether a thread currently has any unused grant (diagnostics/tests). */
  hasActiveGrant(threadId: string): boolean {
    return (this.grantsByThread.get(threadId) ?? []).some((g) => !g.used);
  }

  private platform(): NodeJS.Platform {
    if (this.hostRuntime) return this.hostRuntime.platform;
    throw new Error("Scoped pre-grant platform is required");
  }
}
