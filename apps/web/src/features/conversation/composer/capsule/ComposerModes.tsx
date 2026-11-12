import { Goal, ListChecks, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** One mode shown beside `+`. */
export interface ComposerModeView {
  readonly id: "plan" | "goal";
  readonly label: string;
  readonly onRemove: () => void;
}

const MODE_ICONS: Record<ComposerModeView["id"], LucideIcon> = {
  plan: ListChecks,
  goal: Goal,
};

function ModeDivider() {
  return <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />;
}

function ComposerMode({ mode, iconOnly }: { readonly mode: ComposerModeView; readonly iconOnly: boolean }) {
  const Icon = MODE_ICONS[mode.id];
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <span
            data-testid={`composer-mode-${mode.id}`}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full pr-0.5 pl-[9px] text-compact whitespace-nowrap text-ink",
              // Below 680px the capsule's container query drops the names, as two modes always do.
              "@max-[680px]/capsule:gap-0.5 @max-[680px]/capsule:pl-[7px]",
              iconOnly && "gap-0.5 pl-[7px]",
            )}
          />
        )}
      >
        <Icon size={14} aria-hidden className="shrink-0 text-muted" />
        <span className={cn("@max-[680px]/capsule:hidden", iconOnly && "hidden")}>{mode.label}</span>
        <button
          type="button"
          aria-label={`Remove ${mode.label}`}
          onClick={mode.onRemove}
          className="grid size-6 place-items-center rounded-full text-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
        >
          <X size={12} aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent>{mode.label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * `+` and the modes that are on, in one pill divided like the split capsule. With no mode on, `+` stays a bare
 * button. One mode shows its name; two would push the draft far right, so both drop to icons, as on narrow widths.
 */
export function ComposerModes({ add, modes }: { readonly add: ReactNode; readonly modes: readonly ComposerModeView[] }) {
  const iconOnly = modes.length > 1;
  return (
    <div
      data-testid="composer-modes"
      className={cn("flex shrink-0 items-center", modes.length > 0 && "h-9 rounded-full bg-panel p-0.5")}
    >
      {add}
      {modes.map((mode) => (
        <span key={mode.id} className="contents">
          <ModeDivider />
          <ComposerMode mode={mode} iconOnly={iconOnly} />
        </span>
      ))}
    </div>
  );
}
