import { cn } from "@/lib/utils";
import { useUpdateStore } from "@/stores/updateStore";
import { SETTINGS_PAGES, type SettingsSection } from "./settings-nav";
import { SETTINGS_SIDEBAR_ROW_CLASS } from "./settings-sidebar-row";

interface SettingsNavProps {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
}

/** Settings page navigation rendered inside the app sidebar. */
export function SettingsNav({ section, onSection }: SettingsNavProps) {
  const version = useUpdateStore((s) => s.version);
  return (
    <div className="flex flex-col gap-0.5 px-2 py-3">
      {SETTINGS_PAGES.map((page) => {
        const current = section === page.id;
        const Icon = page.icon;
        return (
          <button
            key={page.id}
            type="button"
            aria-current={current ? "page" : undefined}
            onClick={() => onSection(page.id)}
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
  );
}
