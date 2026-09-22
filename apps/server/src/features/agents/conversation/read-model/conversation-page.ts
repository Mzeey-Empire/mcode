import type {
  ConversationNewerPage,
  ConversationNewerPageRequest,
  ConversationOlderPage,
  ConversationOlderPageRequest,
  ConversationPage,
  ConversationTail,
  ConversationTailMessage,
} from "@mcode/contracts";
import { CONVERSATION_TAIL_MAX_MESSAGES } from "@mcode/contracts";
import type { MessageRepo } from "../persistence/message-repo.js";
import type { PlanQuestionAnswersRepo } from "../../planning/persistence/plan-question-answers-repo.js";

/** Dependencies needed to load one paginated conversation page. */
export interface ConversationPageDeps {
  messageRepo: MessageRepo;
  planQuestionAnswersRepo: PlanQuestionAnswersRepo;
}

/** Dependencies needed to load a bounded conversation tail. */
export interface ConversationTailDeps {
  messageRepo: MessageRepo;
}

/** Loads one compact display-table message page. Narrative details hydrate on demand. */
export function loadConversationPage(
  deps: ConversationPageDeps,
  input: { threadId: string; limit: number; before?: number },
): ConversationPage {
  const page = deps.messageRepo.listByThread(input.threadId, input.limit, input.before);

  return {
    messages: page.messages,
    sessionNotices: deps.messageRepo.listSessionNotices(input.threadId),
    hasMore: page.hasMore,
    answeredPlanMessageIds:
      deps.planQuestionAnswersRepo.listAnsweredForThread(input.threadId),
    narrativeByMessage: {},
  };
}

function buildOlderConversationPage(
  request: ConversationOlderPageRequest,
  page: ConversationPage,
  droppedMessages: boolean,
): ConversationOlderPage {
  const retainedMessageIds = new Set(page.messages.map((message) => message.id));
  const hasMore = page.hasMore || droppedMessages;
  return {
    identity: {
      threadId: request.threadId,
      cursor: request.cursor,
      direction: request.direction,
      generation: request.generation,
      conversationRevision: request.conversationRevision,
    },
    messages: page.messages,
    hasMore,
    nextCursor: hasMore && page.messages.length > 0
      ? { version: 1, beforeSequence: page.messages[0].sequence }
      : null,
    answeredPlanMessageIds: page.answeredPlanMessageIds?.filter((messageId) =>
      retainedMessageIds.has(messageId)
    ),
    narrativeByMessage: Object.fromEntries(
      Object.entries(page.narrativeByMessage).filter(([messageId]) =>
        retainedMessageIds.has(messageId)
      ),
    ),
  };
}

/** Loads the nearest older messages under the caller's bounded response budget. */
export function loadOlderConversationPage(
  deps: ConversationPageDeps,
  request: ConversationOlderPageRequest,
): ConversationOlderPage {
  const page = loadConversationPage(deps, {
    threadId: request.threadId,
    limit: request.limit,
    before: request.cursor.beforeSequence,
  });
  let retainedMessages = page.messages;
  let droppedMessages = false;

  while (retainedMessages.length > 0) {
    const candidate = buildOlderConversationPage(
      request,
      { ...page, messages: retainedMessages },
      droppedMessages,
    );
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= request.maxBytes) {
      return candidate;
    }
    retainedMessages = retainedMessages.slice(1);
    droppedMessages = true;
  }

  if (page.messages.length > 0) {
    throw new Error(
      `The nearest older conversation message cannot fit within ${request.maxBytes} bytes`,
    );
  }

  return buildOlderConversationPage(request, page, false);
}

function buildNewerConversationPage(
  request: ConversationNewerPageRequest,
  page: ConversationPage,
  droppedMessages: boolean,
): ConversationNewerPage {
  const retainedMessageIds = new Set(page.messages.map((message) => message.id));
  const hasMore = page.hasMore || droppedMessages;
  return {
    identity: {
      threadId: request.threadId,
      cursor: request.cursor,
      direction: request.direction,
      generation: request.generation,
      conversationRevision: request.conversationRevision,
    },
    messages: page.messages,
    hasMore,
    nextCursor: hasMore && page.messages.length > 0
      ? { version: 1, afterSequence: page.messages.at(-1)!.sequence }
      : null,
    answeredPlanMessageIds: page.answeredPlanMessageIds?.filter((messageId) =>
      retainedMessageIds.has(messageId)
    ),
    narrativeByMessage: Object.fromEntries(
      Object.entries(page.narrativeByMessage).filter(([messageId]) =>
        retainedMessageIds.has(messageId)
      ),
    ),
  };
}

/** Loads the nearest newer messages under the caller's bounded response budget. */
export function loadNewerConversationPage(
  deps: ConversationPageDeps,
  request: ConversationNewerPageRequest,
): ConversationNewerPage {
  const page = loadNewerConversationSource(deps, request);
  return fitNewerConversationPage(request, page);
}

function loadNewerConversationSource(
  deps: ConversationPageDeps,
  request: ConversationNewerPageRequest,
): ConversationPage {
  const page = deps.messageRepo.listByThreadAfter(
    request.threadId,
    request.limit,
    request.cursor.afterSequence,
  );
  return {
    messages: page.messages,
    hasMore: page.hasMore,
    answeredPlanMessageIds: deps.planQuestionAnswersRepo.listAnsweredForThread(request.threadId),
    narrativeByMessage: {},
  };
}

function fitNewerConversationPage(
  request: ConversationNewerPageRequest,
  page: ConversationPage,
): ConversationNewerPage {
  let retainedMessages = page.messages;
  let droppedMessages = false;

  while (retainedMessages.length > 0) {
    const candidate = buildNewerConversationPage(
      request,
      { ...page, messages: retainedMessages },
      droppedMessages,
    );
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= request.maxBytes) {
      return candidate;
    }
    retainedMessages = retainedMessages.slice(0, -1);
    droppedMessages = true;
  }

  if (page.messages.length > 0) {
    throw new Error(
      `The nearest newer conversation message cannot fit within ${request.maxBytes} bytes`,
    );
  }

  return buildNewerConversationPage(request, page, false);
}

/** Loads the newest visible messages without narrative or plan-answer queries. */
export function loadConversationTail(
  deps: ConversationTailDeps,
  input: { threadId: string; limit: number },
): ConversationTail {
  const limit = Math.min(CONVERSATION_TAIL_MAX_MESSAGES, input.limit);
  const compatibilityPage = deps.messageRepo.listByThread(
    input.threadId,
    limit,
  );
  const messages: ConversationTailMessage[] = compatibilityPage.messages.map((message) => ({
    id: message.id,
    thread_id: message.thread_id,
    role: message.role,
    content: message.content,
    cost_usd: message.cost_usd,
    tokens_used: message.tokens_used,
    timestamp: message.timestamp,
    sequence: message.sequence,
    attachments: message.attachments,
    previewAnnotations: message.previewAnnotations,
    mentions: message.mentions,
    selectedTextComments: message.selectedTextComments,
    tool_call_count: message.tool_call_count,
    reply_to_message_id: message.reply_to_message_id,
    quoted_text: message.quoted_text,
    model: message.model,
    outcome: message.outcome,
    outcomeExecutionId: message.outcomeExecutionId,
    systemNotice: message.systemNotice,
    is_internal: message.is_internal,
    parentAgentProvenance: message.parentAgentProvenance,
  }));
  const hasMore = compatibilityPage.hasMore;
  return {
    messages,
    sessionNotices: deps.messageRepo.listSessionNotices(input.threadId),
    hasMore,
    ...(hasMore && messages.length > 0
      ? { nextBefore: messages[0].sequence }
      : {}),
  };
}
