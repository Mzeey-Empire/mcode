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
  /**
   * `neutral` when another control on screen is already the amber next step,
   * for example the composer's Send. Defaults to `primary`.
   */
  emphasis?: "primary" | "neutral";
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

function NoticeIcon({ tone, busy }: { tone: NoticeTone; busy: boolean }) {
  const { Icon, className } = TONE_ICON[tone];
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      {busy ? <Spinner size={16} className="text-muted" /> : <Icon size={20} aria-hidden className={className} />}
    </span>
  );
}

function NoticeDisclosure({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-expanded={open}
      aria-label={open ? "Hide details" : "Show details"}
      onClick={onToggle}
      className="text-muted"
    >
      {open ? <CollapseIcon aria-hidden /> : <ExpandIcon aria-hidden />}
    </Button>
  );
}

function NoticeAction({ action }: { action: NoticeAction }) {
  return (
    <div className="pl-8 pt-1">
      <Button type="button" variant={action.emphasis === "neutral" ? "secondary" : "default"} onClick={action.onClick}>{action.label}</Button>
    </div>
  );
}

interface NoticeHeaderProps {
  tone: NoticeTone;
  title: ReactNode;
  busy?: boolean;
  disclosure: { open: boolean; onToggle: () => void } | null;
  onDismiss?: () => void;
  dismissLabel?: string;
}

function NoticeHeader({ tone, title, busy = false, disclosure, onDismiss, dismissLabel = "Dismiss" }: NoticeHeaderProps) {
  return (
    <div className="flex items-center gap-3">
      <NoticeIcon tone={tone} busy={busy} />
      <div className="min-w-0 flex-1 text-body font-medium text-ink">{title}</div>
      {disclosure ? <NoticeDisclosure open={disclosure.open} onToggle={disclosure.onToggle} /> : null}
      {onDismiss ? (
        <Button type="button" variant="ghost" size="icon" aria-label={dismissLabel} onClick={onDismiss} className="text-muted">
          <CloseIcon aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Inline notice: tone icon, title, detail and one action, on the panel surface.
 * Errors announce assertively; every other tone announces politely.
 */
export function Notice({ tone, title, detail, action, busy, collapsible = false, onDismiss, dismissLabel, className, "data-testid": testId }: NoticeProps) {
  const [open, setOpen] = useState(false);
  const canCollapse = collapsible && detail !== undefined;
  const showDetail = detail !== undefined && (!canCollapse || open);

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-tone={tone}
      data-testid={testId}
      className={cn("flex flex-col gap-2 rounded-xl border border-border bg-panel p-4", className)}
    >
      <NoticeHeader
        tone={tone}
        title={title}
        busy={busy}
        disclosure={canCollapse ? { open, onToggle: () => setOpen((value) => !value) } : null}
        onDismiss={onDismiss}
        dismissLabel={dismissLabel}
      />
      {showDetail ? <div className="pl-8 text-body-small text-muted">{detail}</div> : null}
      {action ? <NoticeAction action={action} /> : null}
    </div>
  );
}
