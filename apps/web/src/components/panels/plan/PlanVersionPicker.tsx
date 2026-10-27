import { ChevronDown } from "lucide-react";
import type { PlanVersion } from "@mcode/contracts/models/plan";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePanelHeaderMenuOpen } from "@/components/panels/shell/PanelHeader";
import { planVersionWord, usePlanStore } from "@/stores/planStore";

/** Props for {@link PlanVersionPicker}. */
interface PlanVersionPickerProps {
  readonly threadId: string;
  /** Every version of the thread's plan, oldest first. */
  readonly versions: readonly PlanVersion[];
  /** The version the panel is showing. */
  readonly viewed: PlanVersion;
}

/**
 * Header control that names the viewed plan version ("v2 Codex") and lists
 * every version, newest first. Picking the latest clears the pin so new
 * versions show as they arrive.
 */
export function PlanVersionPicker({ threadId, versions, viewed }: PlanVersionPickerProps) {
  const [open, setOpen] = usePanelHeaderMenuOpen();
  const setActiveVersion = usePlanStore((s) => s.setActiveVersion);
  const latest = versions.at(-1)?.version ?? viewed.version;
  const newestFirst = [...versions].reverse();
  const word = planVersionWord(viewed);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="compact"
            aria-label={`Plan version: v${viewed.version} ${word}`}
            data-testid="plan-version-picker"
            className="h-8 min-w-0 shrink gap-1.5 px-2.5 text-sm"
          >
            <span className="shrink-0 font-medium text-ink">v{viewed.version}</span>
            <span className="text-fade min-w-0 text-muted">{word}</span>
            <ChevronDown aria-hidden className="size-3 shrink-0 text-muted" />
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        {newestFirst.map((version) => (
          <DropdownMenuItem
            key={version.id}
            label={`v${version.version} ${planVersionWord(version)}`}
            checked={version.version === viewed.version}
            onClick={() => setActiveVersion(threadId, version.version === latest ? null : version.version)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
