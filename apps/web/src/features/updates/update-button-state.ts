import type { UpdateStatus } from "@/transport/desktop-bridge";

/** The step a Retry repeats, carried on the desktop error status. */
export type FailedUpdateOperation = Extract<UpdateStatus, { state: "error" }>["failedOperation"];

/**
 * What the sidebar update button shows. Each variant is one board state from
 * S01-05; the install dialog (state 7) layers over `install`.
 */
export type UpdateButtonView =
  | { readonly kind: "rest" }
  | { readonly kind: "checking" }
  | { readonly kind: "up-to-date" }
  | { readonly kind: "download"; readonly version: string; readonly versionLabel: string; readonly releaseNotes: string | null }
  | { readonly kind: "downloading"; readonly progressLabel: string; readonly percent: number }
  | { readonly kind: "install"; readonly version: string; readonly versionLabel: string; readonly releaseNotes: string | null }
  | { readonly kind: "armed"; readonly version: string }
  | { readonly kind: "failed"; readonly message: string; readonly failedOperation: FailedUpdateOperation };

/** Renderer facts the desktop status cannot carry. */
export interface UpdateButtonContext {
  /** True for the 3s after a user-started check resolved with no update. */
  readonly upToDateFlash: boolean;
  /** Version of the update being fetched, remembered from the last available status. */
  readonly pendingVersion: string | null;
}

/** Nightly builds carry `-nightly.` in their version (state 10). */
export function isNightlyVersion(version: string): boolean {
  return version.includes("-nightly.");
}

/** The short version text beside Download and Install; nightly builds read "nightly". */
export function updateVersionLabel(version: string): string {
  return isNightlyVersion(version) ? "nightly" : `v${version}`;
}

/** Maps a desktop update status to the button view the sidebar renders. */
export function deriveUpdateButtonView(status: UpdateStatus, context: UpdateButtonContext): UpdateButtonView {
  switch (status.state) {
    case "idle":
      return { kind: "rest" };
    case "checking":
      return { kind: "checking" };
    case "not-available":
      return context.upToDateFlash ? { kind: "up-to-date" } : { kind: "rest" };
    case "available":
      return offerView("download", status.version, status.releaseNotes);
    case "downloading":
      return { kind: "downloading", progressLabel: progressLabel(status.percent, context.pendingVersion), percent: status.percent };
    case "downloaded":
      return status.installWhenIdle
        ? { kind: "armed", version: status.version }
        : offerView("install", status.version, status.releaseNotes);
    case "error":
      return { kind: "failed", message: status.message, failedOperation: status.failedOperation };
  }
}

function offerView(
  kind: "download" | "install",
  version: string,
  releaseNotes: string | undefined,
): Extract<UpdateButtonView, { kind: "download" | "install" }> {
  return { kind, version, versionLabel: updateVersionLabel(version), releaseNotes: releaseNotes ?? null };
}

function progressLabel(percent: number, pendingVersion: string | null): string {
  const rounded = `${Math.round(percent)}%`;
  return pendingVersion ? `${updateVersionLabel(pendingVersion)} · ${rounded}` : rounded;
}

/** Copy for the install dialog body, singular for one agent. */
export function runningAgentsSentence(count: number): string {
  const subject = count === 1 ? "1 agent is" : `${count} agents are`;
  return `${subject} running. Installing restarts Mcode and stops them.`;
}

/** GitHub release page for a version, opened from the release notes card. */
export function releaseNotesUrl(version: string): string {
  return `https://github.com/mzeey-empire/mcode/releases/tag/v${encodeURIComponent(version)}`;
}
