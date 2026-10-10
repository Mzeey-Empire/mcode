import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ReviewTurn } from "@mcode/contracts";
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

function statLabel(turn: ReviewTurn): string {
  if (turn.availability === "snapshot-expired") return "changes gone";
  if (turn.fileCount === 0) return "no file changes";
  const files = `${turn.fileCount} ${turn.fileCount === 1 ? "file" : "files"}`;
  return turn.additions === null || turn.deletions === null
    ? files
    : `${files} · +${turn.additions} −${turn.deletions}`;
}

/** The newest turn that changed files, else the newest turn, from a newest-first list. */
function seedTurn(newestFirst: readonly ReviewTurn[]): ReviewTurn | undefined {
  return newestFirst.find((turn) => turn.fileCount > 0) ?? newestFirst[0];
}

/**
 * The Turn view's operand picker: a searchable dropdown over every turn in the
 * thread, resolving to exactly one turn's diff. Turns without file changes or
 * whose snapshots are gone stay listed so ordinals match the conversation.
 * Entering the view unpicked seeds the operand to the latest turn that changed
 * files, since an operand-less request would resolve live state. See
 * CONTEXT.md → "Turn view".
 */
export function TurnPicker({ threadId }: { threadId: string }) {
  const reviewTurns = useDiffStore((s) => s.reviewTurnsByThread[threadId]);
  const selectedMessageId = useDiffStore(
    (s) => s.selectedTurnMessageIdByThread[threadId],
  );
  const setReviewTurnForThread = useDiffStore((s) => s.setReviewTurnForThread);
  const [open, setOpen] = useState(false);

  const turns = useMemo(
    () => [...(reviewTurns ?? [])].sort((a, b) => b.ordinal - a.ordinal),
    [reviewTurns],
  );
  const seed = seedTurn(turns);
  const effectiveMessageId = selectedMessageId ?? seed?.messageId ?? null;

  // Seed the operand when the view is entered unpicked: an operand-less
  // request would resolve live state, which a picked turn view must never show.
  useEffect(() => {
    if (selectedMessageId === undefined && seed) {
      setReviewTurnForThread(threadId, seed.messageId);
    }
  }, [threadId, selectedMessageId, seed, setReviewTurnForThread]);

  if (reviewTurns === undefined) {
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

  const effectiveOrdinal = turns.find((turn) => turn.messageId === effectiveMessageId)?.ordinal;

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
            <CommandGroup heading="Turns">
              {turns.map((turn) => {
                const ordinal = turn.ordinal;
                const active = turn.messageId === effectiveMessageId;
                return (
                  <CommandItem
                    key={turn.messageId}
                    value={`turn ${ordinal} ${statLabel(turn)}`}
                    onSelect={() => {
                      setReviewTurnForThread(threadId, turn.messageId);
                      setOpen(false);
                    }}
                    data-testid={`turn-picker-item-${turn.messageId}`}
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
                        {relativeTime(turn.createdAt)}
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
