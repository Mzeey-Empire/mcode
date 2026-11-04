import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { resolveIconByName, type ResolvedIcon } from "@/lib/material-icons";
import { useAppearance } from "@/hooks/useTheme";
import { ACTION_ICONS, resolveActionIconId } from "./action-icons";

/** Props for {@link ActionIcon}. */
export interface ActionIconProps {
  /** Stored icon id. Unknown or missing ids draw the default derived from `command`. */
  iconId?: string | undefined;
  /** The action's script, used to derive the default icon. */
  command: string;
  /** Slot edge in px. */
  size?: 14 | 16 | 18;
  className?: string;
}

/**
 * An action's icon in a fixed square slot. The Lucide glyph draws first and the tool's
 * Material icon swaps in when the CDN fetch lands, so the slot never changes size and
 * an offline machine keeps the glyph.
 */
export function ActionIcon({ iconId, command, size = 16, className }: ActionIconProps) {
  const id = resolveActionIconId(iconId, command);
  const entry = ACTION_ICONS[id];
  const toolIcon = entry.kind === "tool" ? entry.materialIcon : null;
  const fallback = entry.kind === "tool" ? entry.fallback : entry.icon;
  const Glyph = fallback;
  const appearance = useAppearance();
  const [resolved, setResolved] = useState<{ readonly name: string; readonly icon: ResolvedIcon } | null>(null);

  useEffect(() => {
    if (!toolIcon) return;
    let cancelled = false;
    void resolveIconByName(toolIcon, fallback, appearance).then((icon) => {
      if (!cancelled) setResolved({ name: toolIcon, icon });
    });
    return () => {
      cancelled = true;
    };
  }, [toolIcon, fallback, appearance]);

  const slot = cn("inline-flex shrink-0 items-center justify-center", className);
  const slotStyle = { width: size, height: size };
  const image = resolved?.name === toolIcon && resolved.icon.type === "image" ? resolved.icon.url : null;

  return (
    <span data-testid="action-icon" data-icon-id={id} className={slot} style={slotStyle}>
      {image ? (
        <img src={image} alt="" aria-hidden="true" width={size} height={size} />
      ) : (
        <Glyph aria-hidden="true" width={size} height={size} className={entry.tint} />
      )}
    </span>
  );
}
