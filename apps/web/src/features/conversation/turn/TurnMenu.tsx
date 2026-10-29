import { useState, type Ref } from "react";
import { Copy, Diff, Ellipsis, Undo } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** Props for {@link TurnMenu}. */
export interface TurnMenuProps {
  /** Opens Review on this turn. */
  readonly onReviewChanges: () => void;
  /** Copies every path the turn changed. */
  readonly onCopyFilePaths: () => void;
  /** Opens the revert confirm under the bar. */
  readonly onRevertTurn: () => void;
  /** Why the turn cannot be reverted, when the client already knows. */
  readonly revertDisabledReason: string | null;
  readonly triggerRef?: Ref<HTMLButtonElement>;
}

/** The ⋯ menu at the end of a turn's changes bar. */
export function TurnMenu({ onReviewChanges, onCopyFilePaths, onRevertTurn, revertDisabledReason, triggerRef }: TurnMenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        ref={triggerRef}
        aria-label="Turn actions"
        className={cn(
          "flex size-[2.8rem] shrink-0 items-center justify-center rounded-sm text-muted outline-none transition-colors hover:bg-hover hover:text-ink focus-visible:ring-1 focus-visible:ring-focus",
          open && "bg-hover",
        )}
      >
        <Ellipsis aria-hidden size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="w-[24rem]">
        <DropdownMenuItem
          label="Review changes"
          icon={<Diff />}
          onClick={onReviewChanges}
        />
        <DropdownMenuItem
          label="Copy file paths"
          icon={<Copy />}
          onClick={onCopyFilePaths}
        />
        <DropdownMenuItem
          label="Revert this turn…"
          icon={<Undo />}
          destructive
          disabledReason={revertDisabledReason}
          onClick={onRevertTurn}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
