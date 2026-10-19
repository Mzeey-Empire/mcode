import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ComposerCapabilityChipProps {
  /** Stable label shown for the attached composer capability. */
  label: string;
  /** Icon that identifies the capability in the compact composer row. */
  icon: LucideIcon;
  /** Accessible name and tooltip for the chip, which turns the capability off. */
  turnOffLabel: string;
  /** Turns the attached capability off. */
  onTurnOff: () => void;
  /** Optional stable selector for focused UI verification. */
  testId?: string;
}

/** Renders an attached composer capability as a neutral chip; clicking it turns the capability off. */
export function ComposerCapabilityChip({
  label,
  icon: Icon,
  turnOffLabel,
  onTurnOff,
  testId,
}: ComposerCapabilityChipProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="subtle"
            data-testid={testId}
            onClick={onTurnOff}
            aria-label={turnOffLabel}
            className="h-8 shrink-0 gap-1.5 rounded-control bg-selected px-2 text-body-small text-ink"
          >
            <Icon size={16} className="text-ink" aria-hidden />
            <span>{label}</span>
          </Button>
        }
      />
      <TooltipContent>{turnOffLabel}</TooltipContent>
    </Tooltip>
  );
}
