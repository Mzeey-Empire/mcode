import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { IconComponent } from "@/components/chat/tool-renderers/constants";

/** Open state for a row whose owner keeps it across unmounts. */
export interface RowExpansion {
  readonly open: boolean;
  readonly onToggle: () => void;
}

/** Uses the owner's expansion when given, otherwise row-local state. */
export function useRowExpansion(owned?: RowExpansion): RowExpansion {
  const [localOpen, setLocalOpen] = useState(false);
  return owned ?? { open: localOpen, onToggle: () => setLocalOpen((current) => !current) };
}

/** Click target for a row that discloses more below it. */
export interface NarrativeToolRowDisclosure {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly controlsId?: string;
}

interface NarrativeToolRowProps {
  icon: IconComponent;
  label: ReactNode;
  /** Detail and meta segments, in reading order, after the label. */
  children?: ReactNode;
  /** Omitted for rows that have nothing to disclose. */
  disclosure?: NarrativeToolRowDisclosure;
}

const ROW_CLASS = "inline-flex h-7 w-fit max-w-full min-w-0 items-center gap-2 overflow-hidden rounded-sm px-2 text-left";

/**
 * One collapsed narrative tool row: icon, muted label, optional detail and
 * meta, and a chevron right after the content when the row discloses more.
 * Rows never open themselves; only the user's click toggles them.
 */
export function NarrativeToolRow({ icon: Icon, label, children, disclosure }: NarrativeToolRowProps) {
  const content = (
    <>
      <Icon className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
      {/* A detail after the label gives way first, but a long tool name still fades so the chevron stays in the row. A label alone may shrink so its parts can fade. */}
      <span className={`${children ? "max-w-[60%] shrink-0 text-fade" : "flex min-w-0"} text-sm font-medium text-muted`}>{label}</span>
      {children}
    </>
  );
  if (!disclosure) return <div className={ROW_CLASS}>{content}</div>;
  return (
    <button
      type="button"
      onClick={disclosure.onToggle}
      aria-expanded={disclosure.open}
      aria-controls={disclosure.controlsId}
      className={`${ROW_CLASS} transition-colors duration-100 hover:bg-hover motion-reduce:transition-none`}
    >
      {content}
      <ChevronRight
        className={`size-3.5 shrink-0 text-muted transition-transform duration-150 motion-reduce:transition-none ${disclosure.open ? "rotate-90" : ""}`}
        aria-hidden="true"
      />
    </button>
  );
}

type TooltipState = "unmounted" | "open" | "closed";

/**
 * A file path or command after the row label. It fades out at the row edge,
 * and hovering reveals `fullText` in a tooltip that mounts on first hover so
 * long transcripts do not pay for one tooltip per row.
 */
export function NarrativeToolRowDetail({ kind, children, fullText }: {
  kind: "file" | "command";
  children: string;
  fullText?: string;
}) {
  const tooltipId = useId();
  const [tooltipState, setTooltipState] = useState<TooltipState>("unmounted");
  const tone = kind === "command" ? "text-code text-ink" : "text-xs text-muted";
  const trigger = (
    <span
      className={`min-w-0 text-fade whitespace-nowrap font-mono ${tone}`}
      onPointerEnter={() => setTooltipState("open")}
      onPointerLeave={() => setTooltipState("closed")}
    >
      {children}
    </span>
  );
  const tooltipText = fullText ?? children;
  if (!tooltipText || tooltipState === "unmounted") return trigger;
  return (
    <Tooltip
      open={tooltipState === "open"}
      onOpenChange={(open) => setTooltipState(open ? "open" : "closed")}
      triggerId={tooltipId}
    >
      <TooltipTrigger id={tooltipId} render={trigger} />
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
}

/** Duration or outcome, such as `0:02` or `failed · 0:03`. */
export function NarrativeToolRowMeta({ children }: { children: ReactNode }) {
  return <span className="shrink-0 font-mono text-xs tabular-nums text-muted">{children}</span>;
}
