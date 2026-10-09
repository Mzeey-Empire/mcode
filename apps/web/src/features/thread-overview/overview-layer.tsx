import { createContext, useContext, useState, type ReactNode } from "react";

const OverviewLayerContext = createContext<HTMLElement | null>(null);

/** The chat canvas element that hosts the docked Overview card, or null outside a chat canvas. */
export function useOverviewLayer(): HTMLElement | null {
  return useContext(OverviewLayerContext);
}

/**
 * Covers the chat canvas with a click-through layer for the Overview card. The header button owns
 * the card's state but sits inside the header, so the card portals here to dock against the canvas
 * corner instead of the button.
 */
export function OverviewLayer({ children }: { children: ReactNode }) {
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  return (
    <OverviewLayerContext.Provider value={layer}>
      {children}
      <div ref={setLayer} data-overview-layer className="pointer-events-none absolute inset-0 z-(--layer-floating-panel)" />
    </OverviewLayerContext.Provider>
  );
}
