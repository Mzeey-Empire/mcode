import { type KeyboardEvent, type RefObject, useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrowserActionButton } from "./BrowserActionButton";
import type { BrowserAddress } from "./browserToolbarModel";
import { useOmniboxState } from "./useOmniboxState";

/** Props for {@link BrowserUrlPill}. */
export interface BrowserUrlPillProps {
  readonly address: BrowserAddress;
  /** Shows an address prompt on a new page. */
  readonly newPage: boolean;
  /** Rings the pill in the accent while the agent acts on this page. */
  readonly acting?: boolean;
  /** Monotonic token: each change focuses the pill and selects its text. */
  readonly focusRequest?: number;
}

interface UrlDisplay {
  readonly origin: string;
  readonly rest: string;
}

function urlDisplay(url: string): UrlDisplay {
  try {
    const parsed = new URL(url);
    if (parsed.origin === "null") return { origin: "", rest: url };
    return { origin: parsed.origin, rest: url.slice(parsed.origin.length) };
  } catch {
    return { origin: "", rest: url };
  }
}

function useFocusRequest(focusRequest: number | undefined, inputRef: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    if (!focusRequest) return undefined;
    const handle = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(handle);
  }, [focusRequest, inputRef]);
}

function UrlAtRest({ url }: { readonly url: string }) {
  const { origin, rest } = urlDisplay(url);
  return (
    <span aria-hidden className="text-fade pointer-events-none absolute inset-0 flex items-center whitespace-nowrap">
      <span className="text-muted">{origin}</span>
      <span className="text-ink">{rest}</span>
    </span>
  );
}

/** Editable address that preserves the submitted draft until the page URL changes. */
export function BrowserUrlPill({ address, newPage, acting = false, focusRequest }: BrowserUrlPillProps) {
  const { url, onNavigate, openExternal, onHumanFocus } = address;
  const omnibox = useOmniboxState(url);
  const [focused, setFocused] = useState(false);
  useFocusRequest(focusRequest, omnibox.inputRef);
  const atRest = !focused && !omnibox.dirty && url.length > 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const target = omnibox.value.trim();
    if (target) onNavigate(target);
  };

  return (
    <div
      data-testid="browser-url-pill"
      className={cn(
        "group/url flex h-8 min-w-0 flex-1 items-center gap-1 rounded-2xl bg-selected pr-0.75 pl-3.5 transition-colors",
        "hover:bg-border focus-within:bg-border",
        newPage && !acting && "shadow-[inset_0_0_0_1px_var(--color-focus)]",
        acting && "shadow-[inset_0_0_0_1px_var(--color-primary)]",
      )}
    >
      <div className="relative min-w-0 flex-1 text-code-small">
        <input
          ref={omnibox.inputRef}
          value={omnibox.value}
          onChange={(event) => omnibox.onChange(event.target.value)}
          onFocus={() => {
            setFocused(true);
            onHumanFocus();
            omnibox.onFocus();
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={handleKeyDown}
          placeholder="Search or enter URL"
          aria-label="Preview URL"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={cn(
            "w-full bg-transparent text-ink outline-none placeholder:text-muted",
            atRest && "text-transparent caret-transparent",
          )}
        />
        {atRest ? <UrlAtRest url={url} /> : null}
      </div>
      {url.length > 0 ? (
        <BrowserActionButton
          label="Open in browser"
          action={openExternal}
          shape="round"
          variant="ghost"
          // Opacity, not visibility, so the button stays in the tab order while hidden.
          className="size-6.5 shrink-0 opacity-0 group-focus-within/url:opacity-100 group-hover/url:opacity-100 focus-visible:opacity-100"
        >
          <ArrowUpRight className="size-3.5" aria-hidden />
        </BrowserActionButton>
      ) : null}
    </div>
  );
}
