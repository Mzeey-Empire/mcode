import type { FastModeStatus, FastModeUnavailableReason } from "@mcode/contracts/models/fast-mode";

/** What the Fast control shows for the selected model: the user's choice, overridden by what the provider reports. */
export type FastModeView =
  | { kind: "absent" }
  | { kind: "off" }
  | { kind: "on" }
  | { kind: "cooling" }
  | { kind: "unavailable"; reason: FastModeUnavailableReason };

/** Inputs to {@link fastModeView}. */
export interface FastModeViewInput {
  supported: boolean;
  chosen: boolean;
  status: FastModeStatus | undefined;
  modelId: string;
}

/** Derives the Fast view from model support, the user's choice, and the thread's last reported status. */
export function fastModeView({ supported, chosen, status, modelId }: FastModeViewInput): FastModeView {
  if (!supported) return { kind: "absent" };
  const choice: FastModeView = chosen ? { kind: "on" } : { kind: "off" };
  // A status describes the model that ran, so it says nothing about a model picked since.
  if (status?.modelId !== modelId) return choice;
  if (status.state === "on") return { kind: "on" };
  if (status.state === "cooldown") return { kind: "cooling" };
  if (status.unavailable) return { kind: "unavailable", reason: status.unavailable };
  // Claude reports plain off whenever Mcode sent `fastMode: false`, so it is no block on the user's choice.
  return choice;
}

/** Why Fast cannot run, one sentence per provider-reported reason. */
export const FAST_MODE_UNAVAILABLE_COPY: Readonly<Record<FastModeUnavailableReason, string>> = {
  plan: "Your plan does not include Fast.",
  extra_usage: "Fast needs extra usage turned on.",
  provider_route: "Fast needs a direct Anthropic account.",
  environment: "An environment variable turns Fast off.",
  model: "This model cannot run Fast on your account.",
  unreachable: "Could not check Fast availability.",
  unknown: "Fast is unavailable right now.",
};

/** Shown on the Fast option while the provider cools Fast down. */
export const FAST_MODE_COOLING_COPY = "Fast is cooling down.";

/** The sentence explaining why Fast cannot be chosen, or null when it can. */
export function fastModeBlockedReason(view: FastModeView): string | null {
  if (view.kind === "cooling") return FAST_MODE_COOLING_COPY;
  if (view.kind === "unavailable") return FAST_MODE_UNAVAILABLE_COPY[view.reason];
  return null;
}
