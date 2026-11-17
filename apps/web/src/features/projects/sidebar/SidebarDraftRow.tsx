import { memo } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProviderIcon, providerLabel } from "@/components/ui/provider-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProjectIcon } from "@/features/projects/icons/ProjectIcon";
import { useRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useThreadDraftStore, type ThreadDraft } from "@/stores/threadDraftStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import type { SidebarItem } from "./sidebar-model";
import type { SidebarRowContext } from "./sidebar-row-context";
import { DraftTag, useSidebarNarrow } from "./sidebar-label-tooltip";
import { groupedTreeLineClass, isThreadRowNavigationEvent } from "./SidebarThreadRow";

type DraftItem = Extract<SidebarItem, { kind: "draft" }>;

/** An unsent new-thread draft in the sidebar, read from the draft store by id. */
export const SidebarDraftRow = memo(function SidebarDraftRow({ item, ctx }: { item: DraftItem; ctx: SidebarRowContext }) {
  const draft = useThreadDraftStore((state) => state.drafts[item.draftId]);
  const isActive = useWorkspaceStore((state) => state.activeDraftId === item.draftId);
  const workspaceName = useWorkspaceStore((state) => state.workspaces.find((workspace) => workspace.id === item.workspaceId)?.name ?? "");
  if (!draft) return null;
  return (
    <DraftRow
      item={item}
      workspaceName={workspaceName}
      draft={draft}
      isActive={isActive}
      onOpen={ctx.onOpenDraft}
      onDiscard={ctx.onDiscardDraft}
      onContextMenu={ctx.onDraftContextMenu}
    />
  );
});

interface DraftRowProps {
  item: DraftItem;
  workspaceName: string;
  draft: ThreadDraft;
  isActive: boolean;
  onOpen: (workspaceId: string, draftId: string) => void;
  onDiscard: (draftId: string) => void;
  onContextMenu: (event: React.MouseEvent, draftId: string) => void;
}

const SURFACE_CLASS: Record<DraftItem["layout"], string> = {
  flat: "min-h-[60px] flex-col justify-center p-2",
  grouped: "h-9 items-center gap-2 pr-2 pl-2",
};

function DraftRow({ item, workspaceName, draft, isActive, onOpen, onDiscard, onContextMenu }: DraftRowProps) {
  const grouped = item.layout === "grouped";
  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (!isThreadRowNavigationEvent(event)) return;
        event.preventDefault();
        onOpen(item.workspaceId, draft.id);
      }}
      onClick={() => onOpen(item.workspaceId, draft.id)}
      onContextMenu={(event) => onContextMenu(event, draft.id)}
      className={cn(
        "group/row relative flex rounded-lg cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-focus/70",
        SURFACE_CLASS[item.layout],
        grouped && groupedTreeLineClass(item.treeLine),
        isActive ? "bg-selected" : "hover:bg-selected/40",
      )}
    >
      {grouped
        ? <GroupedDraftBody draft={draft} isActive={isActive} onDiscard={onDiscard} />
        : <FlatDraftBody draft={draft} isActive={isActive} workspaceName={workspaceName} onDiscard={onDiscard} />}
    </div>
  );
}

type DraftBodyProps = Pick<DraftRowProps, "draft" | "isActive" | "onDiscard">;

function FlatDraftBody({ draft, isActive, workspaceName, onDiscard }: DraftBodyProps & { workspaceName: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-4 min-w-0 items-center gap-1 text-caption text-muted">
        <ProjectIcon workspaceId={draft.workspaceId} name={workspaceName} size={16} tone="tinted" />
        <span className="text-fade min-w-0 flex-1">{workspaceName}</span>
        <DraftCorner draft={draft} onDiscard={onDiscard} />
      </div>
      <div className="mt-2 flex h-5 min-w-0 items-center gap-2">
        <DraftTag />
        <DraftTitle draft={draft} isActive={isActive} />
        <DraftProvider draft={draft} />
      </div>
    </div>
  );
}

function GroupedDraftBody({ draft, isActive, onDiscard }: DraftBodyProps) {
  const narrow = useSidebarNarrow();
  return (
    <>
      <DraftTag iconOnly={narrow} />
      <DraftTitle draft={draft} isActive={isActive} />
      <div className="flex shrink-0 items-center gap-2 text-caption text-muted">
        <DraftCorner draft={draft} onDiscard={onDiscard} />
        <DraftProvider draft={draft} />
      </div>
    </>
  );
}

function draftTitle(draft: ThreadDraft): string {
  const firstLine = draft.draft.input.split("\n")[0]?.trim() ?? "";
  if (firstLine) return firstLine;
  const attachmentCount = draft.draft.attachments.length;
  if (attachmentCount > 0) return `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
  return "Empty draft";
}

function DraftTitle({ draft, isActive }: Pick<DraftRowProps, "draft" | "isActive">) {
  return (
    <span data-testid="draft-title" className={cn("text-fade min-w-0 flex-1 text-label", isActive ? "text-ink" : "text-muted")}>
      {draftTitle(draft)}
    </span>
  );
}

function DraftProvider({ draft }: { draft: ThreadDraft }) {
  const provider = draft.draft.provider;
  if (!provider) return null;
  return (
    <div aria-label={`Provider, ${providerLabel(provider)}`} className="flex h-5 w-4 shrink-0 items-center justify-center opacity-(--provider-mark-opacity)">
      <ProviderIcon provider={provider} size={12} />
    </div>
  );
}

function DraftCorner({ draft, onDiscard }: Pick<DraftRowProps, "draft" | "onDiscard">) {
  const edited = useRelativeTime(new Date(draft.updatedAt).toISOString());
  return (
    <div className="relative grid shrink-0 items-center justify-items-end">
      <span className="col-start-1 row-start-1 text-caption tabular-nums text-muted transition-opacity group-hover/row:opacity-0 group-focus-visible/row:opacity-0">
        {edited}
      </span>
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
              className="col-start-1 row-start-1 size-5 shrink-0 rounded-md p-0 text-muted opacity-0 shadow-none transition-opacity hover:bg-transparent hover:text-ink group-hover/row:opacity-100 group-focus-visible/row:opacity-100 focus-visible:opacity-100"
            >
              <Trash2 size={12} aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="right" className="text-xs">
          Delete draft
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
