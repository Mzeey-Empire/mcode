import { Spinner } from "@/components/ui/spinner";
import { StatusMark, type StatusMarkState } from "@/components/ui/status-mark";
import { getCiVisual, getCiOverviewSummaryLabel } from "@/lib/ci-status";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { ChecksStatus } from "@mcode/contracts";
import type { Thread } from "@/transport/types";

/** Compact state model shared by thread rows outside the chat transcript. */
export type ThreadStateMarkerModel =
  | { kind: "action"; label: "Action required" }
  | { kind: "setup-response"; label: "Awaiting response" }
  | { kind: "setup"; label: "Setup running" }
  | { kind: "running"; label: "Running" }
  | { kind: "ci"; label: string; aggregate: "failing" | "pending" }
  | { kind: "completed"; label: "Completed" }
  | { kind: "failed"; label: "Failed" }
  | { kind: "interrupted"; label: "Interrupted" }
  | { kind: "time"; label: string };

function getThreadStatusMarker(
  thread: Pick<Thread, "status" | "updated_at">,
  isRecoveryInterrupted: boolean | undefined,
): ThreadStateMarkerModel {
  if (isRecoveryInterrupted) return { kind: "interrupted", label: "Interrupted" };
  if (thread.status === "interrupted" && isRecoveryInterrupted === undefined) {
    return { kind: "interrupted", label: "Interrupted" };
  }
  switch (thread.status) {
    case "completed":
      return { kind: "completed", label: "Completed" };
    case "errored":
      return { kind: "failed", label: "Failed" };
    default:
      return { kind: "time", label: relativeTime(thread.updated_at) };
  }
}

function getCiMarker(checks: ChecksStatus | undefined): ThreadStateMarkerModel | null {
  if (checks?.aggregate !== "failing" && checks?.aggregate !== "pending") return null;
  return { kind: "ci", label: getCiOverviewSummaryLabel(checks), aggregate: checks.aggregate };
}

/**
 * Resolves the same compact state treatment used by a project-tree thread row.
 */
export function getThreadStateMarker({
  thread,
  checks,
  isRunning,
  isSetupRunning = false,
  isSetupAwaitingResponse = false,
  hasPendingPermission,
  isRecoveryInterrupted,
}: {
  thread: Pick<Thread, "status" | "updated_at">;
  checks: ChecksStatus | undefined;
  isRunning: boolean;
  isSetupRunning?: boolean;
  isSetupAwaitingResponse?: boolean;
  hasPendingPermission: boolean;
  isRecoveryInterrupted?: boolean;
}): ThreadStateMarkerModel {
  if (hasPendingPermission) return { kind: "action", label: "Action required" };
  if (isSetupAwaitingResponse) return { kind: "setup-response", label: "Awaiting response" };
  if (isSetupRunning) return { kind: "setup", label: "Setup running" };
  if (isRunning) return { kind: "running", label: "Running" };
  return getCiMarker(checks) ?? getThreadStatusMarker(thread, isRecoveryInterrupted);
}

const MARK_STATE: Record<Exclude<ThreadStateMarkerModel["kind"], "time" | "ci">, StatusMarkState> = {
  action: "attention",
  "setup-response": "attention",
  setup: "running",
  running: "running",
  completed: "success",
  failed: "error",
  interrupted: "attention",
};

function CiStateMarker({ marker, dim }: { marker: Extract<ThreadStateMarkerModel, { kind: "ci" }>; dim: boolean }) {
  const { icon: Icon, color } = getCiVisual(marker.aggregate);
  if (!Icon) return <Spinner size={12} aria-label={marker.label} className={cn(color, dim && "opacity-[0.72]")} />;
  return <Icon size={13} aria-label={marker.label} className={cn("shrink-0", color, dim && "opacity-[0.72]")} />;
}

/** Renders a compact thread state marker without competing with its title. */
export function ThreadStateMarker({
  marker,
  dim = false,
}: {
  marker: ThreadStateMarkerModel;
  dim?: boolean;
}) {
  if (marker.kind === "time") {
    return (
      <span className={cn("shrink-0 font-mono text-caption tabular-nums text-muted/45", dim && "opacity-[0.72]")}>
        {marker.label}
      </span>
    );
  }
  if (marker.kind === "ci") return <CiStateMarker marker={marker} dim={dim} />;
  return <StatusMark state={MARK_STATE[marker.kind]} label={marker.label} className={cn(dim && "opacity-[0.72]")} />;
}
