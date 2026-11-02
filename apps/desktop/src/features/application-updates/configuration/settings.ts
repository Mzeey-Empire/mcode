import { app } from "electron";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { getMcodeDir } from "@mcode/shared";
import { isNightlyVersion } from "@mcode/contracts/build-stage";
import { SettingsSchema as BundledSettingsSchema } from "@mcode/contracts/models/settings";

/** Use the snapshot-provided schema when V8 has already initialized contracts. */
const SettingsSchema =
  globalThis.__v8Snapshot?.contracts?.SettingsSchema ?? BundledSettingsSchema;

/** Release line used to select the updater feed. */
export type ReleaseLine = "stable" | "nightly";

/** Validated settings consumed by the update lifecycle. */
export interface UpdaterSettings {
  /** Stable follows tagged releases; nightly follows the CI prerelease channel. */
  releaseLine: ReleaseLine;
  autoDownload: boolean;
  autoInstallOnQuit: boolean;
  checkInterval: string;
}

/** Reads the validated settings used by one Application Updates instance. */
export type UpdaterSettingsReader = () => UpdaterSettings;

const INTERVAL_MS_MAP: Record<string, number> = {
  "15min": 15 * 60 * 1000,
  "1hour": 60 * 60 * 1000,
  "4hours": 4 * 60 * 60 * 1000,
  "1day": 24 * 60 * 60 * 1000,
  never: Infinity,
};

/** Read validated updater settings and apply the existing packaged defaults. */
export function loadUpdaterSettings(
  applicationVersion = app.getVersion(),
): UpdaterSettings {
  const defaults = updaterSettingsDefaults(applicationVersion);
  return readPersistedUpdaterSettings(defaults) ?? defaults;
}

/** Return the packaged defaults for the current release line. */
function updaterSettingsDefaults(applicationVersion: string): UpdaterSettings {
  return {
    releaseLine: isNightlyVersion(applicationVersion) ? "nightly" : "stable",
    autoDownload: true,
    autoInstallOnQuit: true,
    checkInterval: "4hours",
  };
}

function readPersistedUpdaterSettings(defaults: UpdaterSettings): UpdaterSettings | null {
  const persisted = readPersistedSettings();
  if (!persisted) return null;
  return mergeUpdaterSettings(persisted.parsed, persisted.settings.updates, defaults);
}

/** Settings file contents: the raw JSON and its schema-validated form with defaults. */
export interface PersistedSettings {
  /** Raw JSON, for callers that must tell an explicit value from a schema default. */
  parsed: unknown;
  settings: ReturnType<typeof SettingsSchema>["_output"];
}

/**
 * Synchronously read and validate `settings.json` from the Mcode data directory.
 * Returns null when the file is missing, malformed, or invalid.
 * Missing files are silent; other read or validation failures emit a diagnostic.
 */
export function readPersistedSettings(): PersistedSettings | null {
  try {
    const raw = NodeFS.readFileSync(NodePath.join(getMcodeDir(), "settings.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const result = SettingsSchema().safeParse(parsed);
    if (result.success) return { parsed, settings: result.data };
    console.warn("[settings] settings.json failed validation, using defaults");
  } catch (err) {
    logSettingsReadFailure(err);
  }
  return null;
}

/** Merge schema defaults with packaged defaults that depend on the application version. */
function mergeUpdaterSettings(
  parsed: unknown,
  updates: PersistedSettings["settings"]["updates"],
  defaults: UpdaterSettings,
): UpdaterSettings {
  const explicitChannel = (parsed as { updates?: { channel?: string } }).updates?.channel;
  return {
    releaseLine: explicitChannel ? (updates.channel as ReleaseLine) : defaults.releaseLine,
    autoDownload: updates?.autoDownload ?? defaults.autoDownload,
    autoInstallOnQuit: updates?.autoInstallOnQuit ?? defaults.autoInstallOnQuit,
    checkInterval: updates?.checkInterval ?? defaults.checkInterval,
  };
}

/** Report settings load failures other than a missing optional settings file. */
function logSettingsReadFailure(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[settings] settings.json could not be loaded, using defaults: ${message}`);
}

/** Convert a persisted check interval to milliseconds. */
export function intervalToMs(interval: string): number {
  return INTERVAL_MS_MAP[interval] ?? 4 * 60 * 60 * 1000;
}
