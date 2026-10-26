import { useMemo, useRef } from "react";
import { CanvasBreadcrumb } from "@/components/shell/CanvasBreadcrumb";
import { CanvasHeader } from "@/components/shell/CanvasHeader";
import { OverviewLayer } from "@/features/thread-overview/overview-layer";
import { OverviewMount } from "@/features/thread-overview/overview-mount";
import {
  newThreadOverviewScope,
  useOverviewPresentation,
  type OverviewPresentationState,
  type OverviewScope,
} from "@/features/thread-overview/overview-presentation";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { useElementWidth } from "@/hooks/useElementWidth";
import { OVERVIEW_CANVAS_RESERVE } from "@/lib/composer-layout";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import { cn } from "@/lib/utils";
import { recordFirstSend } from "@/features/thread-startup";
import { Composer } from "../../composer/Composer";
import { ProjectSlotHeading } from "./ProjectSlotHeading";

/** Props for {@link NewThreadStartColumn}. */
export interface NewThreadStartColumnProps {
  /** Active project name, or undefined before a project is chosen. */
  readonly projectName: string | undefined;
  /** Active project id passed to the new-thread composer. */
  readonly workspaceId: string | undefined;
  /** Composer draft that holds the unsent prompt. */
  readonly draftId: string | null;
}

/**
 * The new-thread canvas: a breadcrumb header over a centred column of question and composer. With a
 * project chosen, the Overview card shows where the thread will run, as it does for a running thread.
 */
export function NewThreadStartColumn({ projectName, workspaceId, draftId }: NewThreadStartColumnProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const canvasWidth = useElementWidth(canvasRef, workspaceId);
  const scope = useMemo(() => (workspaceId ? newThreadOverviewScope(workspaceId) : null), [workspaceId]);
  const overview = useOverviewPresentation(scope, canvasWidth);
  const docked = overview.presentation === "docked";
  return (
    // While docked, the card's reserve takes the right gutter's room, as on a running thread's canvas.
    <div ref={canvasRef} className={cn("relative flex h-full min-h-0 flex-col bg-background", docked && "[--chat-gutter:--spacing(6)]")}>
      <OverviewLayer>
        <CanvasHeader>
          <CanvasBreadcrumb projectName={projectName} workspaceId={workspaceId}>
            <span aria-current="page" className="shrink-0 text-label text-ink">New thread</span>
          </CanvasBreadcrumb>
          {scope ? <NewThreadOverview scope={scope} overview={overview} /> : null}
        </CanvasHeader>
        <div
          ref={columnRef}
          data-testid="new-thread-start-column"
          className="flex min-h-0 flex-1 flex-col justify-center-safe overflow-y-auto"
          style={{ paddingRight: docked ? `${OVERVIEW_CANVAS_RESERVE}px` : undefined }}
        >
          <div className="px-4 pb-4 sm:px-8">
            <div key={projectName ?? "projectless"} className={cn(PRIMARY_CONTENT_RAIL_CLASS, "animate-fade-up-in flex justify-center")}>
              <ProjectSlotHeading projectName={projectName} />
            </div>
          </div>
          <Composer
            isNewThread
            workspaceId={workspaceId}
            draftId={draftId}
            onThreadPreparing={(thread) => {
              if (columnRef.current) recordFirstSend(thread.id, columnRef.current);
            }}
          />
        </div>
      </OverviewLayer>
    </div>
  );
}

function NewThreadOverview({ scope, overview }: { scope: OverviewScope; overview: OverviewPresentationState }) {
  const { workspaceId } = scope;
  const subject = useMemo<OverviewSubject>(() => ({ kind: "new-thread", workspaceId }), [workspaceId]);
  return (
    <div className="ml-auto flex items-center justify-end gap-1">
      <OverviewMount subject={subject} subjectKey={scope.key} presentation={overview} />
    </div>
  );
}
