import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { isLiveSubagentStatus, type SubagentDetail, type SubagentRoster, type SubagentRosterEntry } from "@mcode/contracts";
import { Button, IconButton } from "@/components/ui/button";
import { PanelHeaderSlot, PanelTitlePill } from "@/components/panels/shell/PanelHeader";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DEFAULT_ICON, TOOL_ICONS, TOOL_LABELS, resolveToolName } from "@/components/chat/tool-renderers/constants";
import { getConversationResidency, MessageList } from "@/features/conversation";
import { TURN_PROSE_CLASS } from "@/features/conversation/narrative/narrative-layout";
import { projectCanonicalMessageList } from "@/features/conversation/messages/canonical-message-projection";
import { useMessageRevealStore } from "@/features/conversation/messages/message-reveal-store";
import { MODEL_PROVIDERS } from "@/lib/model-registry";
import { showChatAdaptive } from "@/lib/right-panel-layout";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { cn } from "@/lib/utils";
import { useThreadRecord } from "@/stores/thread-selectors";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";
import { useSubagentRoster, useSubagentRosterStore } from "../state/subagentRosterStore";
import { subagentStatusLabel } from "../subagent-status";
import { elapsed, useNow } from "../live-duration";
import { subagentKind } from "../subagent-kind";
import { openSubagentDetail, openSubagentsPanel } from "./open-subagent-detail";
import { ParentPromptBubble } from "./ParentPromptBubble";

const LazyMarkdownContent = lazy(() => import("@/components/chat/MarkdownContent"));

function providerName(entry: SubagentRosterEntry): string {
  return MODEL_PROVIDERS.find((provider) => provider.id === entry.provider)?.name ?? entry.provider;
}

/** One roster entry as its own rail tab: what the parent asked, then what the entry's tier can show. */
export function SubagentDetailTab({ threadId, entryId }: { readonly threadId: string; readonly entryId: string }) {
  const roster = useSubagentRoster(threadId);
  const rosterLost = useSubagentRosterStore((state) => state.errors.has(threadId)) && !roster;
  const entry = roster?.entries.find((candidate) => candidate.id === entryId);
  if (!entry) {
    return roster || rosterLost
      ? <p data-testid="subagent-detail-missing" className="px-5 py-6 text-sm text-muted">This subagent is no longer available.</p>
      : null;
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={`${entry.title} subagent details`}>
      <DetailHeader threadId={threadId} entry={entry} />
      <span role="status" className="sr-only">{subagentStatusLabel(entry.status)}</span>
      {entry.tier === "transcript" && entry.childThreadId
        ? <TranscriptBody entry={entry} childThreadId={entry.childThreadId} />
        : <DetailBody>
            {entry.prompt && <ParentPromptBubble prompt={entry.prompt} />}
            {entry.tier === "meta"
              ? <MetaTier threadId={threadId} entry={entry} />
              : <StepsTier threadId={threadId} entry={entry} roster={roster} />}
          </DetailBody>}
    </section>
  );
}

function DetailBody({ children }: { readonly children: ReactNode }) {
  return <ScrollArea className="min-h-0 flex-1"><div className="flex flex-col gap-3.5 px-5 pt-2 pb-4">{children}</div></ScrollArea>;
}

function DetailHeader({ threadId, entry }: { readonly threadId: string; readonly entry: SubagentRosterEntry }) {
  const running = isLiveSubagentStatus(entry.status);
  const now = useNow(running);
  const kind = subagentKind(entry);
  const duration = elapsed(entry, now);
  return <>
    <PanelHeaderSlot slot="leading">
      <PanelTitlePill headingLevel={2} icon={<ProviderIcon provider={entry.provider} size={16} />}>{entry.title}</PanelTitlePill>
    </PanelHeaderSlot>
    <PanelHeaderSlot slot="row2">
      <IconButton shape="round" aria-label="Back to subagents" onClick={() => openSubagentsPanel()}>
        <ArrowLeft size={16} aria-hidden />
      </IconButton>
      <div data-testid="subagent-detail-meta" className="flex h-8 min-w-0 items-center gap-2 rounded-[18px] bg-selected px-3">
        {kind && <span className="text-fade min-w-0 text-xs text-muted">{kind}</span>}
        <span aria-hidden className={cn("size-[7px] shrink-0 rounded-full", running ? "bg-success" : "bg-muted")} />
        {duration && <span className="shrink-0 font-mono text-xs text-ink">{duration}</span>}
      </div>
      {running && entry.canStop && entry.childThreadId && <DetailStop threadId={threadId} entry={entry} childThreadId={entry.childThreadId} />}
    </PanelHeaderSlot>
  </>;
}

function DetailStop({ threadId, entry, childThreadId }: {
  readonly threadId: string; readonly entry: SubagentRosterEntry; readonly childThreadId: string;
}) {
  const [pending, setPending] = useState(false);
  const stop = async () => {
    if (pending) return;
    setPending(true);
    try {
      const result = await getTransport().stopCanonicalSubagent(threadId, childThreadId);
      if (result.status === "interrupted" || result.status === "already-terminal") {
        await useSubagentRosterStore.getState().refresh(threadId);
      } else {
        useToastStore.getState().show({ kind: "failed", title: `Couldn't stop ${entry.title}`, meta: result.message ?? undefined });
      }
    } catch {
      useToastStore.getState().show({ kind: "failed", title: `Couldn't stop ${entry.title}` });
    } finally {
      setPending(false);
    }
  };
  return (
    <IconButton shape="round" aria-label={`Stop ${entry.title}`} disabled={pending} aria-busy={pending} onClick={() => void stop()}>
      <span aria-hidden className="size-2.5 rounded-[2px] bg-ink" />
    </IconButton>
  );
}

function TranscriptBody({ entry, childThreadId }: { readonly entry: SubagentRosterEntry; readonly childThreadId: string }) {
  useEffect(() => {
    const residency = getConversationResidency();
    residency.mountDisplayConversation(childThreadId);
    return () => residency.unmountDisplayConversation(childThreadId);
  }, [childThreadId]);
  const legacyMessages = useThreadRecord(childThreadId, (record) => record.messages);
  const canonicalState = useThreadRecord(childThreadId, (record) => record.canonicalAgent.state);
  // A live child's prompt can exist only as a canonical item, so read the messages the transcript renders.
  const firstUserText = useMemo(() => {
    const messages = projectCanonicalMessageList({
      threadId: childThreadId, state: canonicalState, messages: legacyMessages, toolCalls: [], thoughtSegments: [],
    })?.messages ?? legacyMessages;
    return messages.find((message) => message.role === "user")?.content;
  }, [childThreadId, canonicalState, legacyMessages]);
  // The child's transcript usually opens with the same prompt; showing it twice reads as two requests.
  const showPrompt = entry.prompt !== null && entry.prompt.trim() !== firstUserText?.trim();
  return (
    <div className="min-h-0 flex-1">
      <MessageList displayThreadId={childThreadId} onSubagentSelect={openSubagentDetail} onOpenSubagents={openSubagentsPanel}
        leadingContent={showPrompt && entry.prompt ? <div className="px-5 pt-2"><ParentPromptBubble prompt={entry.prompt} /></div> : undefined} />
    </div>
  );
}

function MetaTier({ threadId, entry }: { readonly threadId: string; readonly entry: SubagentRosterEntry }) {
  const sourceMessageId = entry.sourceMessageId;
  return <>
    <p className="text-body-small text-muted">
      {providerName(entry)} doesn't share this subagent's steps or answer. Its result is in the reply that followed.
    </p>
    {sourceMessageId && (
      <Button type="button" variant="secondary" size="compact" shape="round" className="self-start bg-selected"
        onClick={() => {
          const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
          if (workspaceId) showChatAdaptive(workspaceId, threadId);
          useMessageRevealStore.getState().requestReveal(threadId, sourceMessageId);
        }}>
        Show in chat
      </Button>
    )}
  </>;
}

function StepsTier({ threadId, entry, roster }: {
  readonly threadId: string; readonly entry: SubagentRosterEntry; readonly roster: SubagentRoster | undefined;
}) {
  const [detail, setDetail] = useState<SubagentDetail | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  // A roster revision is the server's signal that this entry's steps or summary may have moved.
  const revision = `${roster?.epoch}:${roster?.revision}`;
  useEffect(() => {
    let cancelled = false;
    void getTransport().loadSubagentDetail(threadId, entry.id).then((loaded) => {
      if (!cancelled) { setDetail(loaded); setError(false); }
    }, () => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [threadId, entry.id, revision, retry]);
  return <>
    {error && <p role="alert" className="flex items-center gap-2 text-sm text-ink">
      Couldn't load subagent activity <Button variant="ghost" size="compact" onClick={() => setRetry((value) => value + 1)}>Retry</Button>
    </p>}
    {detail && <StepsDetail detail={detail} running={isLiveSubagentStatus(entry.status)} />}
  </>;
}

function StepsDetail({ detail, running }: { readonly detail: SubagentDetail; readonly running: boolean }) {
  return <>
    {detail.totalSteps > detail.steps.length && (
      <p className="text-xs text-muted">Showing the last {detail.steps.length} of {detail.totalSteps} steps.</p>
    )}
    {detail.steps.length > 0 && (
      <ul aria-label="Subagent steps" className="flex flex-col gap-0.5">
        {detail.steps.map((step) => <StepRow key={step.toolCallId} step={step} />)}
      </ul>
    )}
    {detail.totalSteps === 0 && !running && <p className="text-body-small text-muted">No steps were recorded.</p>}
    {detail.summary && <SubagentReply text={detail.summary} />}
  </>;
}

/** The subagent's final report, rendered the way the main thread renders an agent reply. */
function SubagentReply({ text }: { readonly text: string }) {
  return (
    <div data-testid="subagent-reply" className={TURN_PROSE_CLASS}>
      <Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
        <LazyMarkdownContent content={text} isStreaming={false} />
      </Suspense>
    </div>
  );
}

/** "Read file" reads as "Read <target>" in a step row, so the label's first word is the verb. */
function stepVerb(toolName: string): string {
  return TOOL_LABELS[toolName]?.split(" ")[0] ?? toolName;
}

function StepRow({ step }: { readonly step: SubagentDetail["steps"][number] }) {
  const toolName = resolveToolName(step.toolName);
  const Icon = TOOL_ICONS[toolName] ?? DEFAULT_ICON;
  const verb = stepVerb(toolName);
  return (
    <li data-testid="subagent-step" className="flex h-7 min-w-0 items-center gap-2 text-body-small">
      <Icon size={14} aria-hidden className={cn("shrink-0", step.status === "failed" ? "text-error" : "text-muted")} />
      <span className="shrink-0 text-muted">{verb}</span>
      {step.label !== step.toolName && <span className="text-fade min-w-0 flex-1 text-ink">{step.label}</span>}
      <StepChanges additions={step.additions ?? 0} deletions={step.deletions ?? 0} />
    </li>
  );
}

/** Matches the main thread's turn change counts so the same edit reads the same in both places. */
function StepChanges({ additions, deletions }: { readonly additions: number; readonly deletions: number }) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span className="ml-auto flex shrink-0 gap-1.5 font-mono text-caption tabular-nums">
      {additions > 0 && <span className="text-success">+{additions}</span>}
      {deletions > 0 && <span className="text-error">−{deletions}</span>}
    </span>
  );
}
