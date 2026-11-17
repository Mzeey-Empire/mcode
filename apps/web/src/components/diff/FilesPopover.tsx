import { Files } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FilesNavigator, type FilesNavigatorModel } from "./FilesNavigator";

/** Props for the Files popover that stands in for the docked pane on a narrow panel. */
interface FilesPopoverProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly disabled: boolean;
  readonly navigator: FilesNavigatorModel;
}

/** The header's Files button and the 300px popover it opens, holding the same filter and tree as the docked pane. */
export function FilesPopover({ open, onOpenChange, disabled, navigator }: FilesPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant="subtle"
            shape="round"
            aria-pressed={open}
            disabled={disabled}
            data-testid="review-files-toggle"
            className="shrink-0 text-body-small font-medium"
          />
        }
      >
        <Files aria-hidden className="@max-[400px]/review-controls:hidden" />
        Files
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="flex max-h-[min(420px,70vh)] w-[300px] flex-col overflow-hidden rounded-[18px] p-2"
        data-testid="review-files-popover"
      >
        <FilesNavigator
          {...navigator}
          autoFocusFilter
          onActivate={(path) => {
            onOpenChange(false);
            navigator.onActivate(path);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
