/**
 * JSON-RPC 2.0 NDJSON client for Cursor CLI `agent acp` (ACP) stdio transport.
 *
 * Mirrors {@link CodexRpcClient} but tolerates string JSON-RPC `id` values on
 * responses so future Cursor CLI versions remain compatible.
 */

import { EventEmitter } from "events";
import type { Writable, Readable } from "stream";
import { logger } from "@mcode/shared";

/** Default timeout for outbound RPC requests to the Cursor ACP server. */
const DEFAULT_TIMEOUT_MS = 20_000;

interface PendingRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function requestKey(id: number | string): string {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

/**
 * NDJSON JSON-RPC client for Cursor `agent acp` stdout/stdin.
 *
 * Emits `notification` for server pushes without `id`, and `serverRequest` for
 * server-initiated requests that expect a JSON-RPC response via {@link sendResponse}.
 */
export class CursorAcpRpcClient extends EventEmitter {
  private readonly stdin: Writable;
  private readonly stdout: Readable;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private disposed = false;
  private lineBuffer = "";

  private readonly onData: (chunk: string) => void;
  private readonly onClose: () => void;
  private readonly onError: (err: Error) => void;
  private readonly onStdinError: (err: Error) => void;
  private readonly onStdinClose: () => void;

  /**
   * @param stdin - Writable stream connected to the Cursor ACP process stdin.
   * @param stdout - Readable stream connected to the Cursor ACP process stdout.
   */
  constructor(stdin: Writable, stdout: Readable) {
    super();
    this.stdin = stdin;
    this.stdout = stdout;

    this.onData = (chunk: string) => {
      this.lineBuffer += chunk;
      const lines = this.lineBuffer.split("\n");
      this.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        this.processLine(line);
      }
    };

    this.onClose = () => {
      this.flushTrailingStdoutBuffer();
      this.disposed = true;
      this.rejectAll(new Error("Stream closed while waiting for response"));
    };

    this.onError = (err: Error) => {
      logger.error("CursorAcpRpcClient: stdout stream error", { err });
      this.flushTrailingStdoutBuffer();
      this.disposed = true;
      this.rejectAll(new Error(`Stream error: ${err.message}`));
    };

    this.onStdinError = (err: Error) => {
      logger.error("CursorAcpRpcClient: stdin stream error", { err });
      this.disposed = true;
      this.rejectAll(new Error(`stdin error: ${err.message}`));
    };

    this.onStdinClose = () => {
      logger.warn("CursorAcpRpcClient: stdin stream closed");
      this.disposed = true;
      this.rejectAll(new Error("stdin closed while requests pending"));
    };

    this.stdout.setEncoding("utf8");
    this.stdout.on("data", this.onData);
    this.stdout.on("close", this.onClose);
    this.stdout.on("end", this.onClose);
    this.stdout.on("error", this.onError);

    this.stdin.on("error", this.onStdinError);
    this.stdin.on("close", this.onStdinClose);
  }

  /**
   * Sends a JSON-RPC request and resolves with the server's `result` payload.
   *
   * @param timeoutMs - Milliseconds before rejecting the pending request.
   */
  sendRequest<TParams, TResult>(
    method: string,
    params: TParams,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<TResult> {
    if (this.disposed) {
      return Promise.reject(new Error("RPC client is disposed"));
    }

    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestKey(id));
        reject(new Error(`Timed out waiting for ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(requestKey(id), { resolve, reject, timer });
      this.stdin.write(message, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(requestKey(id));
          reject(new Error(`stdin write failed for ${method}: ${err.message}`));
        }
      });
    });
  }

  /** Sends a JSON-RPC notification (no response expected). */
  sendNotification(method: string, params?: unknown): void {
    if (this.disposed) {
      logger.warn("CursorAcpRpcClient: sendNotification called on disposed client", { method });
      return;
    }
    const message = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.stdin.write(message, (err) => {
      if (err) logger.warn("CursorAcpRpcClient: notification write failed", { method, error: err.message });
    });
  }

  /**
   * Sends a JSON-RPC response for a server-initiated request (`method` + `id`).
   *
   * @param id - Request id from the server message (numeric or string).
   */
  sendResponse(id: number | string, result: unknown): void {
    if (this.disposed) {
      logger.warn("CursorAcpRpcClient: sendResponse called on disposed client", { id });
      return;
    }
    const message = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
    this.stdin.write(message, (err) => {
      if (err) logger.warn("CursorAcpRpcClient: response write failed", { id, error: err.message });
    });
  }

  /** Disposes the client and rejects any pending outbound requests. */
  dispose(): void {
    if (this.disposed) return;
    this.flushTrailingStdoutBuffer();
    this.disposed = true;

    this.stdout.off("data", this.onData);
    this.stdout.off("close", this.onClose);
    this.stdout.off("end", this.onClose);
    this.stdout.off("error", this.onError);

    this.stdin.off("error", this.onStdinError);
    this.stdin.off("close", this.onStdinClose);

    this.rejectAll(new Error("RPC client disposed"));
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logger.warn("CursorAcpRpcClient: malformed JSON line", { byteLength: trimmed.length });
      return;
    }

    const hasMethod = typeof msg["method"] === "string";
    const idRaw = msg["id"];
    const hasId = idRaw !== undefined && idRaw !== null;

    // Response to one of our outbound requests (has id, no method)
    if (hasId && !hasMethod) {
      const id =
        typeof idRaw === "number" || typeof idRaw === "string"
          ? idRaw
          : null;
      if (id === null) {
        logger.warn("CursorAcpRpcClient: unsupported id type on response", { idRaw });
        return;
      }

      const entry = this.pending.get(requestKey(id));
      if (!entry) {
        logger.warn("CursorAcpRpcClient: received response for unknown id", { id });
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(requestKey(id));

      const error = msg["error"] as { message?: string } | undefined;
      if (error) {
        entry.reject(new Error(error.message ?? "RPC error"));
      } else {
        entry.resolve(msg["result"]);
      }
      return;
    }

    // Server-initiated request that expects a JSON-RPC response
    if (hasId && hasMethod) {
      this.emit("serverRequest", msg);
      return;
    }

    // Server notification (no id)
    if (hasMethod && !hasId) {
      this.emit("notification", msg);
      return;
    }

    logger.warn("CursorAcpRpcClient: unrecognized message", {
      hasId,
      hasMethod,
      idType: typeof idRaw,
      method: typeof msg["method"] === "string" ? msg["method"] : undefined,
    });
  }

  /** Parses any final NDJSON line buffered without a trailing newline before tearing down streams. */
  private flushTrailingStdoutBuffer(): void {
    const trailing = this.lineBuffer.trim();
    if (!trailing) return;
    this.lineBuffer = "";
    this.processLine(trailing);
  }

  private rejectAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
