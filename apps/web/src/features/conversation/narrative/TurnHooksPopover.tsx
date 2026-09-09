import { useState } from "react";
import { CircleAlert, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { HookExecution } from "@/transport/types";

function summarizeHooks(hooks: readonly HookExecution[]) {
  const groups: { hook: HookExecution; count: number }[] = [];
  for (const hook of hooks) {
    const previous = groups.at(-1);
    if (previous?.hook.hookName === hook.hookName && previous.hook.toolName === hook.toolName) {
      previous.count += 1;
    } else {
      groups.push({ hook, count: 1 });
    }
  }
  return groups;
}

function HookSummary({ hook, count }: { hook: HookExecution; count: number }) {
  const separator = hook.hookName.indexOf(":");
  const trigger = separator < 0 ? hook.hookName : hook.hookName.slice(0, separator);
  const name = separator < 0 ? hook.toolName : hook.hookName.slice(separator + 1);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-start gap-x-3">
      <dt className="break-words [overflow-wrap:anywhere]">{trigger}</dt>
      <dd className="min-w-0 text-muted-foreground">
        <div>{count} {count === 1 ? "run" : "runs"}</div>
        {name && <div className="break-words [overflow-wrap:anywhere]">{name}</div>}
      </dd>
    </div>
  );
}

function hookNeedsAttention(hook: HookExecution): boolean {
  return hook.didBlock === true
    || (hook.status === "completed" && hook.exitCode != null && hook.exitCode !== 0);
}

/** Shows hook triggers, names, and consecutive run counts beside final-response actions. */
export function TurnHooksPopover({ hooks }: { hooks: readonly HookExecution[] }) {
  const [open, setOpen] = useState(false);
  if (hooks.length === 0) return null;
  const needsAttention = hooks.some(hookNeedsAttention);
  const running = hooks.some((hook) => hook.status === "running");
  const label = needsAttention ? "Hooks: attention required" : running ? "Hooks: running" : "Hooks";
  const Icon = needsAttention ? CircleAlert : Webhook;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={150}
        onKeyUp={(event) => { if (event.key === "Tab") setOpen(true); }}
        render={<Button variant="ghost" size="icon-xs" />}
        aria-label={label}
        className={`size-7 ${needsAttention ? "text-destructive" : running ? "text-primary" : "text-muted-foreground"}`}
      >
        <Icon className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        aria-label="Hooks"
        align="start"
        side="top"
        className="w-72 max-w-[calc(100vw-2rem)] p-3 font-sans text-xs normal-case tracking-normal"
        initialFocus={false}
      >
        <h3 className="mb-2 text-sm font-medium">Hooks</h3>
        <ScrollArea viewportClassName="max-h-[min(60vh,24rem)]">
          <dl className="flex min-w-0 flex-col gap-1.5 leading-5">
            {summarizeHooks(hooks).map(({ hook, count }, index) => (
              <HookSummary key={`${hook.hookName}-${index}`} hook={hook} count={count} />
            ))}
          </dl>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
