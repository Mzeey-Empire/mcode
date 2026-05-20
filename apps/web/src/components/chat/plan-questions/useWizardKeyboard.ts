import { useEffect } from "react";

/** Discriminated action union returned by the key resolver. */
export type WizardKeyAction =
  | { type: "selectOption"; index: number }
  | { type: "advance" }
  | { type: "previous" }
  | { type: "deselect" }
  | { type: "cancel" };

/**
 * Pure function: given a keyboard event and wizard state, returns
 * the action to take or null if the key is not handled.
 */
export function resolveWizardKeyAction(
  e: KeyboardEvent,
  optionCount: number,
  selectedIndex: number,
  hasSelection: boolean,
): WizardKeyAction | null {
  const tag = (e.target as HTMLElement)?.tagName;
  const isTextInput = tag === "TEXTAREA" || tag === "INPUT";

  // Alt+ArrowLeft: always goes to previous (even in text inputs)
  if (e.altKey && e.key === "ArrowLeft") {
    return { type: "previous" };
  }

  // Enter / Ctrl+Enter: advance to next question or submit
  if (e.key === "Enter") {
    return { type: "advance" };
  }

  // Escape: deselect if selected, cancel if not
  if (e.key === "Escape") {
    return hasSelection ? { type: "deselect" } : { type: "cancel" };
  }

  // Everything below is suppressed when a text input is focused
  if (isTextInput) return null;

  // Backspace: go to previous question
  if (e.key === "Backspace") {
    return { type: "previous" };
  }

  // Number keys 1-5: select option by 1-indexed number
  const num = parseInt(e.key, 10);
  if (num >= 1 && num <= 5) {
    const idx = num - 1;
    return idx < optionCount ? { type: "selectOption", index: idx } : null;
  }

  // Arrow keys: cycle through options with wrapping
  if (
    e.key === "ArrowDown" ||
    e.key === "ArrowRight" ||
    e.key === "ArrowUp" ||
    e.key === "ArrowLeft"
  ) {
    const forward = e.key === "ArrowDown" || e.key === "ArrowRight";
    if (selectedIndex < 0) {
      return { type: "selectOption", index: 0 };
    }
    const next = forward
      ? (selectedIndex + 1) % optionCount
      : (selectedIndex - 1 + optionCount) % optionCount;
    return { type: "selectOption", index: next };
  }

  return null;
}

interface UseWizardKeyboardOptions {
  /** Whether the keyboard shortcuts are active. */
  enabled: boolean;
  /** Total number of option tiles (including the "Other" tile). */
  optionCount: number;
  /** Currently focused option index (0-based). -1 if none. */
  selectedIndex: number;
  /** Whether any option is currently selected. */
  hasSelection: boolean;
  /** Called when a number key or arrow selects an option by index. */
  onSelectOption: (index: number) => void;
  /** Advance to next question or submit on last. */
  onAdvance: () => void;
  /** Go to previous question. */
  onPrevious: () => void;
  /** Deselect the current option. */
  onDeselect: () => void;
  /** Cancel the wizard entirely. */
  onCancel: () => void;
}

/**
 * Attaches a global keydown listener for wizard keyboard shortcuts.
 * Delegates to `resolveWizardKeyAction` for the pure key-to-action mapping.
 */
export function useWizardKeyboard({
  enabled,
  optionCount,
  selectedIndex,
  hasSelection,
  onSelectOption,
  onAdvance,
  onPrevious,
  onDeselect,
  onCancel,
}: UseWizardKeyboardOptions): void {
  useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent) => {
      const action = resolveWizardKeyAction(e, optionCount, selectedIndex, hasSelection);
      if (!action) return;
      e.preventDefault();

      switch (action.type) {
        case "selectOption":
          onSelectOption(action.index);
          break;
        case "advance":
          onAdvance();
          break;
        case "previous":
          onPrevious();
          break;
        case "deselect":
          onDeselect();
          break;
        case "cancel":
          onCancel();
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, optionCount, selectedIndex, hasSelection, onSelectOption, onAdvance, onPrevious, onDeselect, onCancel]);
}
