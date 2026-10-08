import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getOverviewEntries, getOverviewHeaderActions } from "@/features/thread-overview/overview-registry";
import { OverviewEntryStateProviders } from "@/features/thread-overview/overview-entry-state";
import {
  OverviewContext,
  OverviewDialogs,
  useOverviewState,
} from "@/features/thread-overview/overview-state";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { shouldAutoOpenOverview } from "@/lib/composer-layout";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { useOverviewStore } from "@/stores/overviewStore";
import { type Thread } from "@/transport";
import { Settings2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ComponentProps } from "react";
import { ThreadOverviewWhen } from "@/features/thread-overview/overview-row";
import type { ThreadOverviewCiDot } from "@/features/thread-overview/overview-state";

const SIDE_OVERVIEW_COLLISION_AVOIDANCE = {
  side: "none",
  align: "none",
  fallbackAxisSide: "none",
} as const;

function getOverviewCollisionAvoidance(hasRoom: boolean) {
  return hasRoom ? SIDE_OVERVIEW_COLLISION_AVOIDANCE : undefined;
}

/** Props for {@link ThreadOverview}. */
interface ThreadOverviewProps {
  thread: Thread;
  /** Width of the chat pane that contains this thread's timeline and composer. */
  threadPaneWidth: number;
}

/** Returns the accessible label for the Overview trigger's current CI state. */
function getThreadOverviewTriggerStatus(ciDot: ThreadOverviewCiDot): string {
  if (ciDot === "red") return "Thread overview, CI checks failing";
  if (ciDot === "green") return "Thread overview, CI checks passing";
  return "Thread overview";
}

/** Returns the trigger dot class for one Overview CI state. */
function getThreadOverviewCiDotClass(ciDot: ThreadOverviewCiDot): string | false {
  if (ciDot === "red") return "bg-[var(--diff-remove-strong)]";
  if (ciDot === "green") return "bg-[var(--diff-add-strong)]";
  return false;
}

type ThreadOverviewTriggerProps = {
  ciDot: ThreadOverviewCiDot;
  open: boolean;
} & Omit<ComponentProps<typeof Button>, "children">;

/** Renders the Overview trigger with its compact CI state. */
function ThreadOverviewTrigger({ ciDot, open, className, ...triggerProps }: ThreadOverviewTriggerProps) {
  const status = getThreadOverviewTriggerStatus(ciDot);

  return (
    <Button
      {...triggerProps}
      variant="ghost"
      size="icon-xs"
      type="button"
      aria-label={status}
      aria-expanded={open}
      data-testid="header-workspace-menu"
      className={cn(
        "relative cursor-pointer text-ink/70 transition-[background-color,color,transform] duration-150 active:scale-95 motion-reduce:transform-none hover:bg-hover/40 hover:text-ink",
        open && "bg-hover text-ink",
        className,
      )}
    >
      <Settings2 size={14} aria-hidden />
      <ThreadOverviewWhen when={ciDot !== null}>
        <span
          data-testid={`thread-overview-ci-${ciDot}`}
          aria-hidden
          className={cn(
            "absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background",
            getThreadOverviewCiDotClass(ciDot),
          )}
        />
      </ThreadOverviewWhen>
    </Button>
  );
}

function useThreadOverviewOpenState(
  threadId: string,
  panelVisible: boolean,
  hasRoom: boolean,
  openRequested: boolean,
) {
  const [choice, setChoice] = useState<{ threadId: string; value: boolean | null }>({
    threadId,
    value: null,
  });
  const currentChoice = choice.threadId === threadId ? choice.value : null;
  const open = openRequested || (currentChoice ?? (hasRoom || panelVisible));

  useEffect(() => {
    if (!openRequested) return;
    // oxlint-disable-next-line react/set-state-in-effect -- A store-driven open request becomes this thread's local interaction snapshot after consumption.
    setChoice({ threadId, value: true });
    useOverviewStore.getState().consumeOpenRequest(threadId);
  }, [openRequested, threadId]);

  const setOpen = useCallback((next: boolean) => {
    setChoice({ threadId, value: next });
  }, [threadId]);
  const handleOpenChange = useCallback((next: boolean, eventDetails?: { reason?: string }) => {
    if (!next && (eventDetails?.reason === "outside-press" || eventDetails?.reason === "focus-out")) {
      return;
    }
    setChoice({ threadId, value: next });
  }, [threadId]);

  return { open, setOpen, handleOpenChange };
}

/** Thread-scoped overview popover, with independently registered body entries. */
export function ThreadOverview({ thread, threadPaneWidth }: ThreadOverviewProps) {
  // Overview may open when the chat has room or the normal right panel is
  // visible, until the user takes manual control for this thread.
  const panelVisible = useDiffStore((s) => s.getRightPanelVisible(thread.workspace_id, thread.id));
  const openRequested = useOverviewStore(
    (state) => state.requestedThreadId === thread.id,
  );
  // Whether there is room for the Overview to open by default. The chat pane
  // width, not the surrounding split row, is the signal that matches what the
  // user sees when the right panel opens.
  const hasRoom = useMemo(
    () =>
      shouldAutoOpenOverview({
        threadPaneWidth,
      }),
    [threadPaneWidth],
  );
  const { open, setOpen: setOverviewOpen, handleOpenChange } = useThreadOverviewOpenState(
    thread.id,
    panelVisible,
    hasRoom,
    openRequested,
  );
  const setReserveThread = useOverviewStore((s) => s.setReserveThread);
  const clearReserveThread = useOverviewStore((s) => s.clearReserveThread);
  useLayoutEffect(() => {
    setReserveThread(open && hasRoom ? thread.id : null);
    return () => clearReserveThread(thread.id);
  }, [clearReserveThread, hasRoom, open, setReserveThread, thread.id]);
  const state = useOverviewState(thread, open, setOverviewOpen);
  const subject: OverviewSubject = { kind: "thread", thread };
  const entries = getOverviewEntries(subject);
  const headerActions = getOverviewHeaderActions(subject);
  const triggerButton = <ThreadOverviewTrigger ciDot={state.ciDot} open={open} />;
  return (<OverviewContext.Provider value={state}>
    <OverviewEntryStateProviders entries={[...entries, ...headerActions]} subject={subject}>
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={triggerButton} />} />
        <TooltipContent>{getThreadOverviewTriggerStatus(state.ciDot)}</TooltipContent>
      </Tooltip>
      {/*
        The side layout already reserves this right gutter. Keep Base UI from
        flipping or shifting into chat when height is short; its available-height
        variable still constrains the scrollable body below the trigger.
      */}
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={18}
        alignOffset={-40}
        collisionPadding={8}
        collisionAvoidance={getOverviewCollisionAvoidance(hasRoom)}
        className="w-80 overflow-hidden p-0"
      >
        <ScrollArea
          className="max-h-[var(--available-height)]"
          viewportClassName="max-h-[var(--available-height)]"
        >
          <div data-testid="thread-overview-body">
            <div data-testid="thread-overview-masthead" className="flex h-9 items-center bg-hover/20 px-3">
              <span className="text-xs font-semibold text-ink/90">Overview</span>
              <div data-testid="thread-overview-masthead-controls" className="ml-auto flex items-center gap-0.5">
                {headerActions.map(({ id, Action }) => <Action key={id} subject={subject} />)}
              </div>
            </div>
            <Separator />
            {/* Setup stays outside the padded rows until S03-02 replaces the shell. */}
            {entries.filter(entry => entry.order === 0).map(({ id, Entry }) => <Entry key={id} subject={subject} />)}
            <div className="p-1.5">
              {entries.filter(entry => entry.order !== 0).map(({ id, Entry }) => <Entry key={id} subject={subject} />)}
            </div>
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>

    <OverviewDialogs thread={thread} />
    </OverviewEntryStateProviders>
  </OverviewContext.Provider>);
}
