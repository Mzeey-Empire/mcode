import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type ReactElement } from "react";

/** Existing row spacing and interaction styles shared by overview entries. */
export const OVERVIEW_ROW_CLASS =
  "group h-8 w-full gap-3 px-2 text-left transition-[background-color,color,transform] duration-150 ease-out active:translate-y-px motion-reduce:transform-none";

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
