import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Where the pooled terminal view can display: the right-panel Terminal tab, or
 * the provider sign-in dialog that shows the home scope.
 */
export type TerminalPoolSurface = "panel" | "dialog";

interface TerminalPoolSlotContextValue {
  readonly slotEls: Readonly<Record<TerminalPoolSurface, HTMLDivElement | null>>;
  readonly setPanelSlotRef: (el: HTMLDivElement | null) => void;
  readonly setDialogSlotRef: (el: HTMLDivElement | null) => void;
  readonly offScreenEl: HTMLDivElement | null;
  readonly setOffScreenRef: (el: HTMLDivElement | null) => void;
}

const TerminalPoolSlotContext = createContext<TerminalPoolSlotContextValue | null>(
  null,
);

/**
 * Provides DOM mount targets for {@link TerminalPoolHost}: the right-panel slot,
 * the sign-in dialog slot, and a fixed off-screen host when no slot displays it.
 */
export function TerminalPoolSlotProvider({ children }: { readonly children: ReactNode }) {
  const [panelSlotEl, setPanelSlotEl] = useState<HTMLDivElement | null>(null);
  const [dialogSlotEl, setDialogSlotEl] = useState<HTMLDivElement | null>(null);
  const [offScreenEl, setOffScreenEl] = useState<HTMLDivElement | null>(null);
  const setPanelSlotRef = useCallback((el: HTMLDivElement | null) => {
    setPanelSlotEl(el);
  }, []);
  const setDialogSlotRef = useCallback((el: HTMLDivElement | null) => {
    setDialogSlotEl(el);
  }, []);
  const setOffScreenRef = useCallback((el: HTMLDivElement | null) => {
    setOffScreenEl(el);
  }, []);
  const value = useMemo(
    () => ({
      slotEls: { panel: panelSlotEl, dialog: dialogSlotEl },
      setPanelSlotRef,
      setDialogSlotRef,
      offScreenEl,
      setOffScreenRef,
    }),
    [panelSlotEl, dialogSlotEl, setPanelSlotRef, setDialogSlotRef, offScreenEl, setOffScreenRef],
  );
  return (
    <TerminalPoolSlotContext.Provider value={value}>
      <div
        ref={setOffScreenRef}
        className="pointer-events-none fixed left-0 top-0 z-[-1] h-[480px] w-[900px] opacity-0"
        aria-hidden
      />
      {children}
    </TerminalPoolSlotContext.Provider>
  );
}

/** Returns portal slot and off-screen host refs for {@link TerminalPoolHost}. */
export function useTerminalPoolSlot(): TerminalPoolSlotContextValue {
  const ctx = useContext(TerminalPoolSlotContext);
  if (!ctx) {
    throw new Error("useTerminalPoolSlot must be used within TerminalPoolSlotProvider");
  }
  return ctx;
}

/**
 * Mount point for the pooled terminal view, in the right-panel Terminal tab
 * (the default) or the sign-in dialog. {@link TerminalPoolHost} portals into
 * the slot of the surface it currently presents.
 */
export function TerminalPoolSlot({
  className,
  surface = "panel",
}: {
  readonly className?: string;
  readonly surface?: TerminalPoolSurface;
}) {
  const { setPanelSlotRef, setDialogSlotRef } = useTerminalPoolSlot();
  return (
    <div
      ref={surface === "dialog" ? setDialogSlotRef : setPanelSlotRef}
      className={className}
      data-testid="terminal-pool-slot"
    />
  );
}
