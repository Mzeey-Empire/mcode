import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { resolveIconByName, type ResolvedIcon } from "@/lib/vscode-icons";
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
 * vscode-icons mark swaps in when the CDN fetch lands, so the slot never changes size and
 * an offline machine keeps the glyph.
 */
export function ActionIcon({ iconId, command, size = 16, className }: ActionIconProps) {
  const id = resolveActionIconId(iconId, command);
  const entry = ACTION_ICONS[id];
  const toolFile = entry.kind === "tool" ? entry.file : null;
  const fallback = entry.kind === "tool" ? entry.fallback : entry.icon;
  const Glyph = fallback;
  const [resolved, setResolved] = useState<{ readonly file: string; readonly icon: ResolvedIcon } | null>(null);

  useEffect(() => {
    if (!toolFile) return;
    let cancelled = false;
    void resolveIconByName(toolFile, fallback).then((icon) => {
      if (!cancelled) setResolved({ file: toolFile, icon });
    });
    return () => {
      cancelled = true;
    };
  }, [toolFile, fallback]);

  const slot = cn("inline-flex shrink-0 items-center justify-center", className);
  const slotStyle = { width: size, height: size };
  const image = resolved?.file === toolFile && resolved.icon.type === "vscode" ? resolved.icon.url : null;

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
