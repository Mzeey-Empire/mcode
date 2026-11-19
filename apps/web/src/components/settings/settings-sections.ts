/** Settings page ids in sidebar order. Kept apart from the page list so the app shell can validate an id without loading every page. */
export const SETTINGS_SECTIONS = [
  "general",
  "threads",
  "providers",
  "terminal",
  "keyboard",
  "troubleshooting",
  "about",
] as const;

/** Available settings pages in the app. */
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** True when `value` names a settings page; untrusted event payloads pass through this. */
export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}
