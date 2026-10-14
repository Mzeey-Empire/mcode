import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/ui/provider-icon";
import type { BrowserControl } from "./browserToolbarModel";

/** Props for {@link BrowserControlPill}. */
export interface BrowserControlPillProps {
  readonly control: Exclude<BrowserControl, { readonly kind: "none" }>;
}

/**
 * The Browser's single control affordance: Take control while the agent acts, Hand back while the
 * user holds. The provider mark says who is on the other side.
 */
export function BrowserControlPill({ control }: BrowserControlPillProps) {
  const { label, onPress } = control.kind === "agent-acting"
    ? { label: "Take control", onPress: control.takeControl }
    : { label: "Hand back", onPress: control.handBack };
  return (
    <div
      data-testid="browser-control-pill"
      className="flex h-8 shrink-0 items-center gap-2 rounded-full bg-selected py-0 pr-[3px] pl-3"
    >
      <ProviderIcon provider={control.provider} size={16} />
      <Button
        type="button"
        variant="ghost"
        shape="round"
        onClick={onPress}
        className="h-[26px] bg-border px-2.5 whitespace-nowrap hover:bg-control-border"
      >
        {label}
      </Button>
    </div>
  );
}
