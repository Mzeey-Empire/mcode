import { Globe } from "lucide-react";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToastStore } from "@/stores/toastStore";
import { cn } from "@/lib/utils";
import { openTerminalUrl } from "./openTerminalUrl";

interface ActionPortPillProps {
  readonly run: WorkspaceEnvironmentActionRun;
  readonly threadId: string;
}

/**
 * Row-2 pill for the port the action's output announced. It is live only while the
 * current run's port accepts connections. Otherwise it stays as muted history, so a
 * stopped or restarting dev server still shows where it last listened. TCP is all the
 * probe proves, so the tooltip never claims the page works.
 */
export function ActionPortPill({ run, threadId }: ActionPortPillProps) {
  const { port } = run;
  if (!port) return null;
  const live = port.runId === run.runId && port.reachable;
  const address = new URL(port.url).host;
  const open = () => {
    openTerminalUrl({ url: port.url, loopback: true }, threadId).catch(() => {
      useToastStore.getState().show({ kind: "failed", title: "Couldn't open the link", meta: port.url });
    });
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="action-port-pill"
            data-live={live}
            aria-label={`Open ${port.url} in the Browser tab`}
            onClick={open}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-selected pr-3 pl-2.5 font-mono text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus",
              live ? "text-ink" : "text-muted",
            )}
          >
            <Globe className="size-3.5 shrink-0" aria-hidden />
            :{port.port}
          </button>
        }
      />
      <TooltipContent>{live ? `Accepting connections on ${address}` : `Not accepting connections on ${address}`}</TooltipContent>
    </Tooltip>
  );
}
