import { PopoverContent } from "@/components/ui/popover";
import { sidePlacement } from "@/components/ui/side-placement";
import { cn } from "@/lib/utils";
import type { ReactNode, RefObject } from "react";

/** Props for {@link OverviewSideMenu}. */
interface OverviewSideMenuProps {
  /** The card row that opened the menu. */
  rowRef: RefObject<Element | null>;
  className?: string;
  children: ReactNode;
}

/** Popover content for a card row's menu: left of the card with an 8px gap, top 4px above the row. */
export function OverviewSideMenu({ rowRef, className, children }: OverviewSideMenuProps) {
  return (
    <PopoverContent {...sidePlacement(rowRef)} className={cn("p-0", className)}>
      {children}
    </PopoverContent>
  );
}
