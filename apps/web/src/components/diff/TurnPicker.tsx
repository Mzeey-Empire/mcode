import { useEffect, useMemo } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { TurnSnapshot } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/time";
import { useDiffStore } from "@/stores/diffStore";
import { usePanelHeaderMenuOpen } from "@/components/panels/shell/PanelHeader";

// Mirrors the server's render rule in turn-diff-rpc: workspace-scoped effects
// win; when none exist the comparison falls back to files_changed. Only a
// snapshot that would render files is a pickable turn.
function renderedFileCount(s: TurnSnapshot): number {
  const workspace = s.file_effects?.effects.filter((e) => e.scope === "workspace").length ?? 0;
  return workspace > 0 ? workspace : s.files_changed.length;
}

function diffTurns(snapshots: readonly TurnSnapshot[]): TurnSnapshot[] {
  return snapshots.filter((s) => renderedFileCount(s) > 0);
}

function byCreatedAt(a: TurnSnapshot, b: TurnSnapshot): number {
  return a.created_at.localeCompare(b.created_at);
}

/** Ordinal across turns with changes only, so "Turn 2" is the 2nd pickable turn. */
function turnOrdinals(snapshots: readonly TurnSnapshot[]): Map<string, number> {
  const ordinals = new Map<string, number>();
  [...snapshots].sort(byCreatedAt).forEach((s, i) => {
    ordinals.set(s.message_id, i + 1);
  });
  return ordinals;
}

function statLabel(s: TurnSnapshot): string {
  const effects = s.file_effects;
  if (!effects) return `${s.files_changed.length} files`;
  return `${renderedFileCount(s)} files · +${effects.additions} −${effects.deletions}`;
}

/**
 * The Turn view's operand picker: a searchable dropdown over the thread's turns
 * that changed files, resolving to exactly one turn's diff. Entering the view
 * unpicked seeds the operand to the latest diff-turn, since an operand-less
 * request would resolve live state. See CONTEXT.md → "Turn view".
 */
export function TurnPicker({ threadId }: { threadId: string }) {
  const snapshots = useDiffStore((s) => s.snapshotsByThread[threadId]);
  const selectedMessageId = useDiffStore(
    (s) => s.selectedTurnMessageIdByThread[threadId],
  );
  const setReviewTurnForThread = useDiffStore((s) => s.setReviewTurnForThread);
  const [open, setOpen] = usePanelHeaderMenuOpen();

  const turns = useMemo(
    () => diffTurns(snapshots ?? []).sort(byCreatedAt).reverse(),
    [snapshots],
  );
  const ordinals = useMemo(() => turnOrdinals(turns), [turns]);
  const effectiveMessageId = selectedMessageId ?? turns[0]?.message_id ?? null;

  // Seed the operand with the latest diff-turn when the view is entered
  // unpicked: an operand-less request would resolve live state, which a picked
  // turn view must never show.
  useEffect(() => {
    if (selectedMessageId === undefined && turns.length > 0) {
      setReviewTurnForThread(threadId, turns[0]!.message_id);
    }
  }, [threadId, selectedMessageId, turns, setReviewTurnForThread]);

  if (snapshots === undefined) {
    return (
      <span className="font-mono text-caption uppercase tracking-[0.18em] text-muted/40">
        Resolving
      </span>
    );
  }
  if (turns.length === 0) {
    return (
      <span className="font-mono text-caption uppercase tracking-[0.18em] text-muted/40">
        No turns yet
      </span>
    );
  }

  const effectiveOrdinal = effectiveMessageId
    ? ordinals.get(effectiveMessageId)
    : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="compact"
            data-testid="turn-picker"
            aria-label="Select turn"
            aria-expanded={open}
            aria-haspopup="dialog"
            className={cn(
              "h-6 min-w-0 max-w-[164px] shrink justify-between gap-1.5 rounded-md px-2 font-mono text-xs font-medium",
              "text-ink shadow-none hover:bg-ink/[0.06] aria-expanded:bg-ink/[0.06]",
            )}
          >
            <span className={cn("min-w-0 text-fade", !effectiveOrdinal && "text-muted")}>
              {effectiveOrdinal ? `Turn ${effectiveOrdinal}` : "Pick a turn"}
            </span>
            <ChevronDown size={11} className="shrink-0 text-muted/65" />
          </Button>
        }
      />
      <PopoverContent align="start" sideOffset={4} className="w-72 p-0">
        <Command>
          <CommandInput
            placeholder="Search turns..."
            className="h-8 text-caption"
            data-testid="turn-picker-filter"
          />
          <CommandList>
            <CommandEmpty className="py-4 text-caption">No turns found</CommandEmpty>
            <CommandGroup heading="Turns with changes">
              {turns.map((turn) => {
                const ordinal = ordinals.get(turn.message_id) ?? 0;
                const active = turn.message_id === effectiveMessageId;
                return (
                  <CommandItem
                    key={turn.id}
                    value={`turn ${ordinal} ${statLabel(turn)}`}
                    onSelect={() => {
                      setReviewTurnForThread(threadId, turn.message_id);
                      setOpen(false);
                    }}
                    data-testid={`turn-picker-item-${turn.message_id}`}
                    aria-current={active ? "true" : undefined}
                    className="gap-2 px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1 text-fade whitespace-nowrap text-caption">
                      Turn {ordinal}
                      <span className="text-muted/60"> · {statLabel(turn)}</span>
                    </span>
                    {active ? (
                      <Check size={11} className="shrink-0 text-muted" />
                    ) : (
                      <span className="shrink-0 font-mono text-caption tabular-nums text-muted/45">
                        {relativeTime(turn.created_at)}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
