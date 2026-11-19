import { cn } from "@/lib/utils";
import { useUpdateStore } from "@/stores/updateStore";
import { selectSettingsCanvas, useSettingsLocation } from "@/stores/settingsLocationStore";
import { SETTINGS_PAGES } from "./settings-nav";
import { SETTINGS_SIDEBAR_ROW_CLASS } from "./settings-sidebar-row";
import { SettingsSearchField } from "./SettingsSearchField";

/** Settings search and page navigation rendered inside the app sidebar. */
export function SettingsNav() {
  const version = useUpdateStore((s) => s.version);
  const section = useSettingsLocation((s) => s.page);
  const openPage = useSettingsLocation((s) => s.openPage);
  // While results show, no page is the one on screen.
  const showingResults = useSettingsLocation((s) => selectSettingsCanvas(s).kind === "results");
  return (
    <>
    <SettingsSearchField />
    <div className="flex flex-col gap-0.5 px-2 pt-2 pb-3">
      {SETTINGS_PAGES.map((page) => {
        const current = !showingResults && section === page.id;
        const Icon = page.icon;
        return (
          <button
            key={page.id}
            type="button"
            aria-current={current ? "page" : undefined}
            onClick={() => openPage(page.id)}
            className={cn(SETTINGS_SIDEBAR_ROW_CLASS, current && "bg-selected font-medium text-ink hover:bg-selected")}
          >
            <Icon size={16} aria-hidden className="shrink-0" />
            <span className="min-w-0 text-fade">{page.label}</span>
            {page.id === "about" && version ? (
              <span className="ml-auto shrink-0 font-mono text-caption font-normal text-muted tabular-nums">v{version}</span>
            ) : null}
          </button>
        );
      })}
    </div>
    </>
  );
}
