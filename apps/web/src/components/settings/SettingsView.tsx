import { useEffect, useRef } from "react";
import { Settings } from "lucide-react";
import { CanvasHeader } from "@/components/shell/CanvasHeader";
import { CanvasBreadcrumb } from "@/components/shell/CanvasBreadcrumb";
import { useShallow } from "zustand/shallow";
import { selectSettingsCanvas, useSettingsLocation } from "@/stores/settingsLocationStore";
import { SETTINGS_PAGES } from "./settings-nav";
import { SettingsSearchResults } from "./SettingsSearchResults";
import { RevertVisitButton } from "./RevertVisitButton";
import { useSettingsVisit } from "./settings-visit";

/**
 * Settings canvas: a "Settings / page" header pill over the active page in a centred column.
 * Page navigation and search live in the sidebar; a non-blank search shows results here instead of a page.
 */
export function SettingsView() {
  const canvas = useSettingsLocation(useShallow(selectSettingsCanvas));
  const section = useSettingsLocation((s) => s.page);
  const hitOpen = canvas.kind === "page" && canvas.hit !== null;
  const page = SETTINGS_PAGES.find((candidate) => candidate.id === section) ?? SETTINGS_PAGES[0];
  const ActiveSection = page.component;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownSection = useRef(section);
  useSettingsVisit(section);

  // Moving focus to the new page's heading makes the next Tab start on that page; skip the first mount so opening Settings keeps focus where it was.
  useEffect(() => {
    if (shownSection.current === section) return;
    shownSection.current = section;
    // An opened search hit focuses its own row; the heading must not take focus back.
    if (hitOpen) return;
    headingRef.current?.focus();
  }, [section, hitOpen]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <CanvasHeader>
        <CanvasBreadcrumb projectName="Settings" workspaceId={undefined} icon={<Settings size={14} className="shrink-0" aria-hidden />}>
          <span className="text-fade text-label text-ink">{canvas.kind === "results" ? "Search" : page.label}</span>
        </CanvasBreadcrumb>
        {canvas.kind === "page" ? <RevertVisitButton onReverted={() => headingRef.current?.focus()} /> : null}
      </CanvasHeader>
      <div data-settings-surface="" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-10 pt-6 pb-24">
          {/* The pill names the page, so the heading stays for screen readers and as the focus target after navigation. */}
          {canvas.kind === "results" ? (
            <SettingsSearchResults query={canvas.query.trim()} />
          ) : (
            <>
              <h1 ref={headingRef} tabIndex={-1} className="sr-only">{page.label}</h1>
              <ActiveSection />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
