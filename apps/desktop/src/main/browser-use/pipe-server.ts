/**
 * Codex browser-use pipe server: accepts JSON-RPC 2.0 over a length-prefixed
 * frame protocol on a Windows named pipe or POSIX UNIX socket.
 *
 * Wire format is the dpcode `browserUsePipeServer.ts` format unchanged, so an
 * unmodified Codex CLI (or any client expecting that bridge) connects without
 * configuration beyond the pipe path env var.
 */

import * as Net from "node:net";
import * as Path from "node:path";
import * as FS from "node:fs";
import { tmpdir } from "node:os";
import { logger } from "@mcode/shared";
import {
  MCODE_BROWSER_USE_PIPE_ENV,
  DPCODE_BROWSER_USE_PIPE_ENV,
  T3CODE_BROWSER_USE_PIPE_ENV,
} from "@mcode/contracts";
import { decodeFrames, encodeFrame } from "./framing.js";
import {
  createPipeSessionState,
  handleRpcRequest,
  type RouterDeps,
} from "./router.js";
import { TabIdMap } from "./tab-id-map.js";
import type { BrowserHostBridge, BrowserHostSnapshot } from "./host-bridge.js";

const PIPE_DIR = "codex-browser-use";
const PIPE_NAME_PREFIX = "mcode-iab";

/** Resolve the default pipe path for the current platform / pid. */
export function resolveDefaultPipePath(
  platform: NodeJS.Platform = process.platform,
  pid: number = process.pid,
): string {
  if (platform === "win32") {
    return String.raw`\\.\pipe\codex-browser-use-${PIPE_NAME_PREFIX}-${pid}`;
  }
  return Path.join(tmpdir(), PIPE_DIR, `${PIPE_NAME_PREFIX}-${pid}.sock`);
}

/** Pick the pipe path from env (priority: MCODE -> DPCODE -> T3CODE) or default. */
export function resolveConfiguredPipePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  pid: number = process.pid,
): string {
  const configured =
    env[MCODE_BROWSER_USE_PIPE_ENV]?.trim() ||
    env[DPCODE_BROWSER_USE_PIPE_ENV]?.trim() ||
    env[T3CODE_BROWSER_USE_PIPE_ENV]?.trim();
  return configured || resolveDefaultPipePath(platform, pid);
}

export interface PipeServerOptions {
  readonly pipePath?: string;
  readonly appVersion: string;
  readonly host: BrowserHostBridge;
  /** Called when a method needs the IAB panel open and no snapshot is live. */
  readonly ensurePanelOpen?: () => Promise<BrowserHostSnapshot | null>;
}

export class BrowserUsePipeServer {
  private readonly server: Net.Server;
  private readonly sockets = new Set<Net.Socket>();
  private readonly pendingBySocket = new Map<Net.Socket, Buffer>();
  private readonly tabIds = new TabIdMap();
  private readonly state = createPipeSessionState();
  private readonly host: BrowserHostBridge;
  private readonly pipePath: string;
  private readonly appVersion: string;
  private readonly ensurePanelOpen: () => Promise<BrowserHostSnapshot | null>;
  private started = false;

  constructor(opts: PipeServerOptions) {
    this.host = opts.host;
    this.appVersion = opts.appVersion;
    this.ensurePanelOpen = opts.ensurePanelOpen ?? (async () => null);
    this.pipePath = opts.pipePath ?? resolveConfiguredPipePath();
    this.server = Net.createServer((socket) => this.onConnection(socket));
  }

  get path(): string {
    return this.pipePath;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.ensureParentDir();
    this.cleanupStaleSocket();
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => {
        this.server.off("error", onErr);
        reject(err);
      };
      this.server.once("error", onErr);
      this.server.listen(this.pipePath, () => {
        this.server.off("error", onErr);
        // Lock down POSIX socket to owner-only.
        if (process.platform !== "win32") {
          try {
            FS.chmodSync(this.pipePath, 0o600);
          } catch (err) {
            logger.warn("browser-use: chmod 0600 failed", { err: String(err) });
          }
        }
        resolve();
      });
    });
    this.started = true;
    logger.info("browser-use: pipe server started", { path: this.pipePath });
  }

  async dispose(): Promise<void> {
    // Drop active CDP subscriptions before closing sockets so listeners don't
    // fire onto destroyed transports.
    for (const dispose of this.state.cdpListenerDisposeBySessionId.values()) {
      dispose();
    }
    this.state.cdpListenerDisposeBySessionId.clear();

    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.pendingBySocket.clear();

    if (this.started) {
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
      this.started = false;
    }
    this.cleanupStaleSocket();
  }

  private ensureParentDir(): void {
    if (process.platform === "win32") return;
    FS.mkdirSync(Path.dirname(this.pipePath), { recursive: true });
  }

  private cleanupStaleSocket(): void {
    if (process.platform === "win32") return;
    try {
      const stat = FS.lstatSync(this.pipePath);
      if (!stat.isSocket() && !stat.isFile()) return;
      FS.unlinkSync(this.pipePath);
    } catch {
      /* nothing to clean */
    }
  }

  private onConnection(socket: Net.Socket): void {
    this.sockets.add(socket);
    this.pendingBySocket.set(socket, Buffer.alloc(0));
    socket.on("data", (chunk) => this.onData(socket, chunk));
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.pendingBySocket.delete(socket);
    });
    socket.on("error", () => {
      this.sockets.delete(socket);
      this.pendingBySocket.delete(socket);
      socket.destroy();
    });
  }

  private onData(socket: Net.Socket, chunk: Buffer): void {
    const decoded = decodeFrames(
      Buffer.concat([this.pendingBySocket.get(socket) ?? Buffer.alloc(0), chunk]),
    );
    if (!decoded) {
      this.pendingBySocket.delete(socket);
      socket.destroy();
      return;
    }
    this.pendingBySocket.set(socket, decoded.remaining);
    for (const message of decoded.messages) {
      void this.onMessage(socket, message);
    }
  }

  private async onMessage(socket: Net.Socket, raw: string): Promise<void> {
    let request: { id?: unknown; method?: unknown; params?: unknown };
    try {
      request = JSON.parse(raw) as typeof request;
    } catch {
      return;
    }
    if (request.id === undefined || typeof request.method !== "string") return;

    const deps: RouterDeps = {
      host: this.host,
      tabIds: this.tabIds,
      state: this.state,
      broadcast: (notification) => this.broadcast(notification),
      ensurePanelOpen: this.ensurePanelOpen,
      appVersion: this.appVersion,
    };

    try {
      const result = await handleRpcRequest(deps, request.method, request.params);
      socket.write(encodeFrame({ jsonrpc: "2.0", id: request.id, result }));
    } catch (err) {
      socket.write(
        encodeFrame({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: 1,
            message: err instanceof Error ? err.message : String(err),
          },
        }),
      );
    }
  }

  private broadcast(notification: { method: string; params: unknown }): void {
    const frame = encodeFrame({ jsonrpc: "2.0", ...notification });
    for (const socket of this.sockets) {
      if (!socket.destroyed) socket.write(frame);
    }
  }
}
