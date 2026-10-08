import type { ProviderId } from "@mcode/contracts";

/** Why the thread's provider cannot run: disabled in settings, or its CLI binary was not found. */
export type ProviderUnavailableReason = "disabled" | "cli_missing";

const NAMES: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "GitHub Copilot",
  gemini: "Gemini",
  cursor: "Cursor",
  opencode: "OpenCode",
  devin: "Devin",
};

/** Explains why the provider is unusable and where to fix it. */
export function providerUnavailableMessage(providerId: ProviderId, reason: ProviderUnavailableReason): string {
  const name = NAMES[providerId];
  return reason === "disabled"
    ? `${name} is disabled. Enable it in Settings, or branch this thread to another provider.`
    : `${name} CLI was not found. Install it or set the path in Settings.`;
}
