import { useId } from "react";
import { IconButton, type IconButtonProps } from "@/components/ui/button";
import type { BrowserAction } from "./browserToolbarModel";

/** Props for {@link BrowserActionButton}. */
export type BrowserActionButtonProps = Omit<IconButtonProps, "onClick" | "disabled" | "aria-label"> & {
  readonly label: string;
  readonly action: BrowserAction;
};

/** Keeps disabled actions focusable so their reason remains accessible. */
export function BrowserActionButton({ label, action, tooltip, ...props }: BrowserActionButtonProps) {
  const reasonId = useId();
  const reason = action.kind === "disabled" ? action.reason : null;
  return (
    <>
      <IconButton
        aria-label={label}
        tooltip={reason ?? tooltip ?? label}
        aria-describedby={reason === null ? undefined : reasonId}
        disabled={reason !== null}
        focusableWhenDisabled
        onClick={action.kind === "enabled" ? action.run : undefined}
        {...props}
      />
      {reason === null ? null : <span id={reasonId} hidden>{reason}</span>}
    </>
  );
}
