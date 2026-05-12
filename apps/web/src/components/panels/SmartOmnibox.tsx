import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  useOmniboxState,
  type UseOmniboxStateOptions,
} from "./useOmniboxState";

export interface SmartOmniboxProps extends UseOmniboxStateOptions {
  /** Called when user submits a URL (Enter or Go button). */
  onNavigate: (url: string) => void;
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

  const faviconVisible = showFavicon && !faviconError;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="relative min-w-0 flex-1">
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
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-2.5 text-xs"
        onClick={() => {
          const target = onSubmit();
          if (target.trim()) onNavigate(target);
        }}
      >
        Go
      </Button>
    </div>
  );
}
