import { useMemo, useRef, type ReactNode } from "react";
import { isGoalStatusNotice } from "@/lib/goal-message";
import { measureMessageListPerformance } from "@/performance/message-list-performance";
import {
  createTranscriptItemProjector,
  type CurrentTurnResponseIdentity,
} from "./virtual-items";
import type { MessageListData } from "./useMessageListData";
import { expandTranscriptNarrative, expandTranscriptToolGroups } from "./transcript-narrative-items";
import { useToolCallTransitions } from "./useToolCallTransitions";
import {
  type MessageListItem,
} from "./message-list-virtualization";

type MessageListItemsInput = Pick<
  MessageListData,
  | "agentDisplayState"
  | "agentStartTime"
  | "assistantResponseKeys"
  | "currentTurnMessageId"
  | "currentTurnResponseKey"
  | "turnExecutionId"
  | "hooks"
  | "isAgentRunning"
  | "latestTurnWithChanges"
  | "messages"
  | "permissions"
  | "persistedFilesChanged"
  | "persistedNarrativeByMessage"
  | "renderedThreadId"
  | "streamingText"
  | "thoughtSegments"
  | "toolCalls"
  | "turnSummariesByMessageId"
> & {
  readonly expandedGroups: ReadonlySet<string>;
  readonly leadingContent?: ReactNode;
  readonly afterFirstUserContent?: ReactNode;
};

function insertAfterFirstUserMessage(
  items: MessageListItem[],
  content: ReactNode | undefined,
): MessageListItem[] {
  if (content === undefined) return items;
  const firstUserIndex = items.findIndex((item) =>
    item.type === "message" && item.message.role === "user" && !item.message.is_internal,
  );
  const startupItem: MessageListItem = {
    key: "after-first-user-content",
    type: "after-first-user-content",
    content,
  };
  if (firstUserIndex < 0) return [startupItem, ...items];
  return [
    ...items.slice(0, firstUserIndex + 1),
    startupItem,
    ...items.slice(firstUserIndex + 1),
  ];
}

function createCurrentTurn({
  renderedThreadId,
  currentTurnMessageId,
  currentTurnResponseKey,
  assistantResponseKeys,
  turnExecutionId,
}: Pick<
  MessageListItemsInput,
  "renderedThreadId" | "currentTurnMessageId" | "currentTurnResponseKey" | "assistantResponseKeys" | "turnExecutionId"
>): CurrentTurnResponseIdentity | undefined {
  if (!renderedThreadId) return undefined;
  return {
    threadId: renderedThreadId,
    executionId: turnExecutionId ?? undefined,
    messageId: currentTurnMessageId || undefined,
    responseKey: currentTurnResponseKey || undefined,
    responseKeysByMessageId: assistantResponseKeys,
  };
}

function findLastAgentMessageBody(input: Pick<
  MessageListItemsInput,
  "renderedThreadId" | "isAgentRunning" | "messages"
>): string | undefined {
  if (!input.renderedThreadId || input.isAgentRunning) return undefined;
  return [...input.messages]
    .reverse()
    .find((message) => message.role === "assistant" && !isGoalStatusNotice(message.content))
    ?.content;
}

/** Projects stateful transcript data into virtual rows. */
export function useMessageListItems(input: MessageListItemsInput) {
  const {
    agentDisplayState,
    agentStartTime,
    assistantResponseKeys,
    currentTurnMessageId,
    currentTurnResponseKey,
    turnExecutionId,
    hooks,
    isAgentRunning,
    latestTurnWithChanges,
    messages,
    permissions,
    persistedFilesChanged,
    persistedNarrativeByMessage,
    renderedThreadId,
    streamingText,
    thoughtSegments,
    toolCalls,
    turnSummariesByMessageId,
  } = input;
  const currentTurn = useMemo(
    () => createCurrentTurn({
      renderedThreadId,
      currentTurnMessageId,
      currentTurnResponseKey,
      assistantResponseKeys,
      turnExecutionId,
    }),
    [
      assistantResponseKeys,
      currentTurnMessageId,
      currentTurnResponseKey,
      renderedThreadId,
      turnExecutionId,
    ],
  );
  const transcriptProjectorRef = useRef<ReturnType<typeof createTranscriptItemProjector> | null>(null);
  if (transcriptProjectorRef.current === null) {
    transcriptProjectorRef.current = createTranscriptItemProjector();
  }
  const virtualItems = useMemo(
    () => measureMessageListPerformance("narrativeItemProjection", () => transcriptProjectorRef.current!({
      messages,
      persistedFilesChanged,
      latestTurnWithChanges,
      currentTurn,
      persistedNarrativeByMessage,
      turnSummariesByMessageId,
      toolCalls,
      agentDisplayState,
      agentStartTime,
      streamingText,
      permissions,
      hooks,
      thoughtSegments,
      committedAssistantBody: findLastAgentMessageBody({
        renderedThreadId,
        isAgentRunning,
        messages,
      }),
    })),
    [
      currentTurn,
      agentDisplayState,
      agentStartTime,
      hooks,
      isAgentRunning,
      latestTurnWithChanges,
      messages,
      permissions,
      persistedFilesChanged,
      persistedNarrativeByMessage,
      renderedThreadId,
      streamingText,
      thoughtSegments,
      toolCalls,
      turnSummariesByMessageId,
    ],
  );
  const toolTransitions = useToolCallTransitions(toolCalls);
  const narrativeItems = useMemo(
    () => expandTranscriptNarrative(virtualItems, persistedNarrativeByMessage, currentTurn, toolTransitions),
    [virtualItems, persistedNarrativeByMessage, currentTurn, toolTransitions],
  );
  const expandedItems = useMemo(
    () => expandTranscriptToolGroups(narrativeItems, input.expandedGroups),
    [narrativeItems, input.expandedGroups],
  );
  const items = useMemo<MessageListItem[]>(
    () => insertAfterFirstUserMessage(
      input.leadingContent === undefined
        ? expandedItems
        : [{ key: "leading-content", type: "leading-content", content: input.leadingContent }, ...expandedItems],
      input.afterFirstUserContent,
    ),
    [input.afterFirstUserContent, input.leadingContent, expandedItems],
  );
  return { items };
}
