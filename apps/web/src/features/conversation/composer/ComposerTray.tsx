import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useQueueStore } from "@/stores/queueStore";
import { useTaskProgress } from "@/stores/taskStore";
import { UsageLimitRow, useUsageLimitTray } from "./UsageLimitRow";

/** Props for {@link ComposerTray}. */
export interface ComposerTrayProps {
  readonly threadId: string;
  /** True while the thread's agent runs; a running thread has no usage-limit row. */
  readonly running: boolean;
  readonly queue: ReactNode;
  /** The draft's file and image tiles; the tray shows whenever it has any, like queued messages. */
  readonly tiles?: ReactNode;
  /** True while the slash menu covers the tray; its controls are then inert. */
  readonly covered?: boolean;
}

/**
 * The panel the tray and the new-thread tab share above the capsule, a step between the page and the capsule's fill.
 * Light panel matches the light background, so the light tray takes `page` to stay visible.
 */
export const TRAY_SURFACE_CLASS = "mx-(--tray-inset) rounded-t-[14px] bg-page dark:bg-panel";

/**
 * Tray look: inset by `--tray-inset` from the capsule, which the slash menu shares, with the panel fill and top corners.
 * Under the new-thread tab it drops its top corners, so the tab and the tray read as one panel.
 * Covered by the menu, the tray hides its rows but keeps its panel, so a menu shorter than the tray reads as one surface.
 */
export function composerTrayClass(covered: boolean): string {
  return cn(
    TRAY_SURFACE_CLASS,
    "flex flex-col gap-1 px-2 pt-1 pb-2 [[data-tray-tab]+&]:rounded-t-none",
    covered && "*:invisible",
  );
}

/**
 * Tray docked on top of the composer. Shows a usage-limit stop as the first
 * row, then the queued messages and the draft's tiles. While the thread has
 * tasks, it starts after the task tab's widest extent, so the collapsed tab
 * never covers its rows.
 */
export function ComposerTray({ threadId, running, queue, tiles, covered = false }: ComposerTrayProps) {
  const usageLimit = useUsageLimitTray(threadId, running);
  const hasTaskTab = useTaskProgress(threadId) !== null;
  const hasQueue = useQueueStore((s) => (s.queues[threadId]?.length ?? 0) > 0);

  if (!usageLimit && !hasQueue && !tiles) return null;

  return (
    <div
      data-testid="composer-tray"
      inert={covered}
      className={cn(
        composerTrayClass(covered),
        hasTaskTab && "ml-[calc(var(--task-tab-left)+var(--task-tab-max-width)+12px)]",
      )}
    >
      {usageLimit && <UsageLimitRow threadId={threadId} state={usageLimit} />}
      {queue}
      {tiles}
    </div>
  );
}
