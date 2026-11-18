import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SETTINGS_PAGES, type SettingsSection } from "./settings-nav";

interface SettingsNavProps {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
}

/** Settings page navigation rendered inside the app sidebar. */
export function SettingsNav({ section, onSection }: SettingsNavProps) {
  return (
    <div className="px-2 py-4">
      {SETTINGS_PAGES.map((page) => (
        <Button
          key={page.id}
          type="button"
          variant="ghost"
          size="compact"
          onClick={() => onSection(page.id)}
          className={cn(
            "w-full justify-start rounded-md px-3 text-left font-medium",
            section === page.id
              ? "bg-primary/10 font-semibold text-ink hover:bg-primary/10"
              : "text-muted hover:bg-hover/40 hover:text-ink",
          )}
        >
          {page.label}
        </Button>
      ))}
    </div>
  );
}
