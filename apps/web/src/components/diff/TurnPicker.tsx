import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ReviewTurn } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { PICKER_PANEL_CLASS, Picker, type PickerRow } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { matchesAllTokens, tokenizeSearch } from "@/lib/searchTokens";
import { useDiffStore } from "@/stores/diffStore";
import { usePanelHeaderMenuOpen } from "@/components/panels/shell/PanelHeader";

function statLabel(turn: ReviewTurn): string {
  if (turn.availability === "snapshot-expired") return "changes gone";
  if (turn.fileCount === 0) return "no file changes";
  const files = `${turn.fileCount} ${turn.fileCount === 1 ? "file" : "files"}`;
  return turn.additions === null || turn.deletions === null
    ? files
    : `${files} +${turn.additions} -${turn.deletions}`;
}

/**
 * The picker's rows, newest first: every turn that changed files, plus the
 * latest turn even without changes, since following latest must stay
 * selectable while the newest turn is still answering.
 */
function turnPickerRows(turns: readonly ReviewTurn[]): readonly ReviewTurn[] {
  const newestFirst = [...turns].sort((a, b) => b.ordinal - a.ordinal);
  return newestFirst.filter((turn, index) => index === 0 || turn.fileCount > 0);
}

function TurnPickerPlaceholder({ children }: { readonly children: string }) {
  return (
    <span className="font-mono text-caption uppercase tracking-[0.18em] text-muted/40">
      {children}
    </span>
  );
}

/**
 * The Turn view's operand picker. It follows the latest turn until the user
 * pins an older one; picking the newest row returns to following. Ordinals
 * come from the server so they match the conversation. See CONTEXT.md,
 * "Turn view".
 */
export function TurnPicker({ threadId }: { threadId: string }) {
  const reviewTurns = useDiffStore((s) => s.reviewTurnsByThread[threadId]);
  const reviewTurnsError = useDiffStore((s) => s.reviewTurnsErrorByThread[threadId]);
  const selection = useDiffStore((s) => s.selectedTurnByThread[threadId] ?? "latest");
  const setReviewTurnForThread = useDiffStore((s) => s.setReviewTurnForThread);
  const [open, setOpen] = usePanelHeaderMenuOpen();
  const [query, setQuery] = useState("");

  const rows = useMemo(() => turnPickerRows(reviewTurns ?? []), [reviewTurns]);
  const filtered = useMemo(() => {
    const tokens = tokenizeSearch(query);
    return rows.filter((turn) => matchesAllTokens([`Turn ${turn.ordinal}`, statLabel(turn)], tokens));
  }, [query, rows]);

  if (reviewTurns === undefined) {
    return <TurnPickerPlaceholder>{reviewTurnsError === undefined ? "Resolving" : "Turns unavailable"}</TurnPickerPlaceholder>;
  }
  const latest = rows[0];
  if (!latest) return <TurnPickerPlaceholder>No turns yet</TurnPickerPlaceholder>;

  const following = selection === "latest";
  const selectedMessageId = following ? latest.messageId : selection;
  const selectedOrdinal = reviewTurns.find((turn) => turn.messageId === selectedMessageId)?.ordinal;
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setQuery("");
  };
  const renderRow = (turn: ReviewTurn): PickerRow => ({
    key: turn.messageId,
    name: `Turn ${turn.ordinal}`,
    tag: turn === latest ? "latest" : undefined,
    description: statLabel(turn),
  });

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="compact"
            data-testid="turn-picker"
            data-following={following}
            aria-label="Select turn"
            aria-expanded={open}
            aria-haspopup="dialog"
            className={cn(
              "h-6 min-w-0 max-w-[164px] shrink justify-between gap-1.5 rounded-md px-2 font-mono text-xs font-medium",
              "text-ink shadow-none hover:bg-ink/[0.06] aria-expanded:bg-ink/[0.06]",
            )}
          >
            <span className="min-w-0 text-fade">
              {selectedOrdinal === undefined ? "Pick a turn" : `Turn ${selectedOrdinal}`}
              {following ? <span data-testid="turn-picker-latest" className="text-muted"> latest</span> : null}
            </span>
            <ChevronDown size={11} className="shrink-0 text-muted/65" />
          </Button>
        }
      />
      <PopoverContent align="start" side="bottom" sideOffset={4} className={PICKER_PANEL_CLASS}>
        <Picker
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder="Search turns"
          items={filtered}
          total={null}
          status="ready"
          selectedKey={selectedMessageId}
          renderItem={renderRow}
          onSelect={(turn) => {
            // The newest row means "follow", so a turn that starts later replaces it.
            setReviewTurnForThread(threadId, turn === latest ? "latest" : turn.messageId);
            handleOpenChange(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
