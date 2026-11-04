import type * as NodeHTTP from "node:http";

/** Names the kind of client that sent a request, for diagnostics records; never a person or a secret. */
export function requestClient(req: NodeHTTP.IncomingMessage): string {
  const userAgent = req.headers["user-agent"] ?? "";
  if (userAgent.includes("Electron/")) return "desktop";
  if (req.headers.origin !== undefined) return "browser";
  return userAgent.trim().split(/\s+/, 1)[0]?.slice(0, 40) || "unknown";
}
