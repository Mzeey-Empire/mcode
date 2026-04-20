import { Button } from "@/components/ui/button";
import type { ProviderId } from "@mcode/contracts";

/** Human-readable display names for each provider ID. */
const NAMES: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "GitHub Copilot",
  gemini: "Gemini",
  cursor: "Cursor",
  opencode: "OpenCode",
};

/** Props for the ProviderUnavailableBanner component. */
export interface ProviderUnavailableBannerProps {
  /** The provider that is currently unusable. */
  providerId: ProviderId;
  /** Why the provider is unavailable: user-disabled or CLI binary not found. */
  reason: "disabled" | "cli_missing";
  /** Called when the user clicks "Open Settings". */
  onOpenSettings: () => void;
  /**
   * Called when the user clicks "Branch to another provider". The button only renders
   * when both `reason === "disabled"` and `onBranch` is supplied, so callers that do
   * not own branch mode can omit it rather than passing a no-op.
   */
  onBranch?: () => void;
}

/**
 * Inline banner rendered above the Composer when the thread's active provider
 * is unusable (disabled in settings or CLI binary not found on disk).
 */
export function ProviderUnavailableBanner({
  providerId,
  reason,
  onOpenSettings,
  onBranch,
}: ProviderUnavailableBannerProps) {
  const name = NAMES[providerId];
  const copy =
    reason === "disabled"
      ? `${name} is disabled. Enable it in Settings, or branch this thread to another provider.`
      : `${name} CLI was not found. Install it or set the path in Settings.`;

  return (
    <div
      data-testid="provider-unavailable-banner"
      className="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm"
    >
      <span className="flex-1">{copy}</span>
      <Button size="sm" variant="outline" onClick={onOpenSettings}>Open Settings</Button>
      {reason === "disabled" && onBranch && (
        <Button size="sm" variant="ghost" onClick={onBranch}>Branch to another provider</Button>
      )}
    </div>
  );
}
