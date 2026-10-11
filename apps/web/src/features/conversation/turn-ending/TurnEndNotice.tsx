import { useState } from "react";
import { CircleAlert, Clock, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import type { FilledNotice, QuietNotice, TurnEndAction, TurnEndNoticeView } from "./turn-ending-notice";

/** Handlers for the actions this build supports. A notice renders only actions with a handler. */
export type TurnEndActionHandlers = Partial<Record<TurnEndAction, () => void>>;

interface TurnEndNoticeProps {
  notice: TurnEndNoticeView;
  actions?: TurnEndActionHandlers;
  /** True while the primary action's request is in flight. */
  pending?: boolean;
  /** Why the last action failed, shown under the notice. */
  error?: string | null;
}

// A class, not the strokeWidth prop: the base-layer `.lucide` rule outranks the SVG attribute.
const ICON_PROPS = { "aria-hidden": true, className: "size-4 shrink-0 [stroke-width:1.6]" } as const;
const TEXT_BUTTON = "h-7 px-2.5 text-[1.3rem]/[1.8rem] font-medium text-muted hover:text-ink";

/** The notice under a settled turn that did not complete. */
export function TurnEndNotice({ notice, actions = {}, pending = false, error = null }: TurnEndNoticeProps) {
  return (
    <div data-testid="turn-end-notice">
      {notice.style === "quiet" ? <QuietTurnEndNotice notice={notice} /> : <FilledTurnEndNotice notice={notice} actions={actions} pending={pending} />}
      {error ? <p role="alert" className="mt-1 text-[1.3rem]/[1.8rem] text-error">{error}</p> : null}
    </div>
  );
}

function QuietTurnEndNotice({ notice }: { notice: QuietNotice }) {
  return (
    <div className="flex items-center gap-3 py-1 pr-2.5 text-muted">
      <Square {...ICON_PROPS} />
      <div className="flex flex-col">
        <p className="text-body-small">{notice.title}</p>
        {notice.detail ? <p className="text-[1.3rem]/[1.8rem]">{notice.detail}</p> : null}
      </div>
    </div>
  );
}

function FilledTurnEndNotice({ notice, actions, pending }: { notice: FilledNotice; actions: TurnEndActionHandlers; pending: boolean }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const Icon = notice.icon === "usage_limit" ? Clock : CircleAlert;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2.5 rounded-xl bg-panel py-2.5 pr-2.5 pl-3.5">
      <Icon {...ICON_PROPS} className={cn(ICON_PROPS.className, notice.icon === "usage_limit" ? "text-primary" : "text-error")} />
      <div className="flex min-w-0 flex-auto flex-col gap-0.5">
        <p className="text-body-small font-medium text-ink">{notice.title}</p>
        {notice.detail ? <p className="text-[1.3rem]/[1.8rem] text-muted">{notice.detail}</p> : null}
      </div>
      {notice.details ? (
        <Button type="button" variant="ghost" className={TEXT_BUTTON} aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
          {detailsOpen ? "Hide details" : "Details"}
        </Button>
      ) : null}
      <TurnEndActions notice={notice} actions={actions} pending={pending} />
      {notice.details && detailsOpen ? <TurnEndDetails text={notice.details} /> : null}
    </div>
  );
}

function TurnEndActions({ notice, actions, pending }: { notice: FilledNotice; actions: TurnEndActionHandlers; pending: boolean }) {
  const { primary, secondary } = notice;
  const onSecondary = secondary && actions[secondary.action];
  const onPrimary = primary && actions[primary.action];
  return (
    <>
      {secondary && onSecondary ? (
        <Button type="button" variant="ghost" className={TEXT_BUTTON} onClick={onSecondary}>{secondary.label}</Button>
      ) : null}
      {primary && onPrimary ? (
        <Button type="button" variant="subtle" shape="round" className="h-7 px-3 text-[1.3rem]/[1.8rem] font-medium" disabled={pending} onClick={onPrimary}>
          {primary.label}
        </Button>
      ) : null}
    </>
  );
}

function TurnEndDetails({ text }: { text: string }) {
  return (
    <div className="relative min-w-0 basis-full rounded-lg bg-background py-2.5 pr-1.5 pl-3">
      <pre className="pr-7 font-mono text-[1.2rem]/[1.8rem] whitespace-pre-wrap [overflow-wrap:anywhere] text-muted">{text}</pre>
      <CopyButton text={text} label="Copy details" className="absolute top-2.5 right-1.5 size-6" />
    </div>
  );
}
