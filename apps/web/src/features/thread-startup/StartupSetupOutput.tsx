import type { ReactNode } from "react";
import { Pencil, SquareTerminal } from "lucide-react";
import type { ThreadStartup } from "@mcode/contracts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Props for the 04b setup output card under the live setup step. */
export interface StartupSetupOutputProps {
  /** Setup script from the automatic setup gate; each line echoes as a `$` command. */
  readonly script?: string;
  /** Startup transcript; only setup-phase output feeds the tail. */
  readonly transcript: ThreadStartup["transcript"];
  readonly onOpenTerminal?: () => void;
  readonly onEditScript?: () => void;
}

const LINE_CLASS = "font-mono text-caption leading-5";

/** Splits streamed setup chunks into display lines, dropping the trailing partial newline. */
function setupOutputLines(transcript: ThreadStartup["transcript"]): string[] {
  const text = transcript.filter((entry) => entry.phase === "setup").map((entry) => entry.content).join("");
  return text.split(/\r?\n/).filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

function scriptLines(script: string | undefined): string[] {
  return script?.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0) ?? [];
}

function CardIconButton({ label, onClick, children }: { readonly label: string; readonly onClick: () => void; readonly children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className="flex size-6 items-center justify-center rounded-sm text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink"
          >
            {children}
          </button>
        )}
      />
      <TooltipContent side="top" className="text-caption">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Renders the setup script and a bottom-anchored live tail of its output. */
export function StartupSetupOutput({ script, transcript, onOpenTerminal, onEditScript }: StartupSetupOutputProps) {
  const commands = scriptLines(script);
  const output = setupOutputLines(transcript);
  return (
    <div data-testid="startup-setup-output" className="w-full max-w-[56rem] overflow-clip rounded-md border border-border bg-panel">
      <div className="relative min-h-10 border-b border-border px-3 py-2.5 pr-16">
        {commands.map((line, index) => <div key={index} className={cn(LINE_CLASS, "text-ink")}>$ {line}</div>)}
        <div className="absolute right-2 top-2 flex items-center gap-0.5">
          {onOpenTerminal ? <CardIconButton label="Open terminal" onClick={onOpenTerminal}><SquareTerminal size={14} aria-hidden /></CardIconButton> : null}
          {onEditScript ? <CardIconButton label="Edit script" onClick={onEditScript}><Pencil size={14} aria-hidden /></CardIconButton> : null}
        </div>
      </div>
      <div role="log" aria-label="Setup output" className="relative flex h-[16rem] flex-col justify-end overflow-clip px-3 pb-2.5">
        {output.map((line, index) => (
          <div key={index} className={cn(LINE_CLASS, "shrink-0 whitespace-pre-wrap break-words", line.startsWith("$ ") ? "text-ink" : "text-muted")}>
            {line || " "}
          </div>
        ))}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-panel to-transparent" />
      </div>
    </div>
  );
}
