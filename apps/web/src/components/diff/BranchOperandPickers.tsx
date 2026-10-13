import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { BranchComparison, GitRef, GitRefSide } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { PICKER_PANEL_CLASS, Picker, type PickerRow, type PickerTab } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { usePanelHeaderMenuOpen } from "@/components/panels/shell/PanelHeader";
import { useDebouncedQuery } from "@/features/conversation/composer/execution/targets/useBranchTargets";
import { cn } from "@/lib/utils";
import { getTransport } from "@/transport";
import { branchScopeKey, branchSelectionFor, refLabel, useDiffStore, type BranchSelection } from "@/stores/diffStore";
import { invalidateReviewOperandLists, pickerStatus, useReviewRefs } from "./review-operand-lists";

type OperandSide = keyof BranchSelection;

const SIDE_TABS: readonly PickerTab[] = [
  { id: "local", label: "Local" },
  { id: "origin", label: "Origin" },
];

const SIDE_LABEL: Record<GitRefSide, string> = { local: "Local", origin: "Origin" };

const lastTabBySide: Record<OperandSide, GitRefSide> = { base: "origin", compare: "local" };

const UNAVAILABLE: BranchComparison = { base: null, compare: null, isUnborn: false, isComparisonAvailable: false };

function useResolveBranchComparison(workspaceId: string, threadId: string | undefined, diffScopeRevision: number) {
  const key = branchScopeKey(workspaceId, threadId);
  const comparison = useDiffStore((s) => (s.branchComparisonKey === key ? s.branchComparison : null));
  const resolveBranchComparison = useDiffStore((s) => s.resolveBranchComparison);

  useEffect(() => {
    const state = useDiffStore.getState();
    if (
      state.branchComparisonKey === key &&
      state.branchComparison &&
      state.branchResolvedRevisionByScope[key] === diffScopeRevision
    ) return;
    let cancelled = false;
    void getTransport()
      .getBranchComparison(workspaceId, threadId)
      .catch(() => UNAVAILABLE)
      .then((result) => {
        if (cancelled) return;
        resolveBranchComparison(result, key, diffScopeRevision);
      });
    return () => {
      cancelled = true;
    };
  }, [key, workspaceId, threadId, diffScopeRevision, resolveBranchComparison]);

  return comparison;
}

interface BranchOperandPickersProps {
  readonly workspaceId: string;
  readonly threadId?: string;
  /** Bumps when git state changes in this scope; re-resolves the default and refetches open lists. */
  readonly diffScopeRevision: number;
}

/**
 * The Branch view's operands, `compare ⌄ → base ⌄`. Each side picks any local or origin ref, so a diverged local
 * branch can be compared with its remote twin. The pick is stored per scope as qualified names and diffed as
 * `${base}...${compare}`.
 */
export function BranchOperandPickers({ workspaceId, threadId, diffScopeRevision }: BranchOperandPickersProps) {
  const comparison = useResolveBranchComparison(workspaceId, threadId, diffScopeRevision);
  const key = branchScopeKey(workspaceId, threadId);
  const selection = useDiffStore((s) => s.branchSelectionByScope[key]);
  const setBranchSelection = useDiffStore((s) => s.setBranchSelection);
  const clearBranchSelection = useDiffStore((s) => s.clearBranchSelection);

  useEffect(() => {
    if (diffScopeRevision > 0) invalidateReviewOperandLists(workspaceId);
  }, [workspaceId, diffScopeRevision]);

  if (!comparison) return <OperandPlaceholder>Resolving</OperandPlaceholder>;
  if (comparison?.isUnborn) return <OperandPlaceholder>No commits yet</OperandPlaceholder>;

  const sides = branchSelectionFor(comparison, selection);
  const pick = (side: OperandSide, ref: string) => setBranchSelection(key, { ...sides, [side]: ref });
  const reset = selection ? () => clearBranchSelection(key) : undefined;
  return (
    <div className="flex min-w-0 items-center gap-1" data-testid="branch-operand-pickers" role="group" aria-label="Branch comparison">
      <RefSidePicker side="compare" value={sides.compare} workspaceId={workspaceId} threadId={threadId} onPick={pick} onReset={reset} />
      <span aria-hidden className="shrink-0 font-mono text-caption text-muted">→</span>
      <RefSidePicker side="base" value={sides.base} workspaceId={workspaceId} threadId={threadId} onPick={pick} onReset={reset} />
    </div>
  );
}

function OperandPlaceholder({ children }: { readonly children: string }) {
  return <span className="font-mono text-caption uppercase tracking-[0.18em] text-muted/40">{children}</span>;
}

interface RefSidePickerProps {
  readonly side: OperandSide;
  readonly value: string | null;
  readonly workspaceId: string;
  readonly threadId: string | undefined;
  readonly onPick: (side: OperandSide, ref: string) => void;
  readonly onReset: (() => void) | undefined;
}

function RefSidePicker({ side, value, workspaceId, threadId, onPick, onReset }: RefSidePickerProps) {
  const [open, setOpen] = usePanelHeaderMenuOpen();
  const label = value === null ? (side === "base" ? "Pick a base" : "Pick a ref") : refLabel(value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="compact"
            data-testid={`branch-${side}-picker`}
            aria-label={`${side === "compare" ? "Compare" : "Base"}: ${label}`}
            aria-expanded={open}
            aria-haspopup="dialog"
            className={cn(
              "h-8 min-w-0 max-w-[16.4rem] shrink justify-between gap-1.5 rounded-md px-2 font-mono text-caption",
              "text-ink shadow-none aria-expanded:bg-selected",
            )}
          >
            <span className={cn("min-w-0 text-fade", value === null && "text-muted")}>
              {label}
            </span>
            <ChevronDown size={11} className="shrink-0 text-muted/65" />
          </Button>
        }
      />
      <PopoverContent align="start" side="bottom" sideOffset={4} className={PICKER_PANEL_CLASS}>
        {open ? (
          <RefSideList
            side={side}
            value={value}
            workspaceId={workspaceId}
            threadId={threadId}
            onPick={(ref) => {
              onPick(side, ref);
              setOpen(false);
            }}
            onReset={onReset && (() => {
              onReset();
              setOpen(false);
            })}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

interface RefSideListProps {
  readonly side: OperandSide;
  readonly value: string | null;
  readonly workspaceId: string;
  readonly threadId: string | undefined;
  readonly onPick: (ref: string) => void;
  readonly onReset: (() => void) | undefined;
}

function RefSideList({ side, value, workspaceId, threadId, onPick, onReset }: RefSideListProps) {
  const [tab, setTab] = useState<GitRefSide>(lastTabBySide[side]);
  const [query, setQuery] = useState("");
  const searched = useDebouncedQuery(query);
  const list = useReviewRefs({ workspaceId, threadId, side: tab, query: searched });
  const otherTab: GitRefSide = tab === "local" ? "origin" : "local";
  const empty = list.status.kind === "ready" && list.items.length === 0;
  const other = useReviewRefs(searched !== "" || empty ? { workspaceId, threadId, side: otherTab, query: searched, limit: 1 } : null);
  const otherMatches = other.total ?? 0;

  const changeTab = (id: string) => {
    const next: GitRefSide = id === "origin" ? "origin" : "local";
    lastTabBySide[side] = next;
    setTab(next);
  };
  const renderRow = (ref: GitRef): PickerRow => ({
    key: ref.fullName,
    name: ref.remote === "origin" ? ref.branchName : ref.shortName,
    mono: true,
  });

  return (
    <Picker
      tabs={SIDE_TABS}
      activeTab={tab}
      onTabChange={changeTab}
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search branches"
      items={list.items}
      total={list.total}
      onLoadMore={list.loadMore}
      status={pickerStatus(list.status)}
      onRetry={list.retry}
      selectedKey={value ?? undefined}
      renderItem={renderRow}
      emptySwitch={otherMatches > 0 ? { tabId: otherTab, label: `${otherMatches} in ${SIDE_LABEL[otherTab]}` } : undefined}
      onSelect={(ref) => onPick(ref.fullName)}
      footer={onReset ? (
        <Button type="button" variant="ghost" size="compact" className="w-full justify-start px-2" onClick={onReset}>
          Reset to default
        </Button>
      ) : undefined}
    />
  );
}
