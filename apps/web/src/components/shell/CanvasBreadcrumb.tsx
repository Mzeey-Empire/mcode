import type { ReactNode } from "react";
import { Folder } from "lucide-react";
import { ProjectIcon } from "@/features/projects/icons/ProjectIcon";

/** Props for {@link CanvasBreadcrumb}. */
interface CanvasBreadcrumbProps {
  /** Project the canvas belongs to; omitted while no project is chosen. */
  readonly projectName: string | undefined;
  readonly workspaceId: string | undefined;
  /** The current page: a label, or the thread title and its editor. */
  readonly children: ReactNode;
}

/**
 * The canvas header's "project / page" pill. The page is the last crumb and carries the ink colour;
 * the project before it is muted and fades out when the pill runs out of room.
 */
export function CanvasBreadcrumb({ projectName, workspaceId, children }: CanvasBreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className="flex h-control-compact min-w-0 items-center gap-2 rounded-2xl bg-selected px-3 text-body-small text-muted">
      {projectName && workspaceId
        ? <ProjectIcon workspaceId={workspaceId} name={projectName} size={14} />
        : <Folder size={14} className="shrink-0" aria-hidden />}
      {projectName && (
        <>
          <span className="text-fade">{projectName}</span>
          <span aria-hidden>/</span>
        </>
      )}
      {children}
    </nav>
  );
}
