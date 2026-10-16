import { Play } from "lucide-react";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";

type RunBadge = "running" | "failed";

/** Running and failed are the only runs worth a badge: a completed or stopped one has nothing to flag. */
function badgeFor(run: WorkspaceEnvironmentActionRun | undefined): RunBadge | null {
  if (run?.status === "running") return "running";
  if (run?.status === "failed") return "failed";
  return null;
}

/**
 * Tab glyph for a Project Action record: a play mark with a status badge at its
 * bottom-right corner. The 2px ring in the page colour cuts the badge out of the glyph.
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
          className={`absolute -right-[3px] -bottom-[3px] size-2 rounded-full ring-2 ring-page ${
            badge === "running" ? "bg-success" : "bg-error"
          }`}
        />
      ) : null}
    </span>
  );
}
