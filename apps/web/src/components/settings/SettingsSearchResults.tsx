import { useEffect, useMemo, useRef } from "react";
import { ChevronRight } from "lucide-react";
import { useSettingsLocation } from "@/stores/settingsLocationStore";
import { Setting } from "./Setting";
import { SettingsGroup } from "./SettingsGroup";
import type { SettingDef, SettingId } from "./setting-def";
import { SETTINGS_INDEX, SETTINGS_PAGES } from "./settings-nav";
import { searchSettings, settingLocation, type IndexedSetting } from "./settings-search";

interface LocationLinkProps {
  readonly entry: IndexedSetting;
  /** Row to mark when the link is chosen; the anchor row for a conditional setting that does not apply. */
  readonly target: SettingId;
}

function LocationLinkButton({ entry, target }: LocationLinkProps) {
  const openHit = useSettingsLocation((s) => s.openHit);
  const { def } = entry;
  const parts = settingLocation(entry);
  const Icon = SETTINGS_PAGES.find((page) => page.id === def.page)?.icon;
  return (
    <button
      type="button"
      data-goto={def.id}
      aria-label={`Go to ${def.label} in ${parts.join(", ")}`}
      onClick={() => openHit({ page: def.page, id: target, from: def.id })}
      className="-ml-1.5 flex h-6.5 items-center gap-1.5 rounded-sm px-1.5 text-compact text-ink/72 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus"
    >
      {Icon ? <Icon size={12} aria-hidden className="shrink-0" /> : null}
      {parts.map((part, index) => (
        <span key={part} className="flex items-center gap-1.5">
          {index > 0 ? <span aria-hidden className="mx-0.5 text-ink/55">›</span> : null}
          {part}
        </span>
      ))}
      <ChevronRight size={12} aria-hidden className="shrink-0" />
    </button>
  );
}

function ConditionalLocationLink({ entry, condition }: { readonly entry: IndexedSetting; readonly condition: NonNullable<SettingDef["when"]> }) {
  const applies = condition.useApplies();
  return <LocationLinkButton entry={entry} target={applies ? entry.def.id : condition.anchor} />;
}

function LocationLink({ entry }: { readonly entry: IndexedSetting }) {
  const condition = entry.def.when;
  if (condition) return <ConditionalLocationLink entry={entry} condition={condition} />;
  return <LocationLinkButton entry={entry} target={entry.def.id} />;
}

/** Search results for a non-blank query: the best match in its own panel, then every other match as a working row. */
export function SettingsSearchResults({ query }: { readonly query: string }) {
  const matches = useMemo(() => searchSettings(query, SETTINGS_INDEX), [query]);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Back to results lands on the link that opened the hit when it is still listed; otherwise on the heading.
  useEffect(() => {
    const returnTo = useSettingsLocation.getState().returnTo;
    if (returnTo === null) return;
    const link = document.querySelector<HTMLElement>(`[data-goto="${CSS.escape(returnTo)}"]`);
    (link ?? headingRef.current)?.focus();
  }, []);

  if (matches.length === 0) {
    return (
      <p className="px-1 text-body-small text-muted">
        No settings match "{query}".
      </p>
    );
  }

  const [best, ...rest] = matches;
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h2 ref={headingRef} tabIndex={-1} className="px-1 text-body-small text-muted outline-none">
          Best match for <span className="text-ink">"{query}"</span>
        </h2>
        <div className="rounded-lg bg-panel inset-ring inset-ring-border">
          <div className="px-3 pt-2">
            <LocationLink entry={best.entry} />
          </div>
          <Setting def={best.entry.def} variant="best" />
        </div>
      </section>
      {rest.length > 0 ? (
        <SettingsGroup title="Other matches">
          {rest.map(({ entry }) => (
            <div key={entry.def.id}>
              <div className="px-3 pt-2">
                <LocationLink entry={entry} />
              </div>
              <Setting def={entry.def} variant="match" />
            </div>
          ))}
        </SettingsGroup>
      ) : null}
    </div>
  );
}
