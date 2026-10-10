import { useRef } from "react";
import { Folder } from "lucide-react";
import { CanvasHeader } from "@/components/shell/CanvasHeader";
import { COMPOSER_RAIL_CLASS } from "@/lib/layout-rails";
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

/** The new-thread canvas: a breadcrumb header over a centred column of question and composer. */
export function NewThreadStartColumn({ projectName, workspaceId, draftId }: NewThreadStartColumnProps) {
  const columnRef = useRef<HTMLDivElement>(null);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <CanvasHeader>
        <NewThreadBreadcrumb projectName={projectName} />
      </CanvasHeader>
      <div ref={columnRef} data-testid="new-thread-start-column" className="flex min-h-0 flex-1 flex-col justify-center-safe overflow-y-auto">
        <div className="px-4 pb-4 sm:px-8">
          <div key={projectName ?? "projectless"} className={cn(COMPOSER_RAIL_CLASS, "animate-fade-up-in flex justify-center")}>
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
    </div>
  );
}

function NewThreadBreadcrumb({ projectName }: { projectName: string | undefined }) {
  return (
    <nav aria-label="Breadcrumb" className="flex h-control-compact min-w-0 items-center gap-2 rounded-2xl bg-selected px-3 text-body-small text-muted">
      <Folder size={14} className="shrink-0" aria-hidden />
      {projectName && (
        <>
          <span className="text-fade">{projectName}</span>
          <span aria-hidden>/</span>
        </>
      )}
      <span aria-current="page" className="shrink-0 text-label text-ink">New thread</span>
    </nav>
  );
}
