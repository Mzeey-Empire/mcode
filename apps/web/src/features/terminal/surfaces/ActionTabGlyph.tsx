import { Play } from "lucide-react";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";

type RunBadge = "running" | "failed";

function badgeFor(run: WorkspaceEnvironmentActionRun | undefined): RunBadge | null {
  if (run?.status === "running") return "running";
  if (run?.status === "failed") return "failed";
  return null;
}

/**
 * Project Action tab icon with badges for running and failed runs.
 * The play mark is a placeholder until the action icon set lands.
 */
export function ActionTabGlyph({ run }: { readonly run: WorkspaceEnvironmentActionRun | undefined }) {
  const badge = badgeFor(run);
  return (
    <span className="relative inline-flex">
      <Play aria-hidden />
      {badge ? (
        <span
          data-testid="action-tab-badge"
          data-badge={badge}
          role="img"
          aria-label={badge === "running" ? "Running" : "Failed"}
          className={`absolute -right-[3px] -bottom-[3px] size-2 rounded-full ring-2 ring-page ${
            badge === "running" ? "bg-success" : "bg-error"
          }`}
        />
      ) : null}
    </span>
  );
}
