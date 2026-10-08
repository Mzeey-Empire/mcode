import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  CloseIcon,
  CollapseIcon,
  ConfirmedIcon,
  ErrorIcon,
  ExpandIcon,
  InfoIcon,
  WarningIcon,
} from "@/components/ui/icon-map";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/** The four notice tones from the Paper Feedback board. */
export type NoticeTone = "info" | "warning" | "error" | "success";

const TONE_ICON = {
  info: { Icon: InfoIcon, className: "text-info" },
  warning: { Icon: WarningIcon, className: "text-warning" },
  error: { Icon: ErrorIcon, className: "text-error" },
  success: { Icon: ConfirmedIcon, className: "text-success" },
} as const;

/** The single action a notice offers. */
export interface NoticeAction {
  label: string;
  onClick: () => void;
}

/** Props for {@link Notice}. */
export interface NoticeProps {
  tone: NoticeTone;
  title: ReactNode;
  detail?: ReactNode;
  /** One primary action. A notice never offers a second. */
  action?: NoticeAction;
  /** Replaces the tone icon with a spinner while the notice's condition resolves. */
  busy?: boolean;
  /** Hides the detail behind a disclosure button until the user opens it. */
  collapsible?: boolean;
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
  "data-testid"?: string;
}

/**
 * Inline notice: tone icon, title, detail and one action, on the panel surface.
 * Errors announce assertively; every other tone announces politely.
 */
export function Notice({
  tone,
  title,
  detail,
  action,
  busy = false,
  collapsible = false,
  onDismiss,
  dismissLabel = "Dismiss",
  className,
  "data-testid": testId,
}: NoticeProps) {
  const [open, setOpen] = useState(false);
  const showDetail = detail !== undefined && (!collapsible || open);
  const { Icon, className: toneClass } = TONE_ICON[tone];

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-tone={tone}
      data-testid={testId}
      className={cn("flex flex-col gap-2 rounded-xl border border-border bg-panel p-4", className)}
    >
      <div className="flex items-center gap-3">
        <span className="flex size-5 shrink-0 items-center justify-center">
          {busy ? <Spinner size={16} className="text-muted" /> : <Icon size={20} aria-hidden className={toneClass} />}
        </span>
        <div className="min-w-0 flex-1 text-body font-medium text-ink">{title}</div>
        {collapsible && detail !== undefined ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-expanded={open}
            aria-label={open ? "Hide details" : "Show details"}
            onClick={() => setOpen((value) => !value)}
            className="text-muted"
          >
            {open ? <CollapseIcon aria-hidden /> : <ExpandIcon aria-hidden />}
          </Button>
        ) : null}
        {onDismiss ? (
          <Button type="button" variant="ghost" size="icon" aria-label={dismissLabel} onClick={onDismiss} className="text-muted">
            <CloseIcon aria-hidden />
          </Button>
        ) : null}
      </div>
      {showDetail ? <div className="pl-8 text-body-small text-muted">{detail}</div> : null}
      {action ? (
        <div className="pl-8 pt-1">
          <Button type="button" onClick={action.onClick}>{action.label}</Button>
        </div>
      ) : null}
    </div>
  );
}
