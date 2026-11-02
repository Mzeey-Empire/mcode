import { useState } from "react";
import { FilePlusCorner, Goal, ListChecks, Network, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  ComposerCapabilityId,
  ResolvedComposerCapability,
} from "@/features/conversation/composer/composer-capabilities";

interface ComposerAddMenuProps {
  disabled: boolean;
  onAttachFiles: () => void;
  capabilities: readonly ResolvedComposerCapability[];
  attachedCapabilityIds: ReadonlySet<ComposerCapabilityId>;
  /** Toggles Plan and attaches the others, so only Plan stays choosable while it is on. */
  onAttachCapability: (capabilityId: ComposerCapabilityId) => void;
  getComposerRect: () => DOMRect | null;
}

const CAPABILITY_ICONS = {
  plan: ListChecks,
  goal: Goal,
  orchestration: Network,
} satisfies Record<ComposerCapabilityId, typeof ListChecks>;

/** Opens above the composer's left edge rather than under the small `+` button. */
type ComposerAnchor = { readonly getBoundingClientRect: () => DOMRect };

/**
 * Compact menu for adding files or attaching capabilities to the composer.
 */
export function ComposerAddMenu({
  disabled,
  onAttachFiles,
  capabilities,
  attachedCapabilityIds,
  onAttachCapability,
  getComposerRect,
}: ComposerAddMenuProps) {
  const [anchor, setAnchor] = useState<ComposerAnchor | undefined>(undefined);

  const handleOpenChange = (open: boolean) => {
    if (!open) return;
    const rect = getComposerRect();
    setAnchor(rect ? { getBoundingClientRect: () => rect } : undefined);
  };

  // Deferred a frame so the menu has closed and returned focus before the action moves it to the editor or a file dialog.
  const afterClose = (action: () => void) => () => requestAnimationFrame(action);

  const addButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-compact"
      aria-label="Add to composer"
      data-testid="composer-add"
      disabled={disabled}
      className="size-8 shrink-0 rounded-lg text-muted hover:bg-hover/40 hover:text-ink disabled:pointer-events-none disabled:opacity-50"
    >
      <Plus size={16} aria-hidden />
    </Button>
  );
  const trigger = <DropdownMenuTrigger render={addButton} />;

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger render={disabled ? <span className="inline-flex">{trigger}</span> : trigger} />
        <TooltipContent>Add to composer</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        data-testid="composer-add-menu"
        aria-label="Add to composer"
        anchor={anchor}
        side="top"
        align="start"
        sideOffset={8}
        className="w-56"
      >
        <DropdownMenuGroup>
          <DropdownMenuGroupLabel>Attach</DropdownMenuGroupLabel>
          <DropdownMenuItem label="Files" icon={<FilePlusCorner />} onClick={afterClose(onAttachFiles)} />
        </DropdownMenuGroup>
        {capabilities.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuGroupLabel>Capabilities</DropdownMenuGroupLabel>
              {capabilities.map((capability) => {
                const Icon = CAPABILITY_ICONS[capability.id];
                const attached = attachedCapabilityIds.has(capability.id);
                return (
                  <DropdownMenuCheckboxItem
                    key={capability.id}
                    label={capability.label}
                    icon={<Icon />}
                    checked={attached}
                    disabled={attached && capability.id !== "plan"}
                    closeOnClick
                    onCheckedChange={afterClose(() => onAttachCapability(capability.id))}
                  />
                );
              })}
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
