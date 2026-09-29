/**
 * IPC push relay - connects a Node.js net.Socket to the server's IPC pipe
 * and forwards length-prefixed frames to the renderer via webContents.send.
 *
 * The main process owns the socket because the preload runs in a sandbox
 * that does not have access to the Node.js `net` module.
 */

import * as NodeNet from "node:net";

/** Maximum permitted frame body size (8 MiB). Frames larger than this indicate
 *  a corrupt or malicious length prefix; the socket is destroyed immediately. */
const MAX_FRAME_SIZE = 8 * 1024 * 1024;

/** Reconnect backoff bounds. A dropped relay silently degraded the renderer to
 *  the WebSocket path forever before this existed. */
const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 15_000;

/** Minimal subset of BrowserWindow required by the relay. */
interface RelayWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

/**
 * Connect to the server's IPC push endpoint and forward parsed frames
 * to the renderer via `webContents.send("ipc-push-message", data)`.
 *
 * Wire format: each frame is a 4-byte big-endian length prefix followed by
 * the UTF-8 encoded JSON body.
 *
 * On socket close the renderer is told to fall back to WebSocket and the
 * relay reconnects with exponential backoff. The renderer re-suppresses
 * channels as frames resume, so no reconnect handshake is required.
 *
 * @returns A cleanup function. Call it when the window closes to destroy
 *   the socket and prevent a named-pipe handle leak on Windows.
 */
export function startIpcRelay(ipcPath: string, window: RelayWindow): () => void {
  if (!ipcPath) return () => { /* no-op: no socket was opened */ };

  let stopped = false;
  let socket: NodeNet.Socket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectDelay = MIN_RECONNECT_MS;

  const windowAlive = () => !window.isDestroyed() && !window.webContents.isDestroyed();

  const connect = (): void => {
    if (stopped || !windowAlive()) return;
    const current = NodeNet.connect(ipcPath);
    socket = current;
    const chunks: Buffer[] = [];
    let totalLen = 0;

    current.on("connect", () => {
      reconnectDelay = MIN_RECONNECT_MS;
    });

    current.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      totalLen += chunk.length;

      // Avoid concat overhead when only one chunk is buffered.
      let buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalLen);
      chunks.length = 0;
      totalLen = 0;

      while (buffer.length >= 4) {
        const frameLen = buffer.readUInt32BE(0);
        if (frameLen > MAX_FRAME_SIZE) {
          current.destroy();
          return;
        }
        if (buffer.length < 4 + frameLen) break;

        const json = buffer.subarray(4, 4 + frameLen).toString("utf-8");
        buffer = buffer.subarray(4 + frameLen);

        try {
          const data = JSON.parse(json) as unknown;
          if (windowAlive()) {
            window.webContents.send("ipc-push-message", data);
          }
        } catch { /* malformed frame - skip */ }
      }

      // Retain leftover bytes for the next data event.
      if (buffer.length > 0) {
        chunks.push(buffer);
        totalLen = buffer.length;
      }
    });

    current.on("error", () => current.destroy());
    current.on("close", () => {
      if (socket === current) socket = null;
      if (stopped || !windowAlive()) return;
      window.webContents.send("ipc-push-disconnect");
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
    });
  };

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.destroy();
  };
}
