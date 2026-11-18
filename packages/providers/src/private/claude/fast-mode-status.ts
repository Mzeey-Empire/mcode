import type { FastModeStatus } from "@mcode/contracts/models/fast-mode";

const REASONS = new Map<string, NonNullable<Extract<FastModeStatus, { state: "off" }>["unavailable"]>>([
  ["free", "plan"], ["extra_usage_disabled", "extra_usage"], ["not_first_party", "provider_route"],
  ["disabled_by_env", "environment"], ["model_not_allowed", "model"], ["network_error", "unreachable"],
]);
const NORMAL_OFF = new Set(["sdk_opt_in_required", "preference", "pending"]);

/** Reads Fast state from Claude initialization and result messages. */
export function parseClaudeFastModeStatus(message: Record<string, unknown>, modelId: string): FastModeStatus | undefined {
  if (message.type !== "result" && !(message.type === "system" && message.subtype === "init")) return undefined;
  const state = message.fast_mode_state;
  if (state === "on" || state === "cooldown") return { state, modelId };
  if (state !== "off") return undefined;
  const reason = message.fast_mode_disabled_reason;
  if (typeof reason !== "string" || NORMAL_OFF.has(reason)) return { state, modelId };
  return { state, modelId, unavailable: REASONS.get(reason) ?? "unknown" };
}
