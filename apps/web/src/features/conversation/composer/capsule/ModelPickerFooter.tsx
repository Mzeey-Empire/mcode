import { ChevronUp } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AccessOptionList } from "../controls/AccessOptionList";
import type { ComposerAccessModel } from "../controls/ComposerAccessControls";
import { ComposerModelOptions, type ComposerModelPreferencesProps } from "../controls/ComposerModelPreferences";

/** Props for {@link ModelPickerFooter}. */
export interface ModelPickerFooterProps extends ComposerModelPreferencesProps {
  readonly access: ComposerAccessModel;
  /** Don't ask, or Devin's Bypass: the agent runs without approval prompts, so the access mark takes the warning colour. */
  readonly unsupervised: boolean;
}

/**
 * The model picker's footer: the selected model's options on the left and the turn's access on the right. Both apply
 * to the turn in place, so neither closes the picker. It keeps one row: too narrow for the access label, access shows
 * its icon alone, and options that still do not fit wrap on their side while access holds the first row's end.
 */
export function ModelPickerFooter({ access, unsupervised, ...preferences }: ModelPickerFooterProps) {
  return (
    <div className="@container/picker-footer flex min-w-0 items-start gap-2 @max-[340px]/picker-footer:gap-1.5">
      <ComposerModelOptions {...preferences} />
      <AccessMenu access={access} unsupervised={unsupervised} />
    </div>
  );
}

function AccessMenu({ access, unsupervised }: Pick<ModelPickerFooterProps, "access" | "unsupervised">) {
  const [open, setOpen] = useState(false);
  const Icon = access.selected.icon;
  const label = `Access: ${access.selected.label}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Names the access when only its icon shows, as the capsule's part does. */}
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="compact"
                  aria-label={label}
                  className="ml-auto h-[2.6rem] shrink-0 gap-1.5 rounded-full px-2.5 text-caption text-muted @max-[340px]/picker-footer:gap-1 @max-[340px]/picker-footer:px-2"
                />
              }
            >
              {/* A size class, not the size prop: the compact Button sizes any svg without one to 16px. */}
              <Icon aria-hidden className={cn("size-[1.2rem] shrink-0", unsupervised && "text-warning")} />
              <span className="@max-[340px]/picker-footer:hidden">{access.selected.label}</span>
              <ChevronUp aria-hidden className="size-[1.2rem]" />
            </PopoverTrigger>
          }
        />
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      {/* The list focuses its checked option itself, as the menu it stands in for does. */}
      <PopoverContent side="top" align="end" initialFocus={false} className="w-58 p-0">
        <AccessOptionList access={access} onChosen={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
