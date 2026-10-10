/** Phased public-provider-to-renderer proof; receives an already-owned Electron or web page. */
import * as NodeFS from 'node:fs';
import * as NodePath from 'node:path';
import * as NodeCrypto from 'node:crypto';
import * as NodeChildProcess from 'node:child_process';
import * as NodeURL from 'node:url';
import { canonicalFrames, compareEventIdentities, frameSummary, semanticDescriptor } from './proof-model.mjs';
import { validateElectronRuntime } from './runtime-identity.mjs';
import { requireSaveOutcome, requireHealthyPrefix } from './outcomes.mjs';
import { classifyCapacityEvidence } from './capacity-evidence.mjs';

const MODULE_DIRECTORY = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const AREA = NodePath.join('.dev', 'verification', 'live-durability');
const MARKER = 'Live durability proof ';
const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeFailure = (error) => ({ failed: true, name: error?.name ?? 'Error', message: String(error?.message ?? error).replace(/token=[^&\s]+/g, 'token=[redacted]').slice(0, 500) });

/** Writes only this helper's owned provider wrappers. No runtime/settings/database mutations. */
export function setup({ repoRoot, executable = 'node' }) {
  const root = NodePath.resolve(repoRoot);
  const directory = NodePath.join(root, AREA);
  NodeFS.mkdirSync(directory, { recursive: true });
  if (NodeFS.lstatSync(directory).isSymbolicLink()) throw new Error('Linked evidence directory is unsupported');
  const fixture = NodePath.join(MODULE_DIRECTORY, 'provider-fixture.mjs');
  for (const value of [executable, fixture, directory]) if (/["%\r\n\0]/.test(value)) throw new Error('Unsafe wrapper path');
  const wrappers = {};
  for (const provider of ['devin', 'codex']) {
    const wrapper = NodePath.join(directory, `${provider}-fixture.cmd`);
    NodeFS.writeFileSync(wrapper, `@echo off\r\n"${executable}" "${fixture}" ${provider} "${directory}" %*\r\n`);
    wrappers[provider] = wrapper;
  }
  return { directory, wrappers, fixtureDriven: true };
}

/** Connects to owned Electron by default; explicit web URLs must match this worktree's private port contract. */
export async function connect({ page, repoRoot, dbPath, runtimeIdentity, serverUrl, provider = 'devin', bunExecutable = 'bun', label = 'proof' }) {
  const root = NodePath.resolve(repoRoot);
  const database = NodePath.resolve(dbPath);
  requireConnectionTarget({ provider, label, root, database });
  const client = serverUrl === undefined ? 'electron' : 'web';
  if (client === 'web') runtimeIdentity = await validateWebConnection({ root, database, page, serverUrl });
  const { openVerificationSocketUrl } = await import(NodeURL.pathToFileURL(NodePath.join(root, '.agents', 'skills', 'verify-mcode', 'scripts', 'runtime.mjs')).href);
  const privateServerUrl = serverUrl ?? await page.evaluate(() => window.desktopBridge.getServerUrl().then(({ url }) => url));
  if (client === 'electron') runtimeIdentity = validateElectronRuntime({ repoRoot: root, dbPath: database,
    pageUrl: page.url(), serverUrl: privateServerUrl, runtimeIdentity });
  const id = NodeCrypto.randomUUID();
  const run = { page, repoRoot: root, dbPath: database, client, runtimeIdentity, privateServerUrl: client === 'web' ? privateServerUrl : undefined, provider, bunExecutable, label, id,
    directory: NodePath.join(root, AREA), triggerName: 'live_durability_' + id.replaceAll('-', ''), pushes: [], thread: null,
    title: MARKER + id, priorSettings: null, configured: false, fault: null, lockChild: null,
    receipt: { runId: id, client, provider, label, runtimeIdentity, fixtureDriven: true, observations: [], cleanup: {} } };
  run.socket = await openVerificationSocketUrl(root, privateServerUrl, (message) => {
    if (run.thread && JSON.stringify(message).includes(run.thread.id)) run.pushes.push(message);
  });
  return run;
}

function requireConnectionTarget({ provider, label, root, database }) {
  if (!['devin', 'codex'].includes(provider)) throw new Error('Unsupported fixture provider');
  if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error('Invalid evidence label');
  if (!database.startsWith(NodePath.join(root, '.dev') + NodePath.sep) || !NodeFS.existsSync(database)) throw new Error('Pass this owned runtime database');
}

async function validateWebConnection({ root, database, page, serverUrl }) {
  const { readPortsFile } = await import(NodeURL.pathToFileURL(NodePath.join(root, 'scripts', 'agent', 'runtime-contract.mjs')).href);
  const ports = readPortsFile(root);
  if (!ports) throw new Error('This worktree has no runtime port contract');
  let endpoint;
  let app;
  try { endpoint = new URL(serverUrl); app = new URL(page.url()); } catch { throw new Error('Pass the owned web page and a valid private WebSocket URL'); }
  requireWebEndpoint(endpoint, ports);
  if (endpoint.searchParams.get('instanceToken') !== ports.instanceToken
    || endpoint.searchParams.get('worktree') !== ports.worktreeIdentity
    || app.origin !== new URL(ports.appUrl).origin
    || database.toLowerCase() !== NodePath.join(root, '.dev', 'db', 'app.sqlite').toLowerCase()) {
    throw new Error('Explicit web connection does not match this worktree runtime/page/database contract');
  }
  return { client: 'web', dbPath: database, worktreeIdentity: root,
    instanceFingerprint: NodeCrypto.createHash('sha256').update(ports.instanceToken).digest('hex') };
}

function requireWebEndpoint(endpoint, ports) {
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== ports.serverPort
    || endpoint.pathname !== '/' || endpoint.username || endpoint.password
    || endpoint.searchParams.get('token') !== ports.seedLogin.token) throw new Error('Explicit web endpoint does not match this worktree runtime');
}

/** Changes only the owned Electron-local provider CLI and enablement, retaining restoration state. */
export async function configure(run) {
  const paths = setup({ repoRoot: run.repoRoot, executable: run.bunExecutable });
  const settings = await run.socket.rpc('settings.get', {});
  run.priorSettings = { cli: settings.provider.cli[run.provider], enabled: settings.provider.enabled[run.provider] };
  NodeFS.writeFileSync(NodePath.join(run.directory, `${run.id}.prior-settings.json`), JSON.stringify({ runId: run.id, provider: run.provider, priorSettings: run.priorSettings }, null, 2) + '\n');
  await run.socket.rpc('settings.update', { provider: { cli: { [run.provider]: paths.wrappers[run.provider] }, enabled: { [run.provider]: true } } });
  run.configured = true;
  return { provider: run.provider, configured: true, wrapper: paths.wrappers[run.provider] };
}

/** Seeds an owned thread through public dispatch so its provider is correct before Composer locks it. */
export async function createThread(run) {
  const fixturePath = NodePath.join(run.repoRoot, '.dev', 'fixture-repo');
  const workspaces = await run.socket.rpc('workspace.list', {});
  let workspace = workspaces.find((item) => NodePath.resolve(item.path).toLowerCase() === fixturePath.toLowerCase());
  if (!workspace) {
    const created = await run.socket.rpc('workspace.create', { name: 'Live durability fixture', path: fixturePath });
    if (!created.ok) throw new Error(`Workspace registration failed (${created.error.code}): ${created.error.message}`);
    workspace = created.workspace;
    run.createdWorkspace = workspace.id;
  }
  run.thread = await run.socket.rpc('agent.createAndSend', {
    workspaceId: workspace.id, content: `Owned durability fixture seed ${run.id}`, provider: run.provider,
    model: 'fixture-model', mode: 'direct', branch: 'main', permissionMode: 'full',
    ...(run.provider === 'devin' ? { devinMode: 'bypass' } : {}),
  });
  if (!run.thread?.id) throw new Error('Owned thread creation did not return an ID');
  if (run.thread.provider !== run.provider) throw new Error('Seed thread provider differs from selected fixture');
  await run.socket.rpc('thread.updateTitle', { threadId: run.thread.id, title: run.title });
  run.thread.title = run.title;
  const deadline = Date.now() + 8000;
  while ((await run.socket.rpc('agent.listRunning', {})).some((row) => row.threadId === run.thread.id && row.phase !== 'completed')) {
    if (Date.now() >= deadline) throw new Error('Fixture seed did not finish before measured invocation');
    await timeout(100);
  }
  run.receipt.seed = { provider: run.thread.provider, content: `Owned durability fixture seed ${run.id}`, measured: false };
  run.receipt.threadId = run.thread.id;
  await run.socket.rpc('push.subscribeThread', { threadId: run.thread.id });
  writeReceipt(run);
  return { threadId: run.thread.id, title: run.title, workspaceId: workspace.id };
}

/** Opens the created conversation using rendered navigation controls. */
export async function openThread(run) {
  const row = run.page.locator(`[data-testid="thread-item"][data-thread-id="${run.thread.id}"]`);
  for (let attempt = 0; attempt < 2 && !(await row.count()); attempt++) {
    await run.page.getByText('fixture-repo', { exact: true }).first().click({ timeout: 5000 });
    await timeout(300);
  }
  await row.getByText(run.title, { exact: true }).click({ timeout: 5000 });
  const observedId = await row.getAttribute('data-thread-id');
  run.receipt.navigation = { observedThreadId: observedId, selectedTitle: run.title };
  return { opened: true, threadId: observedId };
}

/** Sends through agent.send, waits for real native fixture prefix, then returns before tool traffic. */
export async function start(run, options = {}) {
  if (!run.thread || !run.configured) throw new Error('Configure and create the owned thread first');
  beginInvocation(run, 'public-api');
  await run.socket.sendWithoutResponse('agent.send', { threadId: run.thread.id, content: invocationPrompt(run, options), provider: run.provider, model: 'fixture-model', permissionMode: 'full', ...(run.provider === 'devin' ? { devinMode: 'bypass' } : {}) });
  const prefix = await waitFile(run, 'prefix', 15_000);
  await recordExecution(run);
  writeReceipt(run);
  return { prefixEmitted: true, threadId: run.thread.id, runId: run.id, nativePrefix: prefix };
}

/** Uses the rendered Composer and requires the exact prompt and native prefix before allowing a fault. */
export async function startComposer(run, options = {}) {
  if (!run.thread || !run.configured) throw new Error('Configure, seed, and open the owned thread first');
  if (run.receipt.navigation?.observedThreadId !== run.thread.id) throw new Error('Owned navigation was not observed');
  const prompt = invocationPrompt(run, options);
  await run.page.getByRole('textbox', { name: 'Message Mcode', exact: true }).fill(prompt, { timeout: 5000 });
  beginInvocation(run, 'composer');
  await run.page.getByRole('button', { name: 'Send message', exact: true }).click({ timeout: 5000 });
  await waitFile(run, 'prefix', 15_000);
  const prefixPart = { false: 'PREFIX', true: 'IDENTICAL_LEGACY_TEXT' }[run.receipt.fixtureControl.legacyIdenticalText];
  const prefixMarker = `LIVE_DURABILITY ${run.id} ${prefixPart}`;
  const deadline = Date.now() + 8000;
  while (true) {
    const body = await run.page.locator('body').innerText({ timeout: Math.max(1, deadline - Date.now()) });
    if (body.includes(prompt) && body.includes(prefixMarker)) break;
    if (Date.now() >= deadline) throw new Error('Composer prompt/native prefix did not both render; do not arm a UI proof fault');
    await timeout(100);
  }
  run.receipt.uiPrecondition = { at: new Date().toISOString(), promptRendered: true, prefixRendered: true, prefixMarker };
  await recordExecution(run);
  writeReceipt(run);
  return { prefixEmitted: true, threadId: run.thread.id, runId: run.id };
}

/** Installs a narrow recovery-write failure, or holds this isolated database's writer lock. */
export async function armFault(run, kind = 'fail') {
  await waitFile(run, 'prefix', 1000);
  requireFaultPrecondition(run, kind);
  if (kind === 'fail' || kind === 'fail-terminal') {
    if (kind === 'fail-terminal' && !run.receipt.durablePrefix) throw new Error('Certify the saved prefix before terminal rejection');
    const result = dbOperation(run, kind);
    run.fault = kind;
    run.receipt.faultKind = kind;
    writeReceipt(run);
    return result;
  }
  const releaseFile = NodePath.join(run.directory, `${run.id}.unlock`);
  const child = NodeChildProcess.spawn(run.bunExecutable, [NodePath.join(MODULE_DIRECTORY, 'db-fault.mjs'), 'hold', run.repoRoot, run.dbPath, run.thread.id, run.triggerName, releaseFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  run.lockChild = child;
  const held = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Database lock holder did not arm')), 5000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Database lock holder exited (${code})`)); });
    child.stdout.once('data', (chunk) => { clearTimeout(timer); resolve(JSON.parse(chunk.toString())); });
  });
  run.fault = 'hold';
  run.receipt.lock = held;
  writeReceipt(run);
  return held;
}

function requireFaultPrecondition(run, kind) {
  if (run.receipt.invocation?.path === 'composer' && !run.receipt.uiPrecondition) throw new Error('Required UI precondition is absent');
  if (!['fail', 'fail-terminal', 'hold'].includes(kind)) throw new Error('Fault must be fail, fail-terminal, or hold');
  if (run.fault) throw new Error('Fault already armed');
}

/** Releases the native provider gate, allowing tool, trailing text, and actual terminal messages. */
export function releaseProvider(run) {
  if (run.receipt.providerReleasedAt) throw new Error('Measured provider gate was already released');
  NodeFS.writeFileSync(NodePath.join(run.directory, `${run.id}.release`), 'release\n');
  run.receipt.providerReleasedAt = new Date().toISOString();
  writeReceipt(run);
  return { released: true, fault: run.fault };
}

/** Completes an explicitly paused native fixture without another provider invocation. */
export function finishProvider(run) {
  if (!run.receipt.fixtureControl?.pauseBeforeTerminal) throw new Error('Fixture terminal was not paused');
  const file = NodePath.join(run.directory, `${run.id}.finish`);
  if (NodeFS.existsSync(file)) throw new Error('Measured terminal gate was already released');
  NodeFS.writeFileSync(file, 'finish\n');
  return { terminalReleased: true };
}

/** Releases a Codex turn after its final assistant item completed. Paused final turns honor Stop. */
export function finishFinalProvider(run) {
  if (run.provider !== 'codex' || !run.receipt.fixtureControl?.pauseAfterFinal || !readStamp(run, 'after-final')) throw new Error('No paused native Codex final item was observed');
  if (readStamp(run, 'terminal')) throw new Error('Native Codex turn already ended');
  const file = NodePath.join(run.directory, `${run.id}.finish-final`);
  if (NodeFS.existsSync(file)) throw new Error('Measured final terminal gate was already released');
  NodeFS.writeFileSync(file, 'finish\n');
  return { terminalReleased: true };
}

/** Continues the same Codex final item after its first native text delta. */
export function continueFinalProvider(run) {
  if (run.provider !== 'codex' || !run.receipt.fixtureControl?.pauseDuringFinal || !readStamp(run, 'partial-final')) throw new Error('No paused native Codex final delta was observed');
  if (readStamp(run, 'after-final') || readStamp(run, 'terminal')) throw new Error('Native Codex final item already ended');
  const file = NodePath.join(run.directory, `${run.id}.continue-final`);
  if (NodeFS.existsSync(file)) throw new Error('Measured final item gate was already released');
  NodeFS.writeFileSync(file, 'continue\n');
  return { finalItemReleased: true };
}

/** Waits only for a fresh native stage, independently of server acceptance and saving. */
export async function waitNative(run, phase, maxMs = 5000) {
  if (!['prefix', 'tool', 'after-tool', 'partial-final', 'after-final', 'terminal', 'cancelled', 'long-history', 'long-history-progress', 'child-prefix', 'child-completed', 'child-cancelled'].includes(phase) || maxMs > 15_000) throw new Error('Invalid bounded native wait');
  return waitFile(run, phase, maxMs);
}

/** Releases one paused native child without resubmitting a provider command. */
export function finishChild(run) {
  if (run.provider !== 'codex' || run.receipt.fixtureControl?.childMode !== 'paused' || !readStamp(run, 'child-prefix')) throw new Error('No paused native Codex child was observed');
  const file = NodePath.join(run.directory, run.id + '.child-finish');
  if (NodeFS.existsSync(file)) throw new Error('Child terminal gate was already released');
  NodeFS.writeFileSync(file, 'finish\n');
  return { childReleased: true };
}

/** Reads a server-produced child alias and its public transcript, never deriving an alias from a native ID. */
export async function captureChild(run, { expectedOutcome, maxMs = 5000 } = {}) {
  requireChildCapture(run, maxMs);
  const native = await waitFile(run, 'child-prefix', 5000);
  const deadline = Date.now() + maxMs;
  for (;;) {
    const roster = await run.socket.rpc('subagent.roster', { owningParentThreadId: run.thread.id }, Date.now() + 3000);
    const row = await onlyMarkedChild(run, roster);
    if (childOutcomeMatches(row, expectedOutcome)) {
      const transcript = await run.socket.rpc('conversation.tail', { threadId: row.childThreadId, limit: 2 }, Date.now() + 3000);
      const parent = (await run.socket.rpc('agent.listRunning', {})).find(item => item.threadId === run.thread.id);
      const result = { at: new Date().toISOString(), native, row, roster, transcript, parent };
      run.receipt.childCaptures ??= []; run.receipt.childCaptures.push(result); writeReceipt(run);
      return result;
    }
    if (Date.now() >= deadline) throw new Error('Exact public child alias/outcome did not converge');
    await timeout(100);
  }
}

function requireChildCapture(run, maxMs) {
  if (run.provider !== 'codex' || !run.receipt.fixtureControl?.childMode || maxMs > 8000) throw new Error('Choose a bounded controlled Codex child');
}

// The roster no longer exposes native identities, so the fixture's single child is
// bound by its server alias and confirmed through this run's transcript marker.
async function onlyMarkedChild(run, roster) {
  const children = roster.entries.filter(row => row.provider === 'codex' && row.childThreadId);
  if (children.length > 1) throw new Error('Controlled fixture produced multiple server child aliases');
  const row = children[0];
  if (!row) return undefined;
  const tail = await run.socket.rpc('conversation.tail', { threadId: row.childThreadId, limit: 20 }, Date.now() + 3000);
  return JSON.stringify(tail).includes('LIVE_DURABILITY ' + run.id + ' CHILD_PREFIX') ? row : undefined;
}

const CHILD_STATUS_BY_OUTCOME = { Completed: 'done', Interrupted: 'stopped', Cancelled: 'stopped', Errored: 'failed' };

function childOutcomeMatches(row, expected) { return row && (!expected || row.status === CHILD_STATUS_BY_OUTCOME[expected]); }

/** Stops the observed child through its real detail control while the parent and saving lock remain active. */
export async function stopChildUI(run, { detailButtonLabel, detailRegionLabel }) {
  assertHeldLock(run);
  requireChildStop(run, detailButtonLabel, detailRegionLabel);
  const before = await captureChild(run);
  if (!before.row.canStop || before.row.status !== 'running') throw new Error('Observed child is not stoppable');
  await run.page.getByRole('button', { name: detailButtonLabel, exact: true }).click({ timeout: 5000 });
  const detail = run.page.getByRole('region', { name: detailRegionLabel, exact: true });
  if (!(await detail.innerText({ timeout: 5000 })).includes('LIVE_DURABILITY ' + run.id + ' CHILD_PREFIX')) throw new Error('Opened detail does not contain this exact native child marker');
  await detail.getByTestId('subagent-stop-control').click({ timeout: 5000 });
  const cancellation = await waitFile(run, 'child-cancelled', 5000);
  const after = await captureChild(run, { expectedOutcome: 'Interrupted' });
  if (before.row.id !== after.row.id || after.parent?.phase !== 'running' || readStamp(run, 'child-expired')) throw new Error('Child Stop changed alias, ended the parent, or followed an expired gate');
  const result = { at: new Date().toISOString(), nativeCancellation: cancellation, childAlias: after.row.id, parentStillRunning: true };
  run.receipt.childStop = result; writeReceipt(run); return result;
}

function requireChildStop(run, button, region) {
  if (run.fault !== 'hold' || run.receipt.fixtureControl?.childMode !== 'paused'
    || !/^Open .+ subagent details$/.test(button) || !/^.+ subagent details$/.test(region)) throw new Error('Pass observed child-detail labels for the held active child');
}

/** Requires a fresh exact retention rejection and native cancellation during a deliberate held-save burst. */
export async function verifyCapacityRejection(run, { logPath, maxMs = 15000 }) {
  assertHeldLock(run);
  requireCapacityControls(run, maxMs);
  const file = ownedLogFile(run, logPath);
  const deadline = Date.now() + maxMs;
  for (;;) {
    assertHeldLock(run);
    const evidence = classifyCapacityEvidence(NodeFS.readFileSync(file, 'utf8').split(/\r?\n/), { threadId: run.thread.id, executionId: run.receipt.executionId, invokedAt: run.receipt.invocation.at });
    run.receipt.capacityEvidence = evidence; writeReceipt(run);
    if (evidence.some(entry => entry.kind === 'provider-publisher-capacity')) throw new Error('Provider publisher saturation is not retained-save capacity proof');
    if (evidence.some(entry => entry.kind === 'retained-save-capacity' && entry.executionId === run.receipt.executionId)) {
      const cancellation = await waitFile(run, 'cancelled', 5000);
      const runtime = await waitRuntime(run, { terminal: true, maxMs: 5000 });
      if (readStamp(run, 'expired') || runtime.phase === 'completed') throw new Error('Capacity attempt expired or falsely completed');
      const cut = await captureRecovery(run);
      const result = { at: new Date().toISOString(), typedReason: 'retention-exhausted', cancellation, runtime,
        acceptedThrough: cut.acceptedThrough, savedThrough: cut.savedThrough, retainedCount: cut.retained.length,
        providerInvocationCount: readAudit(run).length };
      run.receipt.capacityRejection = result; writeReceipt(run); return result;
    }
    if (Date.now() >= deadline) throw new Error('Exact retained-save rejection was not observed within the bound');
    await timeout(100);
  }
}

function requireCapacityControls(run, maxMs) {
  const control = run.receipt.fixtureControl;
  if (run.fault !== 'hold' || !control?.honorCancel || control.longToolPairs !== 5000 || control.pairDelayMs !== 1 || maxMs > 15000) throw new Error('Capacity proof requires held saving, honored cancellation, and the bounded 5000/1ms native burst');
}

function ownedLogFile(run, logPath) {
  const file = NodePath.resolve(logPath);
  if (!file.startsWith(NodePath.join(run.repoRoot, '.dev') + NodePath.sep) || NodeFS.lstatSync(file).isSymbolicLink()) throw new Error('Pass the exact owned runtime log');
  return file;
}

/** Gives a peer an independent UUID/socket while retaining one owner for provider settings. */
export async function connectPeer(owner, label = 'after-peer') {
  if (!owner.configured) throw new Error('Configure the settings owner before preparing peers');
  const peer = await connect({ page: owner.page, repoRoot: owner.repoRoot, dbPath: owner.dbPath, serverUrl: owner.privateServerUrl,
    runtimeIdentity: owner.runtimeIdentity, provider: owner.provider, bunExecutable: owner.bunExecutable, label });
  peer.configured = true;
  peer.inheritedConfiguration = true;
  peer.receipt.configurationOwner = owner.id;
  return peer;
}

/** Collects rendered evidence and public runtime state without interpreting a save acknowledgement as UI proof. */
export async function observe(run, { phase = 'held', waitForTerminal = false } = {}) {
  if (!/^[a-z0-9-]{1,40}$/.test(phase)) throw new Error('Invalid evidence phase');
  if (waitForTerminal) await waitFile(run, 'terminal', 5000);
  assertHeldLock(run);
  await timeout(700);
  const body = await run.page.locator('body').innerText({ timeout: 5000 });
  const ownText = ['PREFIX', 'AFTER_TOOL', 'COMPLETE'].map((part) => {
    const count = body.split(`LIVE_DURABILITY ${run.id} ${part}`).length - 1;
    return { part, rendered: count > 0, occurrences: count };
  });
  const running = await run.socket.rpc('agent.listRunning', {}, Date.now() + 5000).then((rows) => rows.filter((row) => row.threadId === run.thread.id), safeFailure);
  const persisted = dbOperation(run, 'inspect');
  const screenshot = NodePath.join(run.directory, `${run.label}-${run.provider}-${run.id}-${phase}.png`);
  await run.page.screenshot({ path: screenshot });
  const native = Object.fromEntries(['invocation', 'prefix', 'tool', 'after-tool', 'partial-final', 'after-final', 'terminal', 'cancelled', 'expired', 'long-history-progress', 'long-history'].map((part) => [part, readStamp(run, part)]));
  const phaseProtocol = run.pushes.some((push) => push.channel === 'agent.canonical' && push.data?.phase);
  const frames = phaseProtocol ? canonicalFrames(run.pushes, run.thread.id).map(frameSummary) : [];
  const stopButtonCount = await run.page.getByRole('button', { name: 'Stop agent', exact: true }).count();
  const observation = { phase, at: new Date().toISOString(), nativePrefix: !!native.prefix, nativeTool: !!native.tool, nativeTerminal: !!native.terminal && !native.expired, native, ownText, running, stopButtonCount, savingLabelRendered: /Saving response|Retrying save/i.test(body), failedSaveLabelRendered: /save failed|saving failed|unable to save|could not (?:be )?save(?:d)?/i.test(body), lossLabelRendered: body.includes('Mcode restarted. Progress that had not been saved was lost.'), persisted, screenshot, receivedPushCount: run.pushes.length, protocol: phaseProtocol ? 'phase' : 'unverified', frames, providerInvocationAudit: readAudit(run) };
  run.receipt.observations.push(observation);
  writeReceipt(run);
  return observation;
}

/** Removes the owned fault and permits pending saves to drain. */
export async function releaseFault(run) {
  const previousFault = run.fault;
  if (run.fault === 'fail' || run.fault === 'fail-terminal') dbOperation(run, 'release');
  if (run.fault === 'hold') {
    NodeFS.writeFileSync(NodePath.join(run.directory, `${run.id}.unlock`), 'release\n');
    if (run.lockChild?.exitCode === null) await Promise.race([new Promise((resolve) => run.lockChild.once('exit', resolve)), timeout(5000)]);
    if (run.lockChild?.exitCode === null) throw new Error('Owned SQLite lock holder did not release');
  }
  run.fault = null;
  if (previousFault) {
    run.receipt.faultReleasedAt = new Date().toISOString();
    run.receipt.faultReleaseCount = (run.receipt.faultReleaseCount ?? 0) + 1;
    writeReceipt(run);
  }
  return { faultReleased: true, effectiveRelease: previousFault !== null };
}

/** Requests an authoritative same-epoch cut through the public subscription/recovery boundary. */
export async function captureRecovery(run, { cursor, revision } = {}) {
  assertHeldLock(run);
  const frames = canonicalFrames(run.pushes, run.thread.id);
  const head = frames.at(-1);
  if (!cursor && !head) throw new Error('No phase-protocol cursor was observed');
  const position = cursor ?? progressCursor(head);
  const saved = [...frames].reverse().find((frame) => frame.phase === 'saved' || frame.phase === 'recovery');
  const durableRevision = revision ?? recoveryRevision(saved);
  const result = await run.socket.rpc('push.setThreadSubscriptions', { threadIds: [run.thread.id],
    progressCursors: { [run.thread.id]: position }, revisions: { [run.thread.id]: durableRevision } }, Date.now() + 5000);
  const recovery = result.canonicalRecoveries?.find((cut) => cut.threadId === run.thread.id);
  if (recovery?.phase !== 'recovery') throw new Error('Public recovery did not return the phase protocol');
  run.receipt.recoveries ??= [];
  run.receipt.recoveries.push({ at: new Date().toISOString(), requestCursor: position, cut: frameSummary(recovery) });
  writeReceipt(run);
  return recovery;
}

function progressCursor(head) {
  return { epoch: head.epoch, sequence: head.phase === 'recovery' ? head.acceptedThrough : head.through };
}

function recoveryRevision(saved) {
  if (saved?.phase === 'saved') return saved.revision;
  if (saved?.phase === 'recovery') return frameSummary(saved).durableRevision;
  return { conversationRevision: 0, rosterRevision: 0 };
}

/** Bounded public-state wait; callers choose execution and storage expectations separately. */
export async function waitRuntime(run, { terminal = false, savingModes, maxMs = 8000 } = {}) {
  if (maxMs > 15_000) throw new Error('Runtime wait must stay bounded');
  const deadline = Date.now() + maxMs;
  for (;;) {
    const snapshot = (await run.socket.rpc('agent.listRunning', {}, Date.now() + 3000)).find((row) => row.threadId === run.thread.id);
    if (snapshot && terminalMatches(snapshot, terminal) && savingMatches(snapshot, savingModes)) return snapshot;
    if (Date.now() >= deadline) throw new Error('Public runtime did not reach the requested execution/storage states');
    await timeout(100);
  }
}

function terminalMatches(snapshot, terminal) {
  return !terminal || ['completed', 'interrupted', 'errored', 'cancelled', 'idle'].includes(snapshot.phase);
}

function savingMatches(snapshot, savingModes) {
  const modes = snapshot.savingStatuses?.map(status => status.mode) ?? [];
  if (snapshot.savingStatus) modes.push(snapshot.savingStatus);
  return !savingModes || modes.some(mode => savingModes.includes(mode));
}

/** Exercises the actual Stop button while a paused native turn and its saving tail remain live. */
export async function stopComposer(run) {
  assertHeldLock(run);
  const control = run.receipt.fixtureControl;
  if (!control?.honorCancel || ![control.pauseBeforeTerminal, control.pauseDuringFinal, control.pauseAfterFinal].includes(true)) throw new Error('Stop proof requires an honoring, paused fixture');
  const phase = control.pauseDuringFinal ? 'partial-final' : control.pauseAfterFinal ? 'after-final' : 'after-tool';
  await waitFile(run, phase, 5000);
  const startedAt = Date.now();
  await run.page.getByRole('button', { name: 'Stop agent', exact: true }).click({ timeout: 5000 });
  const snapshot = await waitRuntime(run, { terminal: true });
  const nativeCancelled = await waitFile(run, 'cancelled', 5000);
  run.receipt.stop = { at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, snapshot, nativeCancelled };
  writeReceipt(run);
  return run.receipt.stop;
}

/** Compares every measured accepted identity/content to disk, including exact count after drain. */
export async function compareDurability(run) {
  const recovery = await captureRecovery(run);
  const expected = acceptedDescriptors(run);
  const stored = dbOperation(run, 'inspect').descriptors.filter((event) => event.executionId === run.receipt.executionId);
  const comparison = compareEventIdentities(expected, stored);
  const result = { at: new Date().toISOString(), ...comparison,
    allSaved: recovery.acceptedThrough === recovery.savedThrough && recovery.retained.length === 0,
    acceptedThrough: recovery.acceptedThrough, savedThrough: recovery.savedThrough,
    providerInvocationCount: readAudit(run).length, effectiveFaultReleaseCount: run.receipt.faultReleaseCount ?? 0 };
  run.receipt.durabilityComparisons ??= [];
  run.receipt.durabilityComparisons.push(result);
  writeReceipt(run);
  return result;
}

/** Captures a terminal failed save and its explicit classification before removing the owned fault. */
export async function prepareSaveRetry(run, { expectedOutcome = 'completed', expectedFailureKind = 'permanent' } = {}) {
  requireRetryFault(run, expectedOutcome, expectedFailureKind);
  const nativeTerminal = await waitFile(run, 'terminal', 5000);
  if (nativeTerminal.expired || readStamp(run, 'expired')) throw new Error('Expired fixture cannot prove successful provider completion');
  const snapshot = await waitRuntime(run, { terminal: true, savingModes: ['saving-failed'] });
  requireSaveOutcome({ expectedOutcome, snapshot, terminal: nativeTerminal, cancelled: readStamp(run, 'cancelled') });
  const status = failedSaveStatus(run, snapshot, expectedFailureKind);
  const cut = await captureRecovery(run);
  const accepted = acceptedDescriptors(run);
  const audit = readAudit(run);
  const observation = await observe(run, { phase: 'permanent-before-retry' });
  requireRetryCut({ cut, accepted, audit, observation, expectedOutcome });
  run.receipt.saveRetryBefore = { at: new Date().toISOString(), executionId: run.receipt.executionId,
    runtimePhase: snapshot.phase, expectedOutcome, expectedFailureKind, epoch: cut.epoch, acceptedThrough: cut.acceptedThrough, savedThrough: cut.savedThrough,
    accepted, retained: cut.retained.map(semanticDescriptor), providerInvocationAudit: audit, publicFailure: status.failure };
  writeReceipt(run);
  return { captured: true, acceptedCount: accepted.length, retainedCount: cut.retained.length, providerInvocationCount: audit.length };
}

function requireRetryFault(run, expectedOutcome, expectedFailureKind) {
  if (!['fail', 'fail-terminal', 'hold'].includes(run.fault) || !run.receipt.executionId) throw new Error('Save retry requires this run\'s armed fault');
  requireFaultFailureKind(run.fault, expectedFailureKind);
  if (expectedOutcome === 'completed' && run.fault === 'fail') throw new Error('Completed save-retry proof requires fail-terminal or hold, not an active tool rejection');
}

function requireFaultFailureKind(fault, expectedFailureKind) {
  const requiredKind = fault === 'hold' ? 'transient' : 'permanent';
  if (expectedFailureKind !== requiredKind) throw new Error('Expected failure kind must match held BUSY or permanent ABORT injection');
}

function failedSaveStatus(run, snapshot, expectedFailureKind) {
  const pushed = [...run.pushes].reverse().find(message => message.channel === 'turn.savingStatus'
    && message.data?.executionId === run.receipt.executionId && message.data.mode === 'saving-failed')?.data;
  const status = snapshot.savingStatuses?.find(item => item.executionId === run.receipt.executionId && item.mode === 'saving-failed') ?? pushed;
  if (status?.failure?.kind !== expectedFailureKind) throw new Error('Public failed save classification differs from this journey');
  return status;
}

function requireRetryCut({ cut, accepted, audit, observation, expectedOutcome }) {
  if (cut.retained.length === 0 || cut.acceptedThrough <= cut.savedThrough) throw new Error('Failed saving has no accepted unsaved suffix');
  if (audit.length !== 1 || accepted.length === 0) throw new Error('Retry proof requires one measured invocation and its accepted identities');
  if (observation.failedSaveLabelRendered) throw new Error('Save failure diagnostics appeared in the chat');
  if (expectedOutcome === 'completed' && !observation.ownText.find(item => item.part === 'COMPLETE')?.rendered) {
    throw new Error('Completed save-retry proof requires the completed response to render before retry');
  }
}

/** Retries only the accepted save queue through RPC or thread Overview; never resubmits a provider prompt. */
export async function retrySave(run, { via = 'ui', maxMs = 8000 } = {}) {
  const before = run.receipt.saveRetryBefore;
  requireRetryOptions(run, via, maxMs);
  if (dbOperation(run, 'inspect').triggerPresent) throw new Error('Permanent rejection trigger is still installed');
  const snapshot = await waitRuntime(run, { terminal: true, savingModes: ['saving-failed'] });
  if (snapshot.turnExecutionId !== before.executionId) throw new Error('Execution identity changed before save retry');
  const requestedAt = new Date().toISOString();
  const request = await performSaveRetry(run, via);
  const after = await waitSavedCut(run, maxMs);
  const durability = await compareDurability(run);
  const observation = await observe(run, { phase: `retry-${via}-saved` });
  const runtime = await waitRuntime(run, { terminal: true });
  const acceptedComparison = compareEventIdentities(before.accepted, acceptedDescriptors(run));
  const audit = readAudit(run);
  const overview = run.page.getByRole('button', { name: 'Thread overview', exact: true });
  if (await overview.getAttribute('aria-pressed') !== 'true') await overview.click({ timeout: 5000 });
  await run.page.getByTestId('thread-overview-card').waitFor({ state: 'visible', timeout: 5000 });
  const saveRecoveryActionRemoved = await run.page.getByTestId('turn-save-recovery').count() === 0;
  if (!saveRecoveryActionRemoved) throw new Error('Overview still offers save recovery after its accepted suffix was saved');
  const result = { at: new Date().toISOString(), requestedAt, via, ...request,
    exactDurableIdentities: durability.exact, queueDrained: durability.allSaved,
    acceptedIdentitiesUnchanged: acceptedComparison.exact,
    sameAcceptedWatermark: after.epoch === before.epoch && after.acceptedThrough === before.acceptedThrough,
    sameExecutionIdentity: runtime.turnExecutionId === before.executionId,
    sameRuntimeOutcome: runtime.phase === before.runtimePhase,
    terminalUiSettled: observation.stopButtonCount === 0,
    providerWasNotReinvoked: JSON.stringify(audit) === JSON.stringify(before.providerInvocationAudit),
    originalInvocationCount: before.providerInvocationAudit.length, currentInvocationCount: audit.length,
    failedSavingNoticeRemoved: !observation.failedSaveLabelRendered,
    saveRecoveryActionRemoved,
    completeRenderedOnce: observation.ownText.find(item => item.part === 'COMPLETE')?.occurrences === 1,
    durableCount: durability.storedCount, acceptedCount: before.accepted.length, durability, acceptedComparison };
  run.receipt.saveRetry = result;
  writeReceipt(run);
  return result;
}

function requireRetryOptions(run, via, maxMs) {
  if (!['ui', 'rpc'].includes(via) || !Number.isSafeInteger(maxMs) || maxMs < 1 || maxMs > 15_000) throw new Error('Invalid bounded save retry options');
  if (!run.receipt.saveRetryBefore || run.fault || run.receipt.saveRetry) throw new Error('Capture the failure, release its owned trigger, then retry once');
}

async function performSaveRetry(run, via) {
  if (via === 'rpc') {
    const rpcResult = await run.socket.rpc('agent.retrySave', { threadId: run.thread.id }, Date.now() + 5000);
    if (rpcResult?.retried !== true) throw new Error('Public save retry did not accept the failed queue');
    return { rpcResult };
  } else {
    const overview = run.page.getByRole('button', { name: 'Thread overview', exact: true });
    if (await overview.getAttribute('aria-pressed') !== 'true') await overview.click({ timeout: 5000 });
    const button = run.page.getByTestId('turn-save-recovery').getByRole('button', { name: 'Retry save', exact: true });
    await button.waitFor({ state: 'visible', timeout: 5000 });
    if (await button.count() !== 1) throw new Error('Expected exactly one Overview Retry save button');
    const buttonLabel = await button.innerText({ timeout: 1500 });
    await button.click({ timeout: 5000 });
    return { buttonLabel };
  }
}

async function waitSavedCut(run, maxMs) {
  const deadline = Date.now() + maxMs;
  let after;
  for (;;) {
    after = await captureRecovery(run);
    if (after.acceptedThrough === after.savedThrough && after.retained.length === 0) return after;
    if (Date.now() >= deadline) throw new Error('Public save retry did not drain the accepted suffix within its bound');
    await timeout(100);
  }
}

function acceptedDescriptors(run) {
  // Dispatch saves its start rows before this invocation's live subscription sees them.
  // Use only the separately certified pre-fault prefix, never the comparison's current disk rows.
  const prefix = run.receipt.durablePrefix?.stored.descriptors ?? [];
  const events = [...prefix, ...canonicalFrames(run.pushes, run.thread.id).filter(frame => frame.phase === 'accepted')
    .flatMap(frame => frame.events).map(semanticDescriptor)]
    .filter(item => item.executionId === run.receipt.executionId);
  // A reconnect may replay accepted frames; unchanged event identities remain one measured event.
  const unique = new Map();
  for (const item of events) {
    if (unique.has(item.eventId) && unique.get(item.eventId).semanticHash !== item.semanticHash) throw new Error('Accepted identity changed during retry');
    unique.set(item.eventId, item);
  }
  return [...unique.values()];
}

/** Verifies a long native turn's exact completed tool count, terminal rendering, and durable identities. */
export async function verifyLongTurn(run) {
  const requested = run.receipt.fixtureControl?.longToolPairs ?? 0;
  if (requested < 1000) throw new Error('Long-turn journey requires at least 1000 completed pairs');
  const nativeHistory = await waitFile(run, 'long-history', 15_000);
  await waitFile(run, 'terminal', 5000);
  const snapshot = await waitRuntime(run, { terminal: true });
  const comparison = await compareDurability(run);
  const observation = await observe(run, { phase: 'long-turn-completed' });
  const expectedIds = Array.from({ length: requested }, (_, index) => `${run.id}-history-${index}`).sort();
  const result = { at: new Date().toISOString(), requestedPairs: requested, nativeCompletedPairs: nativeHistory.completedPairs,
    nativeElapsedMs: nativeHistory.elapsedMs, publicPhase: snapshot.phase,
    persistedHistory: observation.persisted.longHistory,
    exactCompletedToolCount: nativeHistory.completedPairs === requested && observation.persisted.longHistory.uniqueTools === requested
      && observation.persisted.longHistory.completedTools === requested,
    exactToolIdentities: observation.persisted.longHistory.identityHash === NodeCrypto.createHash('sha256').update(JSON.stringify(expectedIds)).digest('hex'),
    completeRendered: observation.ownText.find((part) => part.part === 'COMPLETE').rendered,
    terminalSucceeded: snapshot.phase === 'completed' && observation.nativeTerminal && !observation.native.cancelled,
    durableComparison: comparison };
  run.receipt.longTurn = result;
  writeReceipt(run);
  return result;
}

/** Records an unsaved cut before a parent-owned server restart; it does not stop or restart anything. */
export async function prepareRestart(run) {
  if (!run.priorSettings || run.inheritedConfiguration) throw new Error('Restart handoff requires the provider settings owner');
  if (run.fault !== 'hold') throw new Error('Restart loss proof requires a currently held writer');
  const recovery = await captureRecovery(run);
  if (recovery.retained.length === 0 || recovery.acceptedThrough <= recovery.savedThrough) throw new Error('No retained unsaved tail exists to test loss');
  if (readAudit(run).length !== 1) throw new Error('Restart proof requires exactly one measured native invocation');
  const stored = dbOperation(run, 'inspect');
  const state = { version: 1, repoRoot: run.repoRoot, dbPath: run.dbPath, client: run.client, provider: run.provider,
    bunExecutable: run.bunExecutable, label: run.label, runId: run.id, thread: run.thread,
    priorSettings: run.priorSettings, receipt: run.receipt, at: new Date().toISOString(),
    cut: frameSummary(recovery), stored, providerInvocationAudit: readAudit(run) };
  const handoffFile = NodePath.join(run.directory, `${run.id}.handoff.json`);
  NodeFS.writeFileSync(handoffFile, JSON.stringify(state, null, 2) + '\n');
  run.receipt.restartHandoff = { handoffFile, at: state.at, epoch: recovery.epoch, savedThrough: recovery.savedThrough,
    acceptedThrough: recovery.acceptedThrough, pendingCount: recovery.retained.length };
  writeReceipt(run);
  return run.receipt.restartHandoff;
}

/** Disconnects only the proof RPC socket; keep the renderer alive so it retains its old epoch cursor. */
export async function disconnectForRestart(run) {
  await run.socket.close();
  return { proofSocketDisconnected: true, runtimeLifecycleChanged: false, writerLockStillOwned: run.fault === 'hold' };
}

/** Rebinds public proof control after the parent restarts the same owned DB and releases the old lock. */
export async function resumeAfterRestart({ page, repoRoot, handoffFile, runtimeIdentity, serverUrl }) {
  const root = NodePath.resolve(repoRoot);
  const directory = NodePath.join(root, AREA);
  const state = readRestartHandoff(root, handoffFile);
  if (state.client === 'web' && serverUrl === undefined) throw new Error('Supply the privately derived current worktree WebSocket URL after web restart');
  const run = await connect({ page, repoRoot: root, dbPath: state.dbPath, runtimeIdentity, serverUrl, provider: state.provider,
    bunExecutable: state.bunExecutable, label: state.label });
  let ready = false;
  try {
  run.id = state.runId;
  run.title = MARKER + state.runId;
  run.triggerName = 'live_durability_' + state.runId.replaceAll('-', '');
  run.thread = state.thread;
  run.receipt = state.receipt;
  run.priorSettings = state.priorSettings;
  run.thread = await readOwnedRestartThread(run);
  const settings = await run.socket.rpc('settings.get', {});
  const expectedWrapper = NodePath.join(directory, `${run.provider}-fixture.cmd`);
  if (NodePath.resolve(settings.provider.cli[run.provider]) !== expectedWrapper) throw new Error('Owned provider configuration changed during restart; do not restore unknown settings');
  run.configured = true;
  run.restartState = state;
  const recovery = await captureRecovery(run, { cursor: { epoch: state.cut.epoch, sequence: state.cut.acceptedThrough }, revision: state.cut.durableRevision });
  run.receipt.restartRecovery = frameSummary(recovery);
  writeReceipt(run);
  ready = true;
  return run;
  } finally {
    if (!ready) await run.socket.close();
  }
}

function readRestartHandoff(root, handoffFile) {
  const file = NodePath.resolve(handoffFile);
  const directory = NodePath.join(root, AREA);
  if (!file.startsWith(directory + NodePath.sep) || !file.endsWith('.handoff.json') || NodeFS.lstatSync(file).isSymbolicLink()) throw new Error('Pass this worktree proof handoff file');
  const state = JSON.parse(NodeFS.readFileSync(file, 'utf8'));
  if (state.version !== 1 || NodePath.resolve(state.repoRoot) !== root || !/^[a-f0-9-]{36}$/.test(state.runId) || !state.thread?.id || state.thread.title !== MARKER + state.runId) throw new Error('Invalid owned restart handoff');
  return state;
}

async function readOwnedRestartThread(run) {
  const workspace = (await run.socket.rpc('workspace.list', {})).find(item => item.id === run.thread.workspace_id);
  if (!workspace || NodePath.resolve(workspace.path).toLowerCase() !== NodePath.join(run.repoRoot, '.dev', 'fixture-repo').toLowerCase()) throw new Error('Restored thread is not in the owned fixture workspace');
  const current = (await run.socket.rpc('thread.list', { workspaceId: workspace.id })).find(thread => thread.id === run.thread.id);
  if (!current || current.title !== run.title || current.provider !== run.provider) throw new Error('Same owned thread/provider did not survive restart');
  return current;
}

/** Separates server loss accounting, rendered loss notice, and native provider non-replay evidence. */
export async function verifyRestartLoss(run) {
  const state = run.restartState;
  if (!state) throw new Error('Resume the owned restart handoff first');
  const recovery = run.receipt.restartRecovery;
  const observation = await observe(run, { phase: 'after-runtime-restart' });
  const pendingIds = new Set(state.cut.events.map((event) => event.eventId));
  const storedById = new Map(observation.persisted.descriptors.map((event) => [event.eventId, event]));
  const result = { at: new Date().toISOString(), oldEpoch: state.cut.epoch, freshEpoch: recovery.epoch,
    epochChanged: recovery.epoch !== state.cut.epoch, serverReportedLoss: recovery.loss === 'runtime-restarted',
    rendererReportedLoss: observation.lossLabelRendered,
    oldPendingNotRetained: recovery.events.every((event) => !pendingIds.has(event.eventId)),
    oldPendingNotOnDisk: [...pendingIds].every((id) => !storedById.has(id)),
    savedPrefixUnchanged: state.stored.descriptors.every((event) => storedById.get(event.eventId)?.semanticHash === event.semanticHash),
    providerWasNotReinvoked: observation.providerInvocationAudit.length === state.providerInvocationAudit.length,
    originalMeasuredInvocationCount: state.providerInvocationAudit.length,
    currentMeasuredInvocationCount: observation.providerInvocationAudit.length,
    emittedUnsavedResponseRemovedFromRenderer: (!readStamp(run, 'after-tool') || !observation.ownText.find((part) => part.part === 'AFTER_TOOL').rendered)
      && (!readStamp(run, 'terminal') || readStamp(run, 'cancelled') || !observation.ownText.find((part) => part.part === 'COMPLETE').rendered),
    runtimeNotRunning: Array.isArray(observation.running) && observation.running.every((snapshot) => snapshot.phase !== 'running' && snapshot.phase !== 'finalizing') };
  run.receipt.restartLoss = result;
  writeReceipt(run);
  return result;
}

/** Reloads the same conversation, preserving the real UI/reconnect boundary. */
export async function reload(run, phase = 'reload') {
  await reconnectOwnedThread(run);
  return observe(run, { phase });
}

async function reconnectOwnedThread(run) {
  await run.page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 });
  await run.page.getByRole('button', { name: 'New thread', exact: true }).waitFor({ state: 'visible', timeout: 8000 });
  // Desktop reload starts at home; reopen the exact owned thread through its real sidebar row.
  await openThread(run);
}

/** Requires a genuinely saved PREFIX before a held-writer journey begins. */
export async function waitDurablePrefix(run, maxMs = 8000) {
  if (run.fault || maxMs > 15_000) throw new Error('Check prefix durability before arming a fault');
  const deadline = Date.now() + maxMs;
  for (;;) {
    const recovery = await captureRecovery(run);
    const stored = dbOperation(run, 'inspect');
    if (recovery.acceptedThrough === recovery.savedThrough && stored.ownMarkers.PREFIX) {
      run.receipt.durablePrefix = { at: new Date().toISOString(), cut: frameSummary(recovery), stored };
      writeReceipt(run);
      return { saved: true, epoch: recovery.epoch, through: recovery.savedThrough, eventCount: stored.eventCount };
    }
    if (Date.now() >= deadline) throw new Error('Native PREFIX was not certified on disk before the fault');
    await timeout(100);
  }
}

/** Proves a fresh Composer remains healthy after its 20-second send RPC timeout, before fault injection. */
export async function healthyPrefixGate(run, { durationMs = 30_000 } = {}) {
  requireHealthyGateOptions(run, durationMs);
  const invokedAt = Date.parse(readStamp(run, 'invocation').at);
  const deadline = invokedAt + durationMs;
  const samples = [];
  try {
    for (;;) {
      const body = await run.page.locator('body').innerText({ timeout: 1500 });
      const snapshot = (await run.socket.rpc('agent.listRunning', {}, Date.now() + 3000)).find(row => row.threadId === run.thread.id);
      const sample = { at: new Date().toISOString(), snapshot,
        prefixRendered: body.includes(`LIVE_DURABILITY ${run.id} PREFIX`),
        stopButtonCount: await run.page.getByRole('button', { name: 'Stop agent', exact: true }).count(),
        terminal: readStamp(run, 'terminal') };
      samples.push(sample);
      requireHealthyPrefix({ ...sample, executionId: run.receipt.executionId });
      if (Date.now() >= deadline) break;
      await timeout(Math.min(1000, deadline - Date.now()));
    }
    run.receipt.healthyPrefixGate = { passed: true, invokedAt: new Date(invokedAt).toISOString(), durationMs, samples };
    writeReceipt(run);
    return run.receipt.healthyPrefixGate;
  } catch (error) {
    run.receipt.healthyPrefixGate = { passed: false, invokedAt: new Date(invokedAt).toISOString(), durationMs, samples, failure: safeFailure(error) };
    writeReceipt(run);
    throw error;
  }
}

function requireHealthyGateOptions(run, durationMs) {
  if (run.fault || !run.receipt.uiPrecondition || !run.receipt.durablePrefix) throw new Error('Healthy gate requires the fresh rendered and certified prefix before a fault');
  if (!Number.isSafeInteger(durationMs) || durationMs < 25_000 || durationMs > 40_000) throw new Error('Choose a bounded healthy gate beyond the 20-second send RPC timeout');
}

/** Reloads the renderer under a still-live lock and requires the retained native response to return. */
export async function reloadWhileHeld(run, parts = ['COMPLETE']) {
  if (run.fault !== 'hold') throw new Error('Reconnect proof requires a held writer');
  assertHeldLock(run);
  await reconnectOwnedThread(run);
  const deadline = Date.now() + 8000;
  for (;;) {
    const body = await run.page.locator('body').innerText({ timeout: 1500 });
    if (parts.every((part) => body.includes(`LIVE_DURABILITY ${run.id} ${part}`))) break;
    if (Date.now() >= deadline) throw new Error('Retained response did not render on reconnect while saving remained held');
    await timeout(100);
  }
  return observe(run, { phase: 'reconnected-while-held' });
}

/** Restores settings and removes only this proof's registered thread after releasing every fault. */
export async function cleanup(run, { keepThread = false } = {}) {
  const failures = [];
  try { await releaseFault(run); run.receipt.cleanup.faultReleased = true; } catch (error) { failures.push(safeFailure(error)); }
  if (run.thread) {
    try { await run.socket.rpc('agent.stop', { threadId: run.thread.id }); } catch (error) { failures.push(safeFailure(error)); }
    if (!keepThread) try { run.receipt.cleanup.threadDeleted = await run.socket.rpc('thread.delete', { threadId: run.thread.id, cleanupWorktree: false }); } catch (error) { failures.push(safeFailure(error)); }
  }
  await restoreProviderSettings(run, failures);
  run.receipt.cleanup.failures = failures;
  writeReceipt(run);
  await run.socket.close();
  return run.receipt.cleanup;
}

async function restoreProviderSettings(run, failures) {
  if (!run.configured || run.inheritedConfiguration) return;
  try {
    const settings = await run.socket.rpc('settings.get', {});
    const wrapper = NodePath.join(run.directory, `${run.provider}-fixture.cmd`);
    if (settings.provider.cli[run.provider] !== wrapper) throw new Error('Provider CLI changed outside this proof; retain restoration metadata for the coordinator');
    await run.socket.rpc('settings.update', { provider: { cli: { [run.provider]: run.priorSettings.cli }, enabled: { [run.provider]: run.priorSettings.enabled } } });
    run.receipt.cleanup.settingsRestored = true;
  } catch (error) { failures.push(safeFailure(error)); }
}

function dbOperation(run, op) {
  // Exact descriptor reports for long native histories exceed Node's default 1 MiB stdout limit.
  const result = NodeChildProcess.spawnSync(run.bunExecutable, [NodePath.join(MODULE_DIRECTORY, 'db-fault.mjs'), op, run.repoRoot, run.dbPath, run.thread.id, run.triggerName, '', run.receipt.executionId ?? ''], { windowsHide: true, encoding: 'utf8', timeout: 7000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Owned DB fault ${op} failed: ${result.stderr.slice(0, 500)}`);
  return JSON.parse(result.stdout.trim());
}

function controlPath(run, phase) { return NodePath.join(run.directory, `${run.id}.${phase}.json`); }
function invocationPrompt(run, options = {}) {
  const controls = fixtureOptions(options);
  requireLongTurnControls(controls.longToolPairs, controls.pairDelayMs);
  requireChildMode(run.provider, controls.childMode);
  if (run.provider !== 'codex' && [controls.pauseAfterFinal, controls.pauseDuringFinal, controls.legacyIdenticalText].includes(true)) throw new Error('Paused or legacy final fixture requires Codex');
  if (controls.pauseDuringFinal && controls.legacyIdenticalText) throw new Error('Partial final fixture cannot use legacy identical text');
  run.receipt.fixtureControl = controls;
  return [`LIVE_DURABILITY_RUN=${run.id}`, ...promptControlLines(controls)].join('\n');
}
function fixtureOptions({ pauseBeforeTerminal = false, pauseDuringFinal = false, pauseAfterFinal = false, legacyIdenticalText = false, honorCancel = false, longToolPairs = 0, pairDelayMs = 10, childMode }) {
  return { pauseBeforeTerminal, pauseDuringFinal, pauseAfterFinal, legacyIdenticalText, honorCancel: [honorCancel, pauseAfterFinal, pauseDuringFinal].includes(true), longToolPairs, pairDelayMs, childMode };
}
function requireChildMode(provider, childMode) {
  if (childMode !== undefined && (provider !== 'codex' || !['completed', 'paused'].includes(childMode))) throw new Error('Native child fixture requires Codex and an explicit completed/paused mode');
}
function promptControlLines({ pauseBeforeTerminal, pauseDuringFinal, pauseAfterFinal, legacyIdenticalText, honorCancel, longToolPairs, pairDelayMs, childMode }) {
  const lines = [];
  if (pauseBeforeTerminal) lines.push('LIVE_DURABILITY_TERMINAL=pause');
  if (pauseDuringFinal) lines.push('LIVE_DURABILITY_DURING_FINAL=pause');
  if (pauseAfterFinal) lines.push('LIVE_DURABILITY_AFTER_FINAL=pause');
  if (legacyIdenticalText) lines.push('LIVE_DURABILITY_LEGACY_IDENTICAL_TEXT=true');
  if (honorCancel) lines.push('LIVE_DURABILITY_CANCEL=honor');
  if (longToolPairs) lines.push(`LIVE_DURABILITY_LONG_TOOLS=${longToolPairs}`, `LIVE_DURABILITY_PAIR_DELAY_MS=${pairDelayMs}`);
  if (childMode) lines.push('LIVE_DURABILITY_CHILD=' + childMode);
  return lines;
}
function requireLongTurnControls(longToolPairs, pairDelayMs) {
  if (!Number.isInteger(longToolPairs) || longToolPairs < 0 || longToolPairs > 5000 || !Number.isInteger(pairDelayMs) || pairDelayMs < 0 || pairDelayMs > 50 || longToolPairs * pairDelayMs > 120_000) throw new Error('Invalid bounded long-turn fixture settings');
}
async function recordExecution(run) {
  const snapshot = (await run.socket.rpc('agent.listRunning', {})).find((row) => row.threadId === run.thread.id);
  if (!snapshot?.turnExecutionId) throw new Error('Measured fixture execution identity was not observed');
  run.receipt.executionId = snapshot.turnExecutionId;
}
function assertHeldLock(run) {
  if (run.fault === 'hold' && (!run.lockChild || run.lockChild.exitCode !== null || Date.now() >= Date.parse(run.receipt.lock.expiresAt))) throw new Error('Owned SQLite lock expired; held-save proof is inconclusive');
}
function readAudit(run) {
  const file = NodePath.join(run.directory, `${run.id}.audit.ndjson`);
  if (!NodeFS.existsSync(file)) return [];
  return NodeFS.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
    const event = JSON.parse(line);
    if (event.runId !== run.id || event.provider !== run.provider || Date.parse(event.at) < Date.parse(run.receipt.invocation.at)) throw new Error('Stale native invocation audit');
    return event;
  });
}
function beginInvocation(run, invocationPath) {
  if (run.receipt.invocation) throw new Error('Each native invocation requires a fresh connect() UUID');
  if (['invocation', 'prefix', 'tool', 'partial-final', 'after-final', 'terminal', 'expired'].some((part) => NodeFS.existsSync(controlPath(run, part))) || ['release', 'finish', 'continue-final', 'finish-final', 'audit.ndjson'].some((suffix) => NodeFS.existsSync(NodePath.join(run.directory, `${run.id}.${suffix}`)))) throw new Error('Stale fixture controls exist for this UUID');
  run.receipt.invocation = { path: invocationPath, at: new Date().toISOString() };
  writeReceipt(run);
}
function readStamp(run, phase) {
  const file = controlPath(run, phase);
  if (!NodeFS.existsSync(file)) return null;
  const stamp = JSON.parse(NodeFS.readFileSync(file, 'utf8'));
  if (stamp.runId !== run.id || stamp.provider !== run.provider || stamp.phase !== phase || !Number.isFinite(Date.parse(stamp.at)) || !run.receipt.invocation || Date.parse(stamp.at) < Date.parse(run.receipt.invocation.at)) throw new Error(`Stale or mismatched native ${phase} stamp`);
  return stamp;
}
async function waitFile(run, phase, maxMs) {
  const deadline = Date.now() + maxMs;
  while (!readStamp(run, phase)) {
    if (Date.now() > deadline) throw new Error(`Native fixture did not reach ${phase}`);
    await timeout(50);
  }
  return readStamp(run, phase);
}
function writeReceipt(run) {
  NodeFS.writeFileSync(NodePath.join(run.directory, `${run.label}-${run.provider}-${run.id}.receipt.json`), JSON.stringify(run.receipt, null, 2) + '\n');
}
