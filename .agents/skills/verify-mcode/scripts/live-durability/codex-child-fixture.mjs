import * as NodeFS from 'node:fs';
import * as NodePath from 'node:path';
import * as NodeCrypto from 'node:crypto';

/** Emits one supported raw Codex child without synthesizing app events or continuation commands. */
export async function emitControlledCodexChild(channel, { activeTurns, nativeChildren, controlDir }) {
  const { runId, control, notify, base, stamp, deadline } = channel;
  const threadId = NodeCrypto.randomUUID();
  const turnId = NodeCrypto.randomUUID();
  const collabId = runId + '-child-spawn';
  const toolId = runId + '-child-tool';
  const child = { honorCancel: true, cancelled: false };
  const childBase = { threadId, turnId };
  const metadata = { threadId, turnId, collabId, toolId, parentNativeThreadId: base.threadId };
  nativeChildren.set(threadId, { name: 'durability_child', prompt: 'Read the owned fixture child marker.' });
  activeTurns.set(threadId, child);
  const spawn = { id: collabId, type: 'collabAgentToolCall', tool: 'spawnAgent', prompt: 'Read the owned fixture child marker.',
    task_name: 'durability_child', model: 'fixture-model', reasoningEffort: 'low', receiverThreadIds: [threadId] };
  notify('item/started', { ...base, item: { ...spawn, status: 'inProgress' } });
  notify('item/completed', { ...base, item: { ...spawn, status: 'completed', agentsStates: { [threadId]: { status: 'running' } } } });
  notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } });
  notify('item/started', { ...childBase, item: { id: toolId, type: 'commandExecution', command: 'fixture child marker', cwd: '.', status: 'inProgress' } });
  message(notify, childBase, runId + '-child-prefix', 'LIVE_DURABILITY ' + runId + ' CHILD_PREFIX', 'commentary');
  stamp('child-prefix', metadata);
  try {
    await waitChildGate({ controlDir, runId, control, child, deadline, stamp, metadata });
    const interrupted = child.cancelled || control.cancelled;
    completeChild({ interrupted, notify, childBase, toolId, runId, threadId, turnId, stamp, metadata });
    return !control.cancelled;
  } finally { activeTurns.delete(threadId); }
}

async function waitChildGate({ controlDir, runId, control, child, deadline, stamp, metadata }) {
  const finish = NodePath.join(controlDir, runId + '.child-finish');
  while (control.childMode === 'paused' && !NodeFS.existsSync(finish) && !child.cancelled && !control.cancelled && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (Date.now() >= deadline) { stamp('child-expired', metadata); child.cancelled = true; }
}

function completeChild({ interrupted, notify, childBase, toolId, runId, threadId, turnId, stamp, metadata }) {
  notify('item/completed', { ...childBase, item: { id: toolId, type: 'commandExecution', command: 'fixture child marker', cwd: '.',
    status: interrupted ? 'failed' : 'completed', aggregatedOutput: 'Owned child marker', exitCode: interrupted ? 1 : 0, durationMs: 1 } });
  if (!interrupted) message(notify, childBase, runId + '-child-final', 'LIVE_DURABILITY ' + runId + ' CHILD_COMPLETE', 'final_answer');
  notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: interrupted ? 'interrupted' : 'completed', error: null } });
  stamp(interrupted ? 'child-cancelled' : 'child-completed', metadata);
}

/** Returns actual-shaped child metadata for the mapper's native metadata reads. */
export function childMetadataReply(method, threadId, metadata) {
  const item = { id: threadId + '-parent-prompt', type: 'userMessage', content: [{ type: 'text', text: metadata.prompt }] };
  if (method === 'thread/items/list') return { data: [{ item }], nextCursor: null };
  return { model: 'fixture-model', reasoningEffort: 'low', thread: { id: threadId, name: metadata.name, preview: metadata.prompt, turns: [{ id: threadId + '-seed', items: [item] }] } };
}

function message(notify, base, id, text, phase) {
  notify('item/started', { ...base, item: { id, type: 'agentMessage', text: '', phase } });
  notify('item/agentMessage/delta', { ...base, itemId: id, delta: text });
  notify('item/completed', { ...base, item: { id, type: 'agentMessage', text, phase, memoryCitation: null } });
}
