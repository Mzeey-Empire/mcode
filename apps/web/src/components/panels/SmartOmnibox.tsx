import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  useOmniboxState,
  type UseOmniboxStateOptions,
} from "./useOmniboxState";

/** Props for the hybrid title-or-URL omnibox, including navigate callback from the preview panel. */
export interface SmartOmniboxProps extends UseOmniboxStateOptions {
  /** Called when the user submits a URL via Enter. */
  onNavigate: (url: string) => void;
  /**
   * Monotonic token that triggers focus + select-all on the input each time
   * it changes. Used so the preview panel can pull focus into the URL field
   * when opened via the mod+shift+b shortcut without forcing focus on every
   * unrelated re-render.
   */
  focusRequest?: number;
}

/**
 * Smart omnibox that shows page title + favicon when blurred,
 * and the editable URL when focused. Replaces the plain URL input + title row.
 */
export function SmartOmnibox({
  url,
  pageTitle,
  faviconUrl,
  onNavigate,
  focusRequest,
}: SmartOmniboxProps) {
  const {
    displayValue,
    showFavicon,
    showAsTitle,
    inputRef,
    placeholder,
    onFocus,
    onBlur,
    onChange,
    onSubmit,
  } = useOmniboxState({ url, pageTitle, faviconUrl });

  const [faviconError, setFaviconError] = useState(false);

  // Reset favicon error when a new favicon URL arrives (new page load).
  useEffect(() => {
    setFaviconError(false);
  }, [faviconUrl]);

  // Honour focus requests from the parent. requestAnimationFrame defers the
  // call until after layout so the input is mounted and visible when focus
  // and select fire (notably when the preview panel was just opened by
  // the shortcut and the omnibox renders in the same tick as the bump).
  useEffect(() => {
    if (focusRequest === undefined || focusRequest === 0) return;
    const handle = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(handle);
  }, [focusRequest, inputRef]);

  const faviconVisible = showFavicon && !faviconError;

  return (
    // The "Go" button that used to live next to the input was removed in line
    // with modern browser address bars: Enter is the universal submit and a
    // redundant button only adds chrome. The input now spans the row.
    <div className="relative min-w-0">
      {faviconVisible ? (
        <img
          src={faviconUrl!}
          alt=""
          width={14}
          height={14}
          loading="eager"
          className="pointer-events-none absolute top-1/2 left-2 z-10 -translate-y-1/2 rounded-sm"
          onError={() => setFaviconError(true)}
        />
      ) : null}
      <Input
        ref={inputRef}
        value={displayValue}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const target = onSubmit();
            if (target.trim()) onNavigate(target);
          }
        }}
        placeholder={placeholder}
        size="sm"
        className={cn(
          "min-w-0",
          !showAsTitle && "font-mono",
          faviconVisible && "pl-7",
          showAsTitle && "cursor-default font-medium",
        )}
        aria-label="Preview URL"
        title={url || undefined}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
    </div>
  );
}
