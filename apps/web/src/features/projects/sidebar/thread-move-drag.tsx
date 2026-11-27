import { useDraggable, type DragEndEvent } from "@dnd-kit/core";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { useMoveBlock } from "../thread-move/use-move-block";

/**
 * What a sidebar drag carries. The sidebar has one drag context, so this is how a project header dragged to
 * reorder is told apart from a No project thread dragged to move.
 */
export type SidebarDragData =
  | { readonly type: "project"; readonly workspaceId: string }
  | { readonly type: "thread"; readonly threadId: string };

/** The drag data a project header carries, as a reorder source and as a move target. */
export function projectDragData(workspaceId: string): SidebarDragData {
  return { type: "project", workspaceId };
}

/** Reads the drag data an active or over item carries. Null for an item that carries none, such as the reorder tests' bare ids. */
export function sidebarDragData(item: { readonly data: { readonly current?: Record<string, unknown> } } | null): SidebarDragData | null {
  const data = item?.data.current;
  if (data?.type === "project" && typeof data.workspaceId === "string") return projectDragData(data.workspaceId);
  if (data?.type === "thread" && typeof data.threadId === "string") return { type: "thread", threadId: data.threadId };
  return null;
}

/** Whether a thread, not a project header, is being dragged. */
export function isThreadDrag(active: { readonly data: { readonly current?: Record<string, unknown> } } | null): boolean {
  return sidebarDragData(active)?.type === "thread";
}

/**
 * Which thread dropped on which project, or null when the drop is not a thread on a project header. A drop
 * on anything else, or outside the list, does nothing.
 */
export function threadDropOnProject(event: Pick<DragEndEvent, "active" | "over">): { readonly threadId: string; readonly workspaceId: string } | null {
  const dragged = sidebarDragData(event.active);
  const target = sidebarDragData(event.over);
  if (dragged?.type !== "thread" || target?.type !== "project") return null;
  return { threadId: dragged.threadId, workspaceId: target.workspaceId };
}

/**
 * Makes an open No project thread row draggable by pointer, unless a move would be refused. Pointer only:
 * Enter and Space already select the row, and the menu and the palette reach the same dialog by keyboard.
 */
export function useThreadMoveDrag(thread: Pick<WorkspaceThread, "id" | "clientPreparing" | "clientError">) {
  const draggable = useMoveBlock(thread) === null;
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `thread:${thread.id}`,
    data: { type: "thread", threadId: thread.id } satisfies SidebarDragData,
    disabled: !draggable,
  });
  return { setNodeRef, onPointerDown: draggable ? listeners?.onPointerDown : undefined, isDragging };
}

/** The dragged row's look in place: muted, with a dashed outline, so it reads as lifted out of the list. */
export const DRAGGED_THREAD_ROW_CLASS = "outline-1 -outline-offset-1 outline-dashed outline-muted [&_[data-title-line]_*]:text-muted";
