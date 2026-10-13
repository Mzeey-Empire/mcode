import { ArrowLeft, ArrowRight, Camera, PenTool, RotateCw } from "lucide-react";
import { BrowserActionButton } from "./BrowserActionButton";
import { BrowserMoreMenu } from "./BrowserMoreMenu";
import type {
  BrowserAddress,
  BrowserNavigation,
  BrowserPageActions,
  BrowserToolbarPage,
  BrowserTools,
} from "./browserToolbarModel";
import { BrowserUrlPill } from "./BrowserUrlPill";

/** Props for {@link BrowserToolbar}. */
export interface BrowserToolbarProps {
  readonly page: BrowserToolbarPage;
  readonly address: BrowserAddress;
  readonly tools: BrowserTools;
  /** Monotonic token: each change focuses the address and selects it. */
  readonly focusRequest?: number;
}

const NAV_CONTROL = { shape: "round", variant: "ghost", size: "inline", className: "aria-disabled:opacity-40" } as const;

function NavigationGroup({ navigation }: { readonly navigation: BrowserNavigation }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-selected p-0.5">
      <BrowserActionButton label="Back" action={navigation.back} {...NAV_CONTROL}>
        <ArrowLeft className="size-3.5" aria-hidden />
      </BrowserActionButton>
      <BrowserActionButton label="Forward" action={navigation.forward} {...NAV_CONTROL}>
        <ArrowRight className="size-3.5" aria-hidden />
      </BrowserActionButton>
      <BrowserActionButton label="Reload" action={navigation.reload} {...NAV_CONTROL}>
        <RotateCw className="size-3.5" aria-hidden />
      </BrowserActionButton>
    </div>
  );
}

function PageActions({ actions }: { readonly actions: BrowserPageActions }) {
  if (actions.kind === "unavailable") return null;
  return (
    <>
      <BrowserActionButton
        label="Design"
        tooltip="Design: pick an element to attach to the chat"
        action={actions.design}
        shape="round"
        variant={actions.designActive ? "default" : "subtle"}
        pressed={actions.designActive}
        className="aria-disabled:opacity-50"
      >
        <PenTool aria-hidden />
      </BrowserActionButton>
      <BrowserActionButton
        label="Screenshot"
        tooltip="Screenshot: click the page for the viewport, drag for a region"
        action={actions.screenshot}
        shape="round"
        pressed={actions.screenshotArmed}
        className="aria-disabled:opacity-50"
      >
        <Camera aria-hidden />
      </BrowserActionButton>
    </>
  );
}

/** Browser address and tools, with navigation on loaded or errored pages. */
export function BrowserToolbar({ page, address, tools, focusRequest }: BrowserToolbarProps) {
  return (
    <div data-testid="browser-toolbar" className="flex h-10 min-w-0 flex-1 items-center gap-2 px-2">
      {page.kind === "new" ? null : <NavigationGroup navigation={page.navigation} />}
      <BrowserUrlPill address={address} newPage={page.kind === "new"} focusRequest={focusRequest} />
      {page.kind === "loaded" ? <PageActions actions={page.pageActions} /> : null}
      <BrowserMoreMenu tools={tools} />
    </div>
  );
}
