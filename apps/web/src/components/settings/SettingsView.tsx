import { useEffect, useRef } from "react";
import { Settings } from "lucide-react";
import { CanvasHeader } from "@/components/shell/CanvasHeader";
import { CanvasBreadcrumb } from "@/components/shell/CanvasBreadcrumb";
import { SETTINGS_PAGES, type SettingsSection } from "./settings-nav";

interface SettingsViewProps {
  /** Active settings section to render. */
  section: SettingsSection;
}

/**
 * Settings canvas: a "Settings / page" header pill over the active page in a centred column.
 * Page navigation lives in the sidebar.
 */
export function SettingsView({ section }: SettingsViewProps) {
  const page = SETTINGS_PAGES.find((candidate) => candidate.id === section) ?? SETTINGS_PAGES[0];
  const ActiveSection = page.component;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownSection = useRef(section);

  // Moving focus to the new page's heading makes the next Tab start on that page; skip the first mount so opening Settings keeps focus where it was.
  useEffect(() => {
    if (shownSection.current === section) return;
    shownSection.current = section;
    headingRef.current?.focus();
  }, [section]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <CanvasHeader>
        <CanvasBreadcrumb projectName="Settings" workspaceId={undefined} icon={<Settings size={14} className="shrink-0" aria-hidden />}>
          <span className="text-fade text-label text-ink">{page.label}</span>
        </CanvasBreadcrumb>
      </CanvasHeader>
      <div data-settings-surface="" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-10 pt-6 pb-24">
          {/* The pill names the page, so the heading stays for screen readers and as the focus target after navigation. */}
          <h1 ref={headingRef} tabIndex={-1} className="sr-only">{page.label}</h1>
          <ActiveSection />
        </div>
      </div>
    </div>
  );
}
