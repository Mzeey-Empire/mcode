/** Controlled native provider traffic for the live-durability proof; never executes a tool. */
import * as NodeFS from 'node:fs';
import * as NodePath from 'node:path';
import * as NodeReadline from 'node:readline';
import * as NodeCrypto from 'node:crypto';
import { emitControlledCodexChild, childMetadataReply } from './codex-child-fixture.mjs';

const [provider, controlDir, ...cli] = process.argv.slice(2);
const activeTurns = new Map();
const nativeChildren = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
if (!['devin', 'codex'].includes(provider) || !NodePath.isAbsolute(controlDir)) throw new Error('Invalid fixture arguments');
if (cli.includes('--version') || cli[0] === 'version') {
  process.stdout.write(`${provider} 99.0.0\n`);
} else if (cli[0] === 'models') {
  process.stdout.write('Available models\n\nfixture-model - Fixture Model (current, default)\n');
} else if (cli[0] === 'about') {
  process.stdout.write(JSON.stringify({ version: '99.0.0', authenticated: true }) + '\n');
} else {
  NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', handleLine);
}

function handleLine(line) {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (!request || typeof request.method !== 'string') return;
    if (request.method === 'session/cancel' || request.method === 'turn/interrupt') {
      if (request.id !== undefined) reply(request.id, {});
      cancelRequest(request);
      return;
    }
    if (request.id === undefined) return;
    if (replyChildMetadata(request)) return;
    const handler = handlers[request.method];
    if (handler) handler(request);
    else reply(request.id, {});
}

function replyChildMetadata(request) {
  const child = nativeChildren.get(request.params?.threadId);
  if (!child || !['thread/resume', 'thread/read', 'thread/items/list'].includes(request.method)) return false;
  reply(request.id, childMetadataReply(request.method, request.params.threadId, child));
  return true;
}

function cancelRequest(request) {
  const key = provider === 'devin' ? request.params?.sessionId : request.params?.threadId;
  const active = activeTurns.get(key);
  if (active?.honorCancel) active.cancelled = true;
}

const handlers = {
  initialize: request => reply(request.id, provider === 'devin'
    ? { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }
    : { userAgent: 'live-durability-fixture/99.0.0' }),
  'session/new': request => reply(request.id, { sessionId: NodeCrypto.randomUUID(), configOptions: [] }),
  'thread/start': startThread,
  'thread/resume': startThread,
  'session/prompt': handlePrompt,
  'turn/start': handlePrompt,
  'model/list': request => reply(request.id, { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture Model', isDefault: true, supportedReasoningEfforts: [] }], nextCursor: null }),
};

function startThread(request) {
  reply(request.id, { thread: { id: request.params?.threadId ?? NodeCrypto.randomUUID() } });
}

function seedTurn(request) {
  if (provider === 'devin') reply(request.id, { stopReason: 'end_turn' });
  else {
    const id = NodeCrypto.randomUUID();
    reply(request.id, { turn: { id } });
    notify('turn/started', { threadId: request.params.threadId, turn: { id, items: [], status: 'inProgress', error: null } });
    notify('turn/completed', { threadId: request.params.threadId, turn: { id, items: [], status: 'completed', error: null } });
  }
}

function fixtureControl(text) {
  const longToolPairs = Number(/LIVE_DURABILITY_LONG_TOOLS=(\d+)/.exec(text)?.[1] ?? 0);
  const pairDelayMs = Number(/LIVE_DURABILITY_PAIR_DELAY_MS=(\d+)/.exec(text)?.[1] ?? 10);
  if (!validHistoryControl(longToolPairs, pairDelayMs)) return null;
  const pausedAfterFinal = text.includes('LIVE_DURABILITY_AFTER_FINAL=pause');
  if (pausedAfterFinal && provider !== 'codex') return null;
  const childMode = childControl(text);
  if (childMode === null) return null;
  return { honorCancel: pausedAfterFinal || text.includes('LIVE_DURABILITY_CANCEL=honor'), pausedBeforeTerminal: text.includes('LIVE_DURABILITY_TERMINAL=pause'), pausedAfterFinal, cancelled: false, longToolPairs, pairDelayMs, childMode };
}

function validHistoryControl(longToolPairs, pairDelayMs) {
  return Number.isInteger(longToolPairs) && longToolPairs <= 5000 && Number.isInteger(pairDelayMs) && pairDelayMs <= 50 && longToolPairs * pairDelayMs <= 120_000;
}

function childControl(text) {
  if (!text.includes('LIVE_DURABILITY_CHILD=')) return undefined;
  if (provider !== 'codex') return null;
  return /LIVE_DURABILITY_CHILD=(completed|paused)/.exec(text)?.[1] ?? null;
}

function handlePrompt(request) {
      const text = JSON.stringify(request.params?.prompt ?? request.params?.input ?? []);
      const runId = /LIVE_DURABILITY_RUN=([a-f0-9-]{36})/.exec(text)?.[1];
      if (!runId) {
        seedTurn(request);
        return;
      }
      NodeFS.appendFileSync(NodePath.join(controlDir, `${runId}.audit.ndjson`), JSON.stringify({ runId, provider, method: request.method, at: new Date().toISOString() }) + '\n');
      const key = provider === 'devin' ? request.params.sessionId : request.params.threadId;
      const control = fixtureControl(text);
      if (!control) {
        send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid owned long-turn fixture control' } });
        return;
      }
      activeTurns.set(key, control);
      void turn(request, runId, reply, notify, control).catch(() => process.exitCode = 1).finally(() => { if (activeTurns.get(key) === control) activeTurns.delete(key); });
}

async function turn(request, runId, reply, notify, control) {
  const prefix = `LIVE_DURABILITY ${runId} PREFIX`;
  const tail = `LIVE_DURABILITY ${runId} AFTER_TOOL`;
  const final = `LIVE_DURABILITY ${runId} COMPLETE`;
  const sessionId = request.params.sessionId;
  const threadId = request.params.threadId;
  const turnId = NodeCrypto.randomUUID();
  const base = { threadId, turnId };
  const update = (body) => notify('session/update', { sessionId, update: body });
  const stamp = (phase, metadata = {}) => NodeFS.writeFileSync(NodePath.join(controlDir, `${runId}.${phase}.json`), JSON.stringify({ runId, provider, phase, at: new Date().toISOString(), ...metadata }));
  const cancelled = () => {
    if (!control.cancelled) return false;
    if (provider === 'devin') reply(request.id, { stopReason: 'cancelled' });
    else notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'interrupted', error: null } });
    stamp('cancelled'); stamp('terminal');
    return true;
  };
  stamp('invocation');
  const prefixToolId = `${runId}-prefix-tool`;
  if (provider === 'codex') {
    reply(request.id, { turn: { id: turnId } });
    notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } });
    notify('item/started', { ...base, item: { id: prefixToolId, type: 'commandExecution', command: 'fixture prefix observation', cwd: '.', status: 'inProgress' } });
    notify('item/completed', { ...base, item: { id: prefixToolId, type: 'commandExecution', command: 'fixture prefix observation', cwd: '.', status: 'completed', aggregatedOutput: 'Owned prefix result', exitCode: 0, durationMs: 1 } });
    codexMessage(notify, base, `${runId}-prefix`, prefix, 'commentary');
  } else {
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `LIVE_DURABILITY ${runId} INITIAL_THOUGHT\n` } });
    update({ sessionUpdate: 'tool_call', toolCallId: prefixToolId, title: 'Read File', kind: 'read', status: 'in_progress', rawInput: { path: 'prefix-fixture.txt', description: 'Owned prefix tool' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: prefixToolId, status: 'completed', rawOutput: { content: 'Owned prefix result' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: prefix + '\n' } });
  }
  stamp('prefix');
  const deadline = Date.now() + 180_000;
  const channel = { request, runId, control, cancelled, deadline, reply, notify, threadId, turnId, stamp, update, base };
  if (!await waitRelease(channel)) return;
  if (!await optionalChild(channel)) { cancelled(); return; }
  if (!await emitHistory(channel)) return;
  const toolId = `${runId}-tool`;
  if (provider === 'devin') update({ sessionUpdate: 'tool_call', toolCallId: toolId, title: 'Read File', kind: 'read', status: 'in_progress', rawInput: { path: 'fixture.txt', description: 'Live durability fixture tool' } });
  else notify('item/started', { ...base, item: { id: toolId, type: 'commandExecution', command: 'fixture durability observation', cwd: '.', status: 'inProgress' } });
  stamp('tool');
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (cancelled()) return;
  if (provider === 'devin') {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: tail + '\n' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: toolId, status: 'completed', rawOutput: { content: 'Owned fixture result' } });
  } else {
    codexMessage(notify, base, `${runId}-tail`, tail, 'commentary');
    notify('item/completed', { ...base, item: { id: toolId, type: 'commandExecution', command: 'fixture durability observation', cwd: '.', status: 'completed', aggregatedOutput: 'Owned fixture result', exitCode: 0, durationMs: 400 } });
  }
  stamp('after-tool');
  if (!await waitFinish(channel, control.pausedBeforeTerminal, 'finish')) return;
  await emitFinal(channel, final);
}

async function emitFinal(channel, final) {
  const { request, runId, reply, notify, control, threadId, turnId, stamp, update, base } = channel;
  if (provider === 'devin') {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: final } });
    reply(request.id, { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
  } else {
    const finalItemId = `${runId}-final`;
    codexMessage(notify, base, finalItemId, final, 'final_answer');
    stamp('after-final', { turnId, itemId: finalItemId });
    if (!await waitFinish(channel, control.pausedAfterFinal, 'finish-final')) return;
    notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'completed', error: null } });
  }
  stamp('terminal');
}

async function optionalChild(channel) {
  if (!channel.control.childMode) return true;
  return emitControlledCodexChild(channel, { activeTurns, nativeChildren, controlDir });
}

async function waitRelease({ runId, cancelled, deadline, reply, request, notify, threadId, turnId, stamp }) {
  while (!NodeFS.existsSync(NodePath.join(controlDir, `${runId}.release`))) {
    if (cancelled()) return false;
    if (Date.now() > deadline) {
      if (provider === 'devin') reply(request.id, { stopReason: 'cancelled' });
      else notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'failed', error: { message: 'Owned fixture gate expired' } } });
      stamp('expired');
      stamp('terminal');
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

async function emitHistory({ runId, control, cancelled, stamp, update, notify, base }) {
  const historyBeganAt = Date.now();
  for (let index = 0; index < control.longToolPairs; index++) {
    if (cancelled()) return false;
    const id = `${runId}-history-${index}`;
    if (provider === 'devin') {
      update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Read File', kind: 'read', status: 'in_progress', rawInput: { path: `history-${index}.txt`, description: 'Owned long-turn marker' } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: { content: 'Owned completed result' } });
    } else {
      notify('item/started', { ...base, item: { id, type: 'commandExecution', command: `fixture history marker ${index}`, cwd: '.', status: 'inProgress' } });
      notify('item/completed', { ...base, item: { id, type: 'commandExecution', command: `fixture history marker ${index}`, cwd: '.', status: 'completed', aggregatedOutput: 'Owned completed result', exitCode: 0, durationMs: control.pairDelayMs } });
    }
    if ((index + 1) % 100 === 0) stamp('long-history-progress', { completedPairs: index + 1, requestedPairs: control.longToolPairs });
    if (control.pairDelayMs) await new Promise((resolve) => setTimeout(resolve, control.pairDelayMs));
  }
  if (control.longToolPairs) stamp('long-history', { completedPairs: control.longToolPairs,
    elapsedMs: Date.now() - historyBeganAt, pairDelayMs: control.pairDelayMs, firstToolId: `${runId}-history-0`,
    lastToolId: `${runId}-history-${control.longToolPairs - 1}` });
  return true;
}

async function waitFinish({ control, runId, cancelled, deadline, stamp }, paused, gate) {
  while (paused && !NodeFS.existsSync(NodePath.join(controlDir, `${runId}.${gate}`))) {
    if (cancelled()) return false;
    if (Date.now() > deadline) {
      control.cancelled = true; cancelled(); stamp('expired'); return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

function codexMessage(notify, base, id, text, phase) {
  notify('item/started', { ...base, item: { id, type: 'agentMessage', text: '', phase } });
  notify('item/agentMessage/delta', { ...base, itemId: id, delta: text });
  notify('item/completed', { ...base, item: { id, type: 'agentMessage', text, phase, memoryCitation: null } });
}
