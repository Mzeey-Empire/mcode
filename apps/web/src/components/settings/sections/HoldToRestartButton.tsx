import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** How long a press must last before the restart commits (ms). */
export const HOLD_TO_RESTART_MS = 1_200;

type HoldPhase = "idle" | "holding" | "done";

/** Props for {@link HoldToRestartButton}. */
export interface HoldToRestartButtonProps {
  /** Accessible name; says what the restart ends. */
  readonly accessibleName: string;
  /**
   * Runs when a press is held for {@link HOLD_TO_RESTART_MS}; resolves true when the restart began. Until it settles
   * the button refuses another hold, and when it resolves false the button can be held again.
   */
  readonly onCommit: () => Promise<boolean>;
  readonly className?: string;
}

// Mixed in oklab, not oklch: oklch walks the hue from amber to the panel's cool grey and lands on purple.
const HOLD_EDGE_CLASS =
  "data-[hold=holding]:border-[color-mix(in_oklab,var(--primary)_55%,transparent)] data-[hold=done]:border-[color-mix(in_oklab,var(--primary)_55%,transparent)]";
const FILL_CLASS =
  "pointer-events-none absolute inset-0 flex items-center justify-center bg-[color-mix(in_oklab,var(--primary)_32%,var(--panel))] text-warning [clip-path:inset(0_100%_0_0)] transition-[clip-path] duration-200 ease-(--ease-standard) motion-reduce:transition-none";
const FILL_HOLDING_CLASS = "[clip-path:inset(0)] duration-[1200ms] ease-linear motion-reduce:[clip-path:inset(0_100%_0_0)]";
const FILL_DONE_CLASS = "[clip-path:inset(0)] transition-none";

/**
 * "Hold to restart": restarting ends running agents, so it asks for a held press instead of a dialog.
 * A pointer press or Space/Enter held for 1200ms commits; letting go, leaving, blurring or cancelling earlier does nothing.
 * While held, an amber copy of the label wipes in from the left; reduced motion skips the wipe but keeps the timing.
 */
export function HoldToRestartButton({ accessibleName, onCommit, className }: HoldToRestartButtonProps) {
  const [phase, setPhase] = useState<HoldPhase>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const commit = async () => {
    setPhase("done");
    const started = await onCommit();
    if (!started && mounted.current) setPhase("idle");
  };

  const start = () => {
    if (timer.current || phase === "done") return;
    setPhase("holding");
    timer.current = setTimeout(() => {
      timer.current = null;
      void commit();
    }, HOLD_TO_RESTART_MS);
  };

  const end = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    setPhase("idle");
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button === 0) start();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (!event.repeat) start();
  };
  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === " " || event.key === "Enter") end();
  };

  const label = phase === "done" ? "Restarting" : "Hold to restart";
  return (
    <Button
      variant="outline"
      aria-label={accessibleName}
      data-hold={phase}
      className={cn("overflow-hidden touch-none select-none", HOLD_EDGE_CLASS, className)}
      onPointerDown={onPointerDown}
      onPointerUp={end}
      onPointerLeave={end}
      onPointerCancel={end}
      onBlur={end}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <span>{label}</span>
      <span aria-hidden className={cn(FILL_CLASS, phase === "holding" && FILL_HOLDING_CLASS, phase === "done" && FILL_DONE_CLASS)}>
        {label}
      </span>
    </Button>
  );
}
