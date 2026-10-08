import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { NAV_GROUPS, type SettingsSection } from "./settings-nav";

interface SettingsNavProps {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
}

/** Settings category navigation rendered inside the app sidebar. */
export function SettingsNav({ section, onSection }: SettingsNavProps) {
  return (
    <div className="py-4">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="mb-5 px-2">
          <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted">
            {group.label}
          </p>
          {group.items.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onSection(item.id)}
              className={cn(
                "w-full justify-start rounded-md px-3 text-left font-medium",
                section === item.id
                  ? "bg-primary/10 font-semibold text-ink hover:bg-primary/10"
                  : "text-muted hover:bg-hover/40 hover:text-ink",
              )}
            >
              {item.label}
            </Button>
          ))}
        </div>
      ))}
    </div>
  );
}
