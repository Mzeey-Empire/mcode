// PROTOTYPE (throwaway): floating variant switcher for UI prototypes. Never ships: callers gate on import.meta.env.DEV.
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";

/** One switchable prototype variant. */
export interface PrototypeVariant<K extends string> {
  readonly key: K;
  readonly name: string;
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable], [role=listbox], [role=menu]") !== null);
}

/** A high-contrast card in the sidebar's empty lower corner, clear of the composer and the overview card: ← / → cycle variants; `extra` holds prototype-only controls. */
export function PrototypeSwitcher<K extends string>({
  variants,
  current,
  onChange,
  extra,
}: {
  readonly variants: readonly PrototypeVariant<K>[];
  readonly current: K;
  readonly onChange: (key: K) => void;
  readonly extra?: ReactNode;
}) {
  const index = Math.max(0, variants.findIndex((variant) => variant.key === current));
  const step = (delta: number) => onChange(variants[(index + delta + variants.length) % variants.length]!.key);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isEditable(event.target)) return;
      if (event.key === "ArrowLeft") step(-1);
      else if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const variant = variants[index]!;
  return createPortal(
    <div
      data-prototype-switcher
      className="fixed bottom-14 left-3 z-(--layer-toast) flex w-[280px] flex-col gap-0.5 rounded-2xl bg-ink p-1 text-compact text-background shadow-popover"
    >
      <span className="flex h-8 items-center">
      <button type="button" aria-label="Previous variant" onClick={() => step(-1)} className="flex size-7 items-center justify-center rounded-full hover:bg-background/15">
        <ChevronLeft className="size-4" />
      </button>
      <span className="flex-1 text-center tabular-nums">
        <b className="font-semibold">{variant.key}</b> · {variant.name}
      </span>
      <button type="button" aria-label="Next variant" onClick={() => step(1)} className="flex size-7 items-center justify-center rounded-full hover:bg-background/15">
        <ChevronRight className="size-4" />
      </button>
      </span>
      {extra && <span className="flex h-7 items-center justify-center gap-0.5 border-t border-background/20 pt-0.5">{extra}</span>}
    </div>,
    document.body,
  );
}
