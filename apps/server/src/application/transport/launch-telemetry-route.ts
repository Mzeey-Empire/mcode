import type * as NodeHTTP from "node:http";
import { z } from "zod";
import type { ServerLaunchTelemetry } from "@mcode/contracts/launch-telemetry";
import { extractToken, matchesAuthToken } from "./auth.js";
import { launchTelemetry } from "../../runtime/diagnostics/launch-telemetry.js";

const UsableAtSchema = z.coerce.number().finite().positive();

/**
 * Serves the authenticated, single-delivery launch observation window. `?usableAt=<epoch ms>` holds the response
 * until the window closes after the usable frame; without it the window closes on the next tick.
 */
export function handleLaunchTelemetryRequest(
  req: NodeHTTP.IncomingMessage,
  res: NodeHTTP.ServerResponse,
  authToken: string,
  recorder = launchTelemetry,
): boolean {
  if (req.method !== "GET") return false;
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/__mcode/launch-telemetry") return false;
  const answer = launchTelemetryAnswer(req, url, authToken, recorder);
  if (typeof answer === "number") {
    res.writeHead(answer);
    res.end(answer === 401 ? "Unauthorized" : undefined);
    return true;
  }
  void answer.then((snapshot) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snapshot));
  });
  return true;
}

function launchTelemetryAnswer(
  req: NodeHTTP.IncomingMessage,
  url: URL,
  authToken: string,
  recorder: typeof launchTelemetry,
): number | Promise<ServerLaunchTelemetry> {
  if (!matchesAuthToken(extractToken(req), authToken)) return 401;
  if (recorder.phase === "disabled") return 404;
  const usableAtParam = url.searchParams.get("usableAt");
  const usableAt = usableAtParam === null ? undefined : UsableAtSchema.safeParse(usableAtParam);
  if (usableAt && !usableAt.success) return 400;
  return recorder.close(usableAt?.data) ?? 410;
}
