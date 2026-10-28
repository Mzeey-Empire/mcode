import { memo } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/format-relative";
import { cn } from "@/lib/utils";
import { useThreadDraftStore, type ThreadDraft } from "@/stores/threadDraftStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import type { SidebarItem } from "./sidebar-model";
import type { SidebarRowContext } from "./sidebar-row-context";
import { isThreadRowNavigationEvent } from "./SidebarThreadRow";

type DraftItem = Extract<SidebarItem, { kind: "draft" }>;

/** An unsent new-thread draft in the sidebar, read from the draft store by id. */
export const SidebarDraftRow = memo(function SidebarDraftRow({ item, ctx }: { item: DraftItem; ctx: SidebarRowContext }) {
  const draft = useThreadDraftStore((state) => state.drafts[item.draftId]);
  const isActive = useWorkspaceStore((state) => state.activeDraftId === item.draftId);
  if (!draft) return null;
  return (
    <DraftRow
      workspaceId={item.workspaceId}
      draft={draft}
      isActive={isActive}
      onOpen={ctx.onOpenDraft}
      onDiscard={ctx.onDiscardDraft}
      onContextMenu={ctx.onDraftContextMenu}
    />
  );
});

/** Row for a local unsent new-thread draft; mirrors thread-row chrome minus
 * provider and lifecycle affordances so it never reads as a real thread. */
function DraftRow({
  workspaceId,
  draft,
  isActive,
  onOpen,
  onDiscard,
  onContextMenu,
}: {
  workspaceId: string;
  draft: ThreadDraft;
  isActive: boolean;
  onOpen: (workspaceId: string, draftId: string) => void;
  onDiscard: (draftId: string) => void;
  onContextMenu: (event: React.MouseEvent, draftId: string) => void;
}) {
  const firstLine = draft.draft.input.split("\n")[0]?.trim() ?? "";
  const attachmentCount = draft.draft.attachments.length;
  const preview = firstLine
    || (attachmentCount > 0
      ? `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
      : "Empty draft");
  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (!isThreadRowNavigationEvent(event)) return;
        event.preventDefault();
        onOpen(workspaceId, draft.id);
      }}
      onClick={() => onOpen(workspaceId, draft.id)}
      onContextMenu={(event) => onContextMenu(event, draft.id)}
      className={cn(
        "group/row relative flex min-h-8 items-center gap-2 rounded-md pr-2 text-body-small cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-focus/70",
        isActive
          ? "bg-selected text-ink"
          : "text-muted/70 hover:bg-selected/40 hover:text-ink",
      )}
      style={{ paddingLeft: "46px" }}
    >
      <span
        className="absolute left-0.5 top-1/2 flex -translate-y-1/2 items-center justify-end gap-1"
        style={{ width: "40px" }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-compact"
                aria-label="Delete draft"
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onDiscard(draft.id);
                }}
                className="size-5 shrink-0 rounded-full p-0 text-muted/65 opacity-0 transition-opacity shadow-none hover:bg-transparent hover:text-ink group-hover/row:opacity-100 group-focus-visible/row:opacity-100 focus-visible:opacity-100"
              >
                <Trash2 size={12} aria-hidden />
              </Button>
            }
          />
          <TooltipContent side="right" className="text-xs">
            Delete draft
          </TooltipContent>
        </Tooltip>
        <span className="-mt-px flex h-4 w-4 items-center justify-center text-muted/45">
          <Pencil size={12} aria-hidden />
        </span>
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 text-caption font-medium text-muted/60">
          Draft
        </span>
        <span className="min-w-0 flex-1 text-fade text-muted/75">
          {preview}
        </span>
        <span className="shrink-0 text-caption text-muted/50">
          {formatRelative(new Date(draft.updatedAt).toISOString())}
        </span>
      </div>
    </div>
  );
}
