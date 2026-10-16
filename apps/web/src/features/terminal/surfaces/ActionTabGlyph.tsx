import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { ActionIcon } from "@/features/projects/actions/ActionIcon";

type RunBadge = "running" | "failed" | "pending";

function badgeFor(run: WorkspaceEnvironmentActionRun | undefined): RunBadge | null {
  if (run?.status === "running") return "running";
  if (run?.status === "failed") return "failed";
  if (run?.status === "awaiting-approval") return "pending";
  return null;
}

/** Spoken form of the tab badge, which is colour only. */
export function actionBadgeLabel(run: WorkspaceEnvironmentActionRun | undefined): string | undefined {
  const badge = badgeFor(run);
  if (badge === null) return undefined;
  if (badge === "pending") return "Approval required";
  return badge === "running" ? "Running" : "Failed";
}

/**
 * Project Action tab icon with badges for running and failed runs.
 * A run waiting for approval has nothing to run yet, so its tab shows the hollow needs-you ring
 * instead of the Action's icon.
 */
export function ActionTabGlyph({ run }: { readonly run: WorkspaceEnvironmentActionRun | undefined }) {
  const badge = badgeFor(run);
  if (badge === "pending") {
    return (
      <span data-testid="action-tab-badge" data-badge="pending" aria-hidden className="inline-flex size-3.5 items-center justify-center">
        <span className="size-2 rounded-full border-[1.5px] border-primary" />
      </span>
    );
  }
  return (
    <span className="relative inline-flex">
      <ActionIcon command={run?.snapshot.script ?? ""} size={14} />
      {badge ? (
        <span
          data-testid="action-tab-badge"
          data-badge={badge}
          aria-hidden
          className={`absolute -right-[3px] -bottom-[3px] size-2 rounded-full ring-2 ring-page ${
            badge === "running" ? "bg-success" : "bg-error"
          }`}
        />
      ) : null}
    </span>
  );
}
