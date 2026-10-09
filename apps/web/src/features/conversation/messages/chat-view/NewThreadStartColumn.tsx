import { Folder } from "lucide-react";
import { SidebarRevealButton } from "@/components/sidebar/SidebarRevealButton";
import { COMPOSER_RAIL_CLASS } from "@/lib/layout-rails";
import { cn } from "@/lib/utils";
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
  /** Shows the sidebar reveal control when the sidebar is collapsed. */
  readonly sidebarCollapsed: boolean;
}

/** The new-thread canvas: a breadcrumb header over a centred column of question and composer. */
export function NewThreadStartColumn({ projectName, workspaceId, draftId, sidebarCollapsed }: NewThreadStartColumnProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <NewThreadCanvasHeader projectName={projectName} sidebarCollapsed={sidebarCollapsed} />
      <div data-testid="new-thread-start-column" className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto">
        <div className="px-4 pb-4 sm:px-8">
          <div key={projectName ?? "projectless"} className={cn(COMPOSER_RAIL_CLASS, "animate-fade-up-in flex justify-center")}>
            <ProjectSlotHeading projectName={projectName} />
          </div>
        </div>
        <Composer isNewThread workspaceId={workspaceId} draftId={draftId} />
      </div>
    </div>
  );
}

function NewThreadCanvasHeader({ projectName, sidebarCollapsed }: { projectName: string | undefined; sidebarCollapsed: boolean }) {
  return (
    // The right side stays empty until the canvas header shell (S01-01) owns the top actions.
    <header data-testid="new-thread-header" className="flex h-row-comfortable shrink-0 items-center gap-4 px-3">
      {sidebarCollapsed && <SidebarRevealButton />}
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
    </header>
  );
}
