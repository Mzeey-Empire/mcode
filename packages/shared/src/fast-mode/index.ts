import type { Settings } from "@mcode/contracts/models/settings";

/** Providers whose settings carry a global Fast default at `provider.<id>.fastMode`. */
export type FastModeSettingProvider = "claude" | "codex";

/** Narrows a provider id to one with a Fast setting, or null when the provider has none. */
export function fastModeSettingProvider(providerId: string): FastModeSettingProvider | null {
  return providerId === "claude" || providerId === "codex" ? providerId : null;
}

/** Returns the provider's global Fast choice, defaulting to standard. */
export function fastModeDefault(settings: Settings, providerId: string): boolean {
  const provider = fastModeSettingProvider(providerId);
  return provider === null ? false : settings.provider[provider].fastMode;
}
