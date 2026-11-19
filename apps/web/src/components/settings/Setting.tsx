import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useShallow } from "zustand/shallow";
import { useSettingsLocation } from "@/stores/settingsLocationStore";
import type { SettingCondition, SettingDef, SettingId, SettingVariant } from "./setting-def";

/**
 * Row layout: the control sits on the label's line and wraps under it only when the label would get
 * narrower than 24rem, so a narrow window keeps rows on one line as long as they fit.
 */
const SETTING_ROW_CLASS = "flex flex-wrap items-center gap-x-6 gap-y-2";

/** Thin inset outline on the row a search location opened; dimmer than the focus ring, no fill. */
export const SEARCH_HIT_CLASS =
  "outline-none data-[search-hit]:outline-1 data-[search-hit]:-outline-offset-4 data-[search-hit]:outline-solid data-[search-hit]:outline-[color-mix(in_oklch,var(--focus)_55%,transparent)]";

/** What useSettingHit gives an element that can hold the search hit. */
export interface SettingHit {
  /** Id of the hit inside this element, or null. */
  readonly hitId: SettingId | null;
  readonly ref: (element: HTMLElement | null) => void;
  /** data-search-hit for the outline, tabIndex -1 so focus can land. */
  readonly attrs: { readonly "data-search-hit"?: ""; readonly tabIndex?: -1 };
}

type RowHit = { readonly id: SettingId; readonly nonce: number } | { readonly id: null; readonly nonce: null };

const NO_ROW_HIT: RowHit = { id: null, nonce: null };

/**
 * Marks, scrolls to and focuses the element when the open hit is one of `defs`.
 * Runs when the element mounts with the hit or becomes the hit, so rows that mount late
 * (provider availability, a disclosure opening) still get scrolled to. Once per hit open: value re-renders do not scroll again.
 */
export function useSettingHit(defs: readonly SettingDef[]): SettingHit {
  // A shallow-compared selector re-renders only the rows that gain or lose the hit.
  const { id: hitId, nonce } = useSettingsLocation(useShallow((state): RowHit => {
    const hit = state.hit;
    return hit !== null && defs.some((def) => def.id === hit.id) ? { id: hit.id, nonce: hit.nonce } : NO_ROW_HIT;
  }));
  const element = useRef<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    element.current = node;
  }, []);

  useEffect(() => {
    if (hitId === null || !element.current) return;
    element.current.focus({ preventScroll: true });
    element.current.scrollIntoView({ block: "center" });
  }, [hitId, nonce]);

  return { hitId, ref, attrs: hitId === null ? {} : { "data-search-hit": "", tabIndex: -1 } };
}

const ROW_SPACING: Record<SettingVariant, string> = {
  page: "min-h-18 py-2.5",
  best: "pt-1.5 pb-3",
  match: "min-h-10 pt-0.5 pb-1.5",
};

/** Props for the standard row layout that custom rows reuse. */
export interface SettingRowFrameProps {
  readonly def: SettingDef;
  readonly variant: SettingVariant;
  /** Shorter label where the surrounding row already names the subject, such as "CLI path" under a provider. Omit to show `def.label`. */
  readonly label?: ReactNode;
  /** Live hint that replaces the static one, such as update status. Omit to show `def.hint`. */
  readonly hint?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * The labelled row layout: label and hint on the left, the control on the right.
 * Other matches in search hide the hint.
 */
export function SettingRowFrame({ def, variant, label = def.label, hint, children, className }: SettingRowFrameProps) {
  const hit = useSettingHit([def]);
  const shownHint = variant === "match" ? undefined : (hint ?? def.hint);
  return (
    <div
      ref={hit.ref}
      {...hit.attrs}
      data-setting-id={def.id}
      className={cn(SETTING_ROW_CLASS, SEARCH_HIT_CLASS, "px-4", ROW_SPACING[variant], className)}
    >
      <div className="min-w-0 flex-[1_1_24rem]">
        <span className="text-body-small font-semibold text-ink">{label}</span>
        {shownHint ? (
          <p className="mt-0.5 max-w-[46rem] text-compact leading-[1.8rem] text-muted">{shownHint}</p>
        ) : null}
      </div>
      <div className="max-w-full min-w-0 shrink-0">{children}</div>
    </div>
  );
}

function SettingBody({ def, variant }: { readonly def: SettingDef; readonly variant: SettingVariant }) {
  if (def.Row) return <def.Row def={def} variant={variant} />;
  const Control = def.Control;
  return (
    <SettingRowFrame def={def} variant={variant}>
      <Control />
    </SettingRowFrame>
  );
}

function ConditionalSetting({ def, variant, when }: { readonly def: SettingDef; readonly variant: SettingVariant; readonly when: SettingCondition }) {
  const applies = when.useApplies();
  if (applies) return <SettingBody def={def} variant={variant} />;
  if (variant === "page") return null;
  // Search still finds the row, so it explains why there is nothing to change instead of vanishing.
  return (
    <SettingRowFrame def={def} variant={variant}>
      <p className="text-caption text-muted">{when.reason}</p>
    </SettingRowFrame>
  );
}

/** Renders one setting the same way on its page and in search results. */
export function Setting({ def, variant = "page" }: { readonly def: SettingDef; readonly variant?: SettingVariant }) {
  if (def.exists && !def.exists()) return null;
  if (def.when) return <ConditionalSetting def={def} variant={variant} when={def.when} />;
  return <SettingBody def={def} variant={variant} />;
}
