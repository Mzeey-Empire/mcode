import type { Settings } from "@mcode/contracts/models/settings";
import type { ProviderId } from "@mcode/contracts/providers/interfaces";

/** Returns the provider's global Fast choice, defaulting to standard. */
export function fastModeDefault(settings: Settings, providerId: ProviderId): boolean {
  if (providerId === "claude") return settings.provider.claude.fastMode;
  if (providerId === "codex") return settings.provider.codex.fastMode;
  return false;
}
