import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { type ReactElement } from "react";

/**
 * Overview rows share the menu row anatomy (see `MENU_ROW_CLASS`): 40px tall, 12px inline padding,
 * 8px gap and body-small text, with the leading icon in {@link OverviewRowIcon}'s 20px lane.
 * The card's sections bleed 12px into the card padding so that lane lines up with the title.
 */
export const OVERVIEW_ROW_CLASS =
  "group h-row-compact w-full gap-2 px-3 text-left text-body-small transition-[background-color,color] duration-150 ease-out";

/** The leading icon lane of an overview row: a 16px icon centred in a fixed 20px slot. */
export function OverviewRowIcon({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center text-muted transition-colors duration-150 group-hover:text-ink/80 [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Renders children only when an Overview row should be visible. */
export function ThreadOverviewWhen({ when, children }: { when: boolean; children: React.ReactNode }) {
  return when ? <>{children}</> : null;
}

/** Keeps a disabled button's tooltip reachable through an enabled trigger. */
export function ThreadOverviewTooltipButton({
  content,
  disabled = false,
  children,
}: {
  content: string;
  disabled?: boolean;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={disabled ? <span className="inline-flex">{children}</span> : children}
      />
      <TooltipContent>{content}</TooltipContent>
    </Tooltip>
  );
}

/** Loading states used by the changes and repository entries. */
export type LoadStatus = "idle" | "loading" | "ready" | "error";
