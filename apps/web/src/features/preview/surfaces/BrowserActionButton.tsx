import { useId } from "react";
import { IconButton, type IconButtonProps } from "@/components/ui/button";
import type { BrowserAction } from "./browserToolbarModel";

/** Props for {@link BrowserActionButton}. */
export type BrowserActionButtonProps = Omit<IconButtonProps, "onClick" | "disabled" | "aria-label"> & {
  readonly label: string;
  readonly action: BrowserAction;
};

/**
 * An icon button for one {@link BrowserAction}. A disabled action stays hoverable
 * and focusable so its tooltip and accessible description can say why.
 */
export function BrowserActionButton({ label, action, tooltip, ...props }: BrowserActionButtonProps) {
  const reasonId = useId();
  const reason = action.kind === "disabled" ? action.reason : null;
  return (
    <>
      <IconButton
        aria-label={label}
        tooltip={reason ?? tooltip ?? label}
        aria-describedby={reason === null ? undefined : reasonId}
        // The tooltip trigger drops Base UI's aria-disabled, so it is set here directly.
        disabled={reason !== null}
        focusableWhenDisabled
        aria-disabled={reason === null ? undefined : true}
        onClick={action.kind === "enabled" ? action.run : undefined}
        {...props}
      />
      {reason === null ? null : <span id={reasonId} hidden>{reason}</span>}
    </>
  );
}
