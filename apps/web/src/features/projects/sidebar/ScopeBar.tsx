import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { useSidebarUiStore, type SidebarScope } from "./sidebar-ui-store";

/** The scope the sidebar lists. Closed stays chosen even when no thread is closed. */
export function useSidebarScope(): SidebarScope {
  return useSidebarUiStore((state) => state.scope);
}

function isSidebarScope(value: string): value is SidebarScope {
  return value === "active" || value === "completed";
}

const SCOPE_OPTIONS: readonly SegmentedOption[] = [
  { value: "active", label: "Open" },
  { value: "completed", label: "Closed" },
];

const SELECTED_LIFT =
  "[&_[role=radio][aria-checked=true]]:bg-segment-on [&_[role=radio][aria-checked=true]]:ring-1 [&_[role=radio][aria-checked=true]]:ring-segment-edge";

/** The Open / Closed pill. It carries no count, so it reads the same whether or not anything is closed. */
export function ScopeBar({ scope, className }: { readonly scope: SidebarScope; readonly className?: string }) {
  const setScope = useSidebarUiStore((state) => state.setScope);
  return (
    <div data-testid="sidebar-scope-bar" className={className}>
      <SegmentedControl
        aria-label="Thread scope"
        variant="pill"
        fill
        options={SCOPE_OPTIONS}
        value={scope}
        className={SELECTED_LIFT}
        onChange={(value) => {
          if (isSidebarScope(value)) setScope(value);
        }}
      />
    </div>
  );
}
