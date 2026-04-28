/**
 * Maps mcode {@link PermissionDecision} values to Cursor ACP permission responses.
 *
 * Shape follows Cursor's minimal ACP examples (`outcome.selected.optionId`).
 */

import type { PermissionDecision } from "@mcode/contracts";

/**
 * Builds the JSON-RPC `result` payload for a `session/request_permission` request.
 *
 * @param decision - User decision from the permission card UI.
 */
export function mapCursorPermissionRpcResult(decision: PermissionDecision): unknown {
  const selected = (optionId: "allow-once" | "allow-always" | "reject-once") =>
    ({ outcome: { outcome: "selected" as const, optionId } });

  switch (decision) {
    case "allow":
      return selected("allow-once");
    case "allow-session":
      return selected("allow-always");
    case "deny":
    case "cancelled":
      return selected("reject-once");
  }
}

/** Safe fallback when the permission payload cannot be bridged deterministically. */
export function cursorPermissionDenyFallback(): unknown {
  return mapCursorPermissionRpcResult("deny");
}
