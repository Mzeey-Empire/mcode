import type { FastModeStatus, FastModeUnavailableReason } from "@mcode/contracts/models/fast-mode";

/** What the Fast control shows for the selected model: the user's choice, qualified by what the provider reports. */
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
  if (status?.modelId !== modelId) return choice;
  // The user's choice decides the speed; the status only says whether a chosen Fast can run, so it never flips Standard on.
  if (status.state === "off" && status.unavailable) return { kind: "unavailable", reason: status.unavailable };
  if (!chosen) return choice;
  if (status.state === "cooldown") return { kind: "cooling" };
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

/** The sentence explaining why Fast cannot be chosen, or null when it can. Cooling is temporary, so it never blocks. */
export function fastModeBlockedReason(view: FastModeView): string | null {
  return view.kind === "unavailable" ? FAST_MODE_UNAVAILABLE_COPY[view.reason] : null;
}
