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
  /** Attached capabilities the menu shows checked but cannot turn off; their own chip does. */
  lockedCapabilityIds: ReadonlySet<ComposerCapabilityId>;
  /** Toggles Plan and a pending Goal, and attaches orchestration. */
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
  lockedCapabilityIds,
  onAttachCapability,
  getComposerRect,
}: ComposerAddMenuProps) {
  const [anchor, setAnchor] = useState<ComposerAnchor | undefined>(undefined);

  const handleOpenChange = (open: boolean) => {
    if (!open) return;
    const rect = getComposerRect();
    setAnchor(rect ? { getBoundingClientRect: () => rect } : undefined);
  };

  const afterClose = (action: () => void) => () => requestAnimationFrame(action);

  const addButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-compact"
      aria-label="Add to composer"
      data-testid="composer-add"
      disabled={disabled}
      className="size-8 shrink-0 rounded-full text-muted hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-50"
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
        className="w-58"
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
                    disabled={lockedCapabilityIds.has(capability.id)}
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
