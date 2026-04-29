/**
 * Manages one Cursor CLI `agent acp` subprocess with JSON-RPC over NDJSON stdio.
 *
 * Follows the handshake documented at https://cursor.com/docs/cli/acp.md — initialize,
 * authenticate, session/new (or session/load), then session/prompt for each turn.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "@mcode/shared";
import type { AgentEvent } from "@mcode/contracts";
import { CursorAcpRpcClient } from "./cursor-acp-rpc-client.js";
import { mapCursorAcpNotification, type CursorStreamAccumulator } from "./cursor-acp-event-mapper.js";

const execFileAsync = promisify(execFile);

/** Wall-clock timeout for a single `session/prompt` RPC (10 minutes). */
const PROMPT_RPC_TIMEOUT_MS = 10 * 60 * 1000;

/** Options for constructing a {@link CursorAcpSession}. */
export interface CursorAcpSessionOptions {
  /** Path to the Cursor Agent CLI (`cursor-agent`, `agent`, or absolute path). */
  cliPath: string;
  /** Working directory for tool execution (usually the workspace/worktree cwd). */
  cwd: string;
  /** When true, spawn with `--trust` so headless runs skip workspace trust prompts. */
  trustWorkspace: boolean;
  /** Optional Cursor chat/session id to resume via `session/load`. */
  resumeSessionId?: string | undefined;
  /** Mcode thread id (without `mcode-` prefix) used when emitting streaming events. */
  threadId: string;
  /**
   * Optional Cursor interaction mode. Possible values: "agent", "plan", "ask".
   * Undocumented in ACP protocol; passed to session/new as a probe.
   * If Cursor rejects it, the field is silently ignored on next attempt.
   */
  mode?: "agent" | "plan" | "ask" | undefined;
  /** Streams mapped agent events (text deltas, etc.). */
  onAgentEvent: (event: AgentEvent) => void;
  /**
   * Handles JSON-RPC server requests (`method` + numeric/string `id`) that expect a response.
   * Called for permission prompts and Cursor extension RPCs.
   */
  handleServerRequest: (msg: {
    id: number | string;
    method: string;
    params: unknown;
  }) => Promise<unknown>;
}

/**
 * One persistent Cursor ACP child process bound to a single mcode agent session.
 */
export class CursorAcpSession {
  private rpc: CursorAcpRpcClient | null = null;
  private child: ChildProcess | null = null;
  private killRequested = false;
  /** Cursor-assigned session id from `session/new` / `session/load`. */
  private acpSessionId: string | null = null;

  /** Public Cursor session id for persistence (`setSdkSessionId`). */
  public get cursorSessionId(): string | null {
    return this.acpSessionId;
  }

  constructor(private readonly opts: CursorAcpSessionOptions) {}

  /**
   * Spawns `agent acp`, completes the ACP handshake, and establishes `session/new`
   * or `session/load`.
   *
   * @throws When spawn fails or the handshake sequence errors.
   */
  async start(): Promise<void> {
    const { cliPath, cwd, trustWorkspace } = this.opts;
    const args = trustWorkspace ? ["--trust", "acp"] : ["acp"];

    const child = spawn(cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      cwd,
      env: { ...process.env },
    });

    const spawnError = await new Promise<Error | null>((resolve) => {
      child.once("error", (err) => resolve(err));
      child.once("spawn", () => resolve(null));
    });

    if (spawnError) {
      throw new Error(`Failed to spawn Cursor ACP: ${spawnError.message}`);
    }

    this.child = child;
    this.rpc = new CursorAcpRpcClient(child.stdin!, child.stdout!);

    this.rpc.on("serverRequest", (msg: Record<string, unknown>) => {
      void this.routeServerRequest(msg);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const line = chunk.toString().trim();
      if (line) logger.debug("Cursor ACP stderr", { line: line.slice(0, 500) });
    });

    child.once("exit", (code, signal) => {
      logger.warn("Cursor ACP process exited", { code, signal, cliPath });
      try {
        this.rpc?.dispose();
      } catch {
        /* ignore */
      }
    });

    try {
      await this.runHandshake();
    } catch (err) {
      await this.kill().catch(() => {});
      throw err;
    }
  }

  /**
   * Sends `session/prompt` and forwards streaming notifications via `onAgentEvent`.
   *
   * @param text - User message body (attachments should already be inlined).
   * @param model - Optional model id override when supported by Cursor CLI.
   */
  async sendPrompt(text: string, model?: string): Promise<{ assistantText: string }> {
    if (!this.rpc || !this.acpSessionId) {
      throw new Error("Cursor ACP session not initialized");
    }

    const acc: CursorStreamAccumulator = { assistantText: "", toolStartTimes: new Map() };

    const onNotification = (msg: unknown) => {
      const events = mapCursorAcpNotification(msg as Record<string, unknown>, this.opts.threadId, acc);
      for (const ev of events) {
        this.opts.onAgentEvent(ev);
      }
    };

    this.rpc.on("notification", onNotification);
    try {
      await this.rpc.sendRequest(
        "session/prompt",
        {
          sessionId: this.acpSessionId,
          prompt: [{ type: "text", text }],
          ...(model ? { model } : {}),
        },
        PROMPT_RPC_TIMEOUT_MS,
      );
    } finally {
      this.rpc.off("notification", onNotification);
    }

    return { assistantText: acc.assistantText };
  }

  /** Best-effort graceful shutdown followed by process termination. */
  async kill(): Promise<void> {
    if (this.killRequested) return;
    this.killRequested = true;

    const rpc = this.rpc;
    const sid = this.acpSessionId;
    const child = this.child;

    if (rpc && sid) {
      try {
        await rpc.sendRequest("session/cancel", { sessionId: sid }, 5000);
      } catch {
        /* ignore */
      }
      try {
        rpc.dispose();
      } catch {
        /* ignore */
      }
    } else if (rpc) {
      rpc.dispose();
    }

    this.rpc = null;
    this.acpSessionId = null;

    if (!child?.pid) return;

    if (process.platform === "win32") {
      try {
        await execFileAsync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { timeout: 5000 });
      } catch {
        /* process may already be gone */
      }
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }

    this.child = null;
  }

  private async routeServerRequest(msg: Record<string, unknown>): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) return;

    const idRaw = msg.id;
    if (typeof idRaw !== "number" && typeof idRaw !== "string") return;

    const method = String(msg.method ?? "");
    try {
      const result = await this.opts.handleServerRequest({
        id: idRaw,
        method,
        params: msg.params,
      });
      rpc.sendResponse(idRaw, result);
    } catch (err) {
      logger.error("Cursor ACP serverRequest handler threw", { method, error: String(err) });
      rpc.sendResponse(idRaw, { outcome: { outcome: "skipped", reason: String(err) } });
    }
  }

  private async runHandshake(): Promise<void> {
    const rpc = this.rpc!;
    const { cwd, resumeSessionId } = this.opts;

    await rpc.sendRequest(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "mcode", version: "0.7.0" },
      },
      60_000,
    );

    await rpc.sendRequest("authenticate", { methodId: "cursor_login" }, 120_000);

    if (resumeSessionId) {
      try {
        const loaded = await rpc.sendRequest<{ sessionId: string }, { sessionId?: string }>(
          "session/load",
          { sessionId: resumeSessionId },
          120_000,
        );
        this.acpSessionId = loaded?.sessionId ?? resumeSessionId;
        logger.info("Cursor ACP session/load succeeded", { sessionId: this.acpSessionId });
        return;
      } catch (err) {
        logger.warn("Cursor ACP session/load failed; starting fresh session", {
          resumeSessionId,
          error: String(err),
        });
      }
    }

    const sessionNewParams: Record<string, unknown> = {
      cwd,
      mcpServers: [],
    };
    if (this.opts.mode && this.opts.mode !== "agent") {
      sessionNewParams.mode = this.opts.mode;
    }

    const created = await rpc.sendRequest<
      Record<string, unknown>,
      { sessionId?: string }
    >(
      "session/new",
      sessionNewParams,
      120_000,
    );

    const sid = created?.sessionId;
    if (!sid) {
      throw new Error("Cursor ACP session/new returned no sessionId");
    }
    this.acpSessionId = sid;
    logger.info("Cursor ACP session/new established", {
      sessionId: sid,
      modeRequested: this.opts.mode ?? "agent",
    });
  }
}
