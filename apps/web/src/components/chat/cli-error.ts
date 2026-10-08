/** Substrings that identify a provider CLI setup error from any backend. */
const CLI_NOT_FOUND_MARKERS = [
  "CLI not found",       // claude / codex custom-path message
  "not found at",        // custom-path fallback for all providers
  "package not found",   // @github/copilot npm package missing
  "exited unexpectedly", // Copilot CLI launched but exited (auth / subscription issue)
];

/** Returns true when the error string represents a missing CLI binary. */
export function isCliError(error: string): boolean {
  return CLI_NOT_FOUND_MARKERS.some((m) => error.includes(m));
}

/** The parts of a CLI setup error that the chat notice shows. */
export interface CliErrorParts {
  /** First line of the error. */
  headline: string;
  /** First actionable shell command: an `npm install` line or a backtick-quoted command. */
  installCommand: string | null;
  /** The Settings guidance sentence with its "Settings > ..." path removed, when present. */
  settingsHint: string | null;
}

/** Splits a provider CLI setup error into its headline, install command and settings hint. */
export function describeCliError(error: string): CliErrorParts {
  const lines = error.split("\n");
  const settingsLine = lines.find((line) => line.includes("Settings"));
  return {
    headline: lines[0],
    installCommand: extractInstallCommand(error),
    settingsHint: settingsLine ? settingsLine.replace(/(?:in |at )?Settings > [^.\n]+\.?/, "").trim() : null,
  };
}

function extractInstallCommand(error: string): string | null {
  const npmMatch = error.match(/npm install[^\n]+/);
  if (npmMatch) return npmMatch[0];
  const backtickMatch = error.match(/`([^`]+)`/);
  return backtickMatch ? backtickMatch[1] : null;
}
