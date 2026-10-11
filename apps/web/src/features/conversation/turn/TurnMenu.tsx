import { useState } from "react";
import { Copy, Diff, Ellipsis } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** Paper's turn menu rows (161H-0) are 32px tall with a 6px radius, tighter than the default menu row. */
const TURN_MENU_ROW_CLASS = "h-row-compact rounded-sm";

/** Props for {@link TurnMenu}. */
export interface TurnMenuProps {
  /** Opens Review on this turn. */
  readonly onReviewChanges: () => void;
  /** Copies every path the turn changed. */
  readonly onCopyFilePaths: () => void;
}

/** The ⋯ menu at the end of a turn's changes bar. */
export function TurnMenu({ onReviewChanges, onCopyFilePaths }: TurnMenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label="Turn actions"
        className={cn(
          "flex size-[2.8rem] shrink-0 items-center justify-center rounded-sm text-muted outline-none transition-colors hover:bg-hover hover:text-ink focus-visible:ring-1 focus-visible:ring-focus",
          open && "bg-hover",
        )}
      >
        <Ellipsis aria-hidden size={14} strokeWidth={1.5} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="w-[24rem] gap-0 p-1">
        <DropdownMenuItem
          label="Review changes"
          icon={<Diff />}
          className={TURN_MENU_ROW_CLASS}
          onClick={onReviewChanges}
        />
        <DropdownMenuItem
          label="Copy file paths"
          icon={<Copy />}
          className={TURN_MENU_ROW_CLASS}
          onClick={onCopyFilePaths}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
