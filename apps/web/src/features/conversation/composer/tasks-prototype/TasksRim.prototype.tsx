// PROTOTYPE (throwaway): round 3, the composer's own border as the task progress (E1 to E3).
// See TasksPrototype.prototype.tsx for the variant list. Delete with that folder once a variant wins.
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskProgress, TaskSegment } from "@/stores/taskStore";
import { ENTER, TasksCapsuleDecor, TasksPopover, useChip, type ChipState } from "./TasksChips.prototype";

const RIM_SEGMENT_CLASS: Record<TaskSegment, string> = {
  done: "bg-ink",
  current: "bg-muted",
  pending: "bg-transparent",
};

function ratio(progress: TaskProgress): number {
  return progress.total === 0 ? 0 : progress.settled / progress.total;
}

/** E1: one segment per task along the straight top edge; pending segments leave the border showing. */
function TopRim({ segments }: { readonly segments: readonly TaskSegment[] }) {
  return (
    <span className="pointer-events-none absolute -top-px right-6 left-6 flex h-0.5 gap-[3px]" aria-hidden>
      {segments.map((segment, index) => (
        <span
          key={index}
          className={cn("h-full min-w-px flex-1 rounded-full transition-colors duration-300 motion-reduce:transition-none", RIM_SEGMENT_CLASS[segment])}
        />
      ))}
    </span>
  );
}

/**
 * Draws on the capsule's outline. The svg covers the border box and the rect's 2px stroke straddles the 1px border.
 * Corners are a fixed 21px: the capsule's 22px outer radius on two rows, and half its height on one. A larger `rx` is not
 * a pill here: SVG clamps it to half the width, and the corners stretch across the whole edge.
 * `pathLength` makes dash lengths percentages of the outline, starting where the top edge leaves the left curve.
 */
function Outline({ dasharray, className }: { readonly dasharray: string; readonly className: string }) {
  return (
    <svg className="pointer-events-none absolute -top-px -left-px size-[calc(100%+2px)] overflow-visible" aria-hidden>
      <rect
        x={1}
        y={1}
        pathLength={100}
        fill="none"
        strokeWidth={2}
        strokeDasharray={dasharray}
        className={cn("[height:calc(100%-2px)] [width:calc(100%-2px)] [rx:21px] [ry:21px]", className)}
      />
    </svg>
  );
}

/** A dash pattern that strokes only the segments of one kind, with a hairline gap between neighbours. */
function segmentDashes(segments: readonly TaskSegment[], kind: TaskSegment): string {
  const length = 100 / Math.max(1, segments.length);
  const gap = Math.min(0.35, length * 0.2);
  const dashes: number[] = [0];
  let cursor = 0;
  segments.forEach((segment, index) => {
    if (segment !== kind) return;
    const start = index * length + gap / 2;
    dashes.push(start - cursor, length - gap);
    cursor = start + length - gap;
  });
  dashes.push(200);
  return dashes.join(" ");
}

interface RimLegendProps {
  readonly chip: ChipState;
  readonly edge: "start" | "end";
  readonly label?: string;
  /** "hover" keeps the count hidden until the pointer or focus is in the composer, or a step has just finished. */
  readonly reveal: "always" | "hover";
}

/**
 * The count, set into the border like a fieldset legend: its fill is the page above the line and the capsule below it.
 * Clicking it opens the checklist; nothing opens on its own.
 */
function RimLegend({ chip, edge, label, reveal }: RimLegendProps) {
  const { progress, flash } = chip;
  const finished = progress.total > 0 && progress.settled === progress.total;
  return (
    <span
      className={cn(
        "absolute top-0 -translate-y-1/2",
        edge === "start" ? "left-4" : "right-7",
        reveal === "hover" && !flash && "opacity-0 transition-opacity duration-150 group-focus-within/capsule:opacity-100 group-hover/capsule:opacity-100",
      )}
    >
      <TasksPopover
        {...chip}
        side="top"
        align={edge}
        hover={false}
        className="flex h-4 items-center gap-1 rounded-full bg-linear-to-b from-background from-50% to-selected to-50% px-1.5 text-caption tabular-nums text-muted outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-focus data-popup-open:text-ink"
      >
        {flash ? (
          <span key={flash.id} className={cn("flex min-w-0 items-center gap-1 text-ink", ENTER)}>
            <Check className="size-3 shrink-0" aria-hidden />
            <span className="text-fade max-w-[280px] whitespace-nowrap">{flash.content}</span>
          </span>
        ) : (
          <>
            {finished && <Check className="size-3 shrink-0 text-ink" aria-hidden />}
            {label && <span>{label}</span>}
          </>
        )}
        <span>{progress.settled}/{progress.total}</span>
      </TasksPopover>
    </span>
  );
}

/** Everything the prototype draws on the capsule itself: round 2's island and lit edge, and round 3's rims. */
export function TasksCapsuleOverlay({ threadId }: { readonly threadId: string }) {
  return (
    <>
      <TasksCapsuleDecor threadId={threadId} />
      <TasksRim threadId={threadId} />
    </>
  );
}

/** Round 3: the capsule's border carries the task progress. Rendered after the capsule row so it does not change the capsule's rounding. */
function TasksRim({ threadId }: { readonly threadId: string }) {
  const chip = useChip(threadId, ["E1", "E2", "E3"]);
  if (!chip) return null;
  const { segments } = chip.progress;
  if (chip.variant === "E1") {
    return (
      <>
        <TopRim segments={segments} />
        <RimLegend chip={chip} edge="end" reveal="always" />
      </>
    );
  }
  if (chip.variant === "E2") {
    return (
      <>
        <Outline
          dasharray={`${ratio(chip.progress) * 100} 100`}
          className="stroke-ink transition-[stroke-dasharray] duration-500 ease-(--ease-standard) motion-reduce:transition-none"
        />
        <RimLegend chip={chip} edge="end" reveal="hover" />
      </>
    );
  }
  return (
    <>
      <Outline dasharray={segmentDashes(segments, "done")} className="stroke-ink" />
      <Outline dasharray={segmentDashes(segments, "current")} className="stroke-muted" />
      <RimLegend chip={chip} edge="start" label="Tasks" reveal="always" />
    </>
  );
}
