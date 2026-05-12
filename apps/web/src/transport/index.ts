import type { McodeTransport } from "./types";
import { createWsTransport } from "./ws-transport";
import { ipcPushClient } from "./ipc-push-client";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { scanPortRange, AUTH_TOKEN_STORAGE_KEY } from "./scan-port-range";
import { useProviderModelsStore } from "@/stores/providerModelsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";

/** Re-exported transport and domain types for use across the web app. */
export type { McodeTransport, Workspace, Thread, Message, ToolCall, HookExecution, GitBranch, WorktreeInfo, PermissionMode, InteractionMode, AttachmentMeta, StoredAttachment, SkillInfo, PrInfo, PrDetail, ToolCallRecord, Settings, PartialSettings, PlanAnswer } from "./types";
export { PERMISSION_MODES, INTERACTION_MODES } from "./types";
export { pushEmitter } from "./ws-transport";

/** Default server URL when running standalone (no Electron shell). */
const DEFAULT_SERVER_URL = "ws://localhost:19400";

/** How long to wait for the WebSocket to connect before giving up. */
const CONNECT_TIMEOUT_MS = 5000;

let transport: (McodeTransport & { close(): void; waitForConnection(timeoutMs: number): Promise<void> }) | null = null;

/**
 * Resolve the WebSocket server URL and IPC path.
 *
 * In Electron, `window.desktopBridge.getServerUrl()` returns the URL and IPC
 * path of the server spawned by the main process. Retries the IPC call to
 * avoid falling back to the standalone port when the production app is also
 * running. In standalone / dev mode we fall back to an environment variable
 * or the default localhost URL.
 */
async function resolveServerUrl(): Promise<{ url: string; ipcPath: string }> {
  if (window.desktopBridge?.getServerUrl) {
    // Retry the IPC call a few times; during shell refresh the handler may
    // not be ready on the first attempt. Without retries the renderer falls
    // through to DEFAULT_SERVER_URL (port 19400) and connects to the
    // production server instead of the dev server.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await window.desktopBridge.getServerUrl();
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  // Vite injects env vars prefixed with VITE_
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envUrl = (import.meta as any).env?.VITE_SERVER_URL as string | undefined;

  return { url: envUrl || DEFAULT_SERVER_URL, ipcPath: "" };
}

let initPromise: Promise<McodeTransport> | null = null;

/**
 * Initialize the WebSocket transport. Resolves the server URL once and
 * creates a persistent connection. Subsequent calls return the same instance.
 */
export async function initTransport(): Promise<McodeTransport> {
  if (transport) return transport;
  if (initPromise) return initPromise;

  initPromise = resolveServerUrl().then(async ({ url, ipcPath }) => {
    // Persist the auth token from the initial URL so browser-mode reconnects
    // can re-discover the server with a valid token after a restart.
    try {
      const parsedUrl = new URL(url, "http://localhost");
      const token = parsedUrl.searchParams.get("token");
      if (token) localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    } catch { /* ignore parse errors */ }

    transport = createWsTransport(url, {
      onStatusChange: (status) => {
        useConnectionStore.getState().setStatus(status);
        // Re-fetch settings on reconnect so stale state from a server restart
        // is replaced with the latest values.
        if (status === "connected") {
          void useSettingsStore.getState().fetch();
          void useProviderModelsStore.getState().initialize();
          void useProviderAvailabilityStore.getState().fetch();
        }
      },
      discoverServerUrl: async () => {
        // In Electron, retry the desktop bridge IPC to get the server URL
        // from the main process. Avoid falling through to the port scan
        // which can find a production server running on a different port.
        if (window.desktopBridge?.getServerUrl) {
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              const info = await window.desktopBridge.getServerUrl();
              return info.url;
            } catch {
              await new Promise((r) => setTimeout(r, 300));
            }
          }
          throw new Error("Desktop bridge IPC failed after retries");
        }
        // In browser (no Electron shell), scan the port range. Use the
        // last-known token from localStorage so the reconnect URL includes
        // valid auth.
        const savedToken = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ?? "";
        const found = await scanPortRange(19400, 19800, savedToken);
        if (found) return found;
        throw new Error("Server not found");
      },
    });

    // Connect IPC fast path if available
    if (ipcPath) {
      ipcPushClient.connect();
    }

    try {
      await transport.waitForConnection(CONNECT_TIMEOUT_MS);
    } catch (err) {
      transport.close();
      transport = null;
      initPromise = null;
      throw err;
    }
    return transport;
  });

  return initPromise;
}

/**
 * Return the transport instance synchronously.
 *
 * Throws if `initTransport()` has not been called and resolved yet.
 * This preserves the existing call-site contract where stores and
 * components call `getTransport()` without awaiting.
 */
export function getTransport(): McodeTransport {
  if (!transport) {
    throw new Error(
      "Transport not initialized. Call initTransport() at app startup before accessing getTransport().",
    );
  }
  return transport;
}
