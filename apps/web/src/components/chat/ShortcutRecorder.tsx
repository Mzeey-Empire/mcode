import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { getKeybindings, formatKeybinding } from "@/lib/keybinding-manager";

/** Props for the ShortcutRecorder component. */
interface ShortcutRecorderProps {
  /** Current shortcut value (e.g., "mod+shift+k"). */
  value: string | undefined;
  /** Called when the user records or clears a shortcut. */
  onChange: (shortcut: string | undefined) => void;
  /** Sibling actions for conflict checking. */
  siblingShortcuts: Array<{ id: string; name: string; shortcut?: string }>;
  /** Current action ID (excluded from sibling conflict check). */
  currentActionId?: string;
}

/**
 * Press-to-record keyboard shortcut input.
 * Validates against system keybindings and sibling action shortcuts.
 */
export function ShortcutRecorder({
  value,
  onChange,
  siblingShortcuts,
  currentActionId,
}: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const isMac = navigator.platform.toLowerCase().includes("mac");

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();

      // Ignore bare modifier keys — wait for an actual key press
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

      const parts: string[] = [];
      if (e.metaKey || e.ctrlKey) parts.push("mod");
      if (e.shiftKey) parts.push("shift");
      if (e.altKey) parts.push("alt");
      parts.push(e.key.toLowerCase());
      const shortcut = parts.join("+");

      // Check system keybinding conflicts
      const systemBindings = getKeybindings();
      const systemConflict = systemBindings.find(
        (b) => b.key.toLowerCase() === shortcut.toLowerCase(),
      );
      if (systemConflict) {
        setConflict(`Used by ${systemConflict.command}`);
        return;
      }

      // Check sibling action conflicts
      const siblingConflict = siblingShortcuts.find(
        (s) =>
          s.id !== currentActionId &&
          s.shortcut?.toLowerCase() === shortcut.toLowerCase(),
      );
      if (siblingConflict) {
        setConflict(`Used by ${siblingConflict.name}`);
        return;
      }

      setConflict(null);
      setRecording(false);
      onChange(shortcut);
    },
    [recording, siblingShortcuts, currentActionId, onChange],
  );

  const handleFocus = useCallback(() => setRecording(true), []);
  const handleBlur = useCallback(() => {
    setRecording(false);
    setConflict(null);
  }, []);

  const handleClear = useCallback(() => {
    onChange(undefined);
    setConflict(null);
  }, [onChange]);

  return (
    <div className="space-y-1">
      <div
        ref={inputRef}
        tabIndex={0}
        role="textbox"
        aria-label="Press keys to record shortcut"
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={`flex h-8 items-center justify-between rounded-md border px-3 text-xs font-mono cursor-pointer
          ${recording ? "border-primary ring-1 ring-primary/30" : "border-border"}
          ${conflict ? "border-destructive" : ""}`}
      >
        {recording ? (
          <span className="text-muted-foreground">Press keys to record...</span>
        ) : value ? (
          <span>{formatKeybinding(value, isMac)}</span>
        ) : (
          <span className="text-muted-foreground/50">No shortcut</span>
        )}
        {value && !recording && (
          <Button
            variant="ghost"
            size="xs"
            onClick={(e) => {
              e.stopPropagation();
              handleClear();
            }}
            className="h-4 w-4 p-0"
          >
            <X size={10} />
          </Button>
        )}
      </div>
      {conflict && (
        <p className="text-[10px] text-destructive">{conflict}</p>
      )}
    </div>
  );
}
