import type { KeyboardEvent } from "react";
import { ArrowLeft, Search, X } from "lucide-react";
import { selectCanGoBackToResults, useSettingsLocation } from "@/stores/settingsLocationStore";

/** Settings search field at the top of the sidebar, with "Back to results" under it while a result is open. */
export function SettingsSearchField() {
  const query = useSettingsLocation((s) => s.query);
  const setQuery = useSettingsLocation((s) => s.setQuery);
  const canGoBack = useSettingsLocation(selectCanGoBackToResults);
  const backToResults = useSettingsLocation((s) => s.backToResults);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Only a non-empty field consumes Escape, so an empty one leaves it to whatever closes Settings.
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    }
  };

  return (
    <div className="flex flex-col gap-1 px-2 pt-3">
      <div className="flex h-8 items-center gap-2 rounded-sm bg-panel px-2.5 text-muted focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-solid focus-within:outline-focus">
        <Search size={14} aria-hidden className="shrink-0" />
        <input
          type="search"
          aria-label="Search settings"
          placeholder="Search settings"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-body-small text-ink outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
        />
        {query !== "" ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery("")}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus"
          >
            <X size={12} aria-hidden />
          </button>
        ) : null}
      </div>
      {canGoBack ? (
        <button
          type="button"
          onClick={backToResults}
          className="flex h-6 items-center gap-1.5 self-start rounded-sm px-1.5 text-caption text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus"
        >
          <ArrowLeft size={12} aria-hidden />
          Back to results
        </button>
      ) : null}
    </div>
  );
}
