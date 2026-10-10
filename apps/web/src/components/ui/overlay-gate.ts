import { createContext, useCallback, useContext, useState } from "react";

/**
 * Whether popups rendered under this subtree may show. Popups portal to the
 * body, so hiding or detaching their owner (an inactive panel tool, a closed
 * panel) leaves them floating over whatever replaced it. A false gate holds
 * every popup root below it closed.
 */
export const OverlayGateContext = createContext(true);

interface GatedOpenProps<Details> {
  readonly open?: boolean | undefined;
  readonly defaultOpen?: boolean | undefined;
  readonly onOpenChange?: ((open: boolean, details: Details) => void) | undefined;
}

/**
 * Open state for a popup root under an overlay gate. The gate overrides both
 * controlled and uncontrolled popups; an uncontrolled one also forgets it was
 * open, so it stays closed when the gate reopens.
 */
export function useGatedOpen<Details>({ open, defaultOpen = false, onOpenChange }: GatedOpenProps<Details>) {
  const gateOpen = useContext(OverlayGateContext);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  if (!gateOpen && uncontrolledOpen) setUncontrolledOpen(false);
  const handleOpenChange = useCallback(
    (next: boolean, details: Details) => {
      setUncontrolledOpen(next);
      onOpenChange?.(next, details);
    },
    [onOpenChange],
  );
  return { open: gateOpen && (open ?? uncontrolledOpen), onOpenChange: handleOpenChange };
}
