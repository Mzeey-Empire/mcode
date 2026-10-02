/** Pairs an explicitly owned Electron session, server instance, renderer, and database. */
import * as NodeFS from 'node:fs';
import * as NodePath from 'node:path';

const samePath = (left, right) => NodePath.resolve(left).toLowerCase() === NodePath.resolve(right).toLowerCase();
const pid = (value) => Number.isSafeInteger(value) && value > 0;

/** Reads redacted identity from this worktree's existing Electron session; it never starts a process. */
export function readElectronRuntimeIdentity(repoRoot, sessionFileName = 'electron-live-testing.json') {
  const root = NodePath.resolve(repoRoot);
  if (!/^electron-[a-z0-9-]+\.json$/.test(sessionFileName)) throw new Error('Pass a safe owned Electron session file name');
  const record = JSON.parse(NodeFS.readFileSync(NodePath.join(root, '.dev', sessionFileName), 'utf8'));
  const userDataDir = NodePath.join(root, '.dev', sessionFileName.slice(0, -5));
  requireSessionRecord(record, root, userDataDir);
  const lock = JSON.parse(NodeFS.readFileSync(NodePath.join(userDataDir, 'runtime', 'server.lock'), 'utf8'));
  requireServerLock(lock);
  return { client: 'electron', sessionFileName, electronPid: record.pid, serverPid: lock.pid,
    serverStartedAt: lock.startedAt, dbPath: NodePath.join(userDataDir, 'runtime', 'db', 'app.sqlite') };
}

/** Rejects stale identity, another database, or a renderer endpoint that differs from the owned server lock. */
export function validateElectronRuntime({ repoRoot, dbPath, pageUrl, serverUrl, runtimeIdentity }) {
  if (!runtimeIdentity || runtimeIdentity.client !== 'electron') throw new Error('Pass the explicit owned Electron runtime identity');
  if (typeof runtimeIdentity.dbPath !== 'string' || typeof dbPath !== 'string' || typeof pageUrl !== 'string') {
    throw new Error('Pass the exact owned database and renderer URL');
  }
  const actual = readElectronRuntimeIdentity(repoRoot, runtimeIdentity.sessionFileName);
  requireIdentityMatch(actual, runtimeIdentity, dbPath);
  const root = NodePath.resolve(repoRoot);
  const record = JSON.parse(NodeFS.readFileSync(NodePath.join(root, '.dev', actual.sessionFileName), 'utf8'));
  const lock = JSON.parse(NodeFS.readFileSync(NodePath.join(record.userDataDir, 'runtime', 'server.lock'), 'utf8'));
  let endpoint;
  try { endpoint = new URL(serverUrl); } catch { throw new Error('Owned renderer supplied an invalid endpoint'); }
  requireEndpointMatch(endpoint, lock);
  if (!pageUrl.startsWith(record.appUrlPrefix)) throw new Error('Renderer/endpoint does not match the owned Electron runtime');
  return actual;
}

function requireSessionRecord(record, root, userDataDir) {
  if (record.status !== 'running' || !pid(record.pid) || !samePath(record.repoRoot, root)
    || !samePath(record.userDataDir, userDataDir)) throw new Error('Electron session does not belong to this worktree');
}

function requireServerLock(lock) {
  if (!pid(lock.pid) || typeof lock.startedAt !== 'string' || !Number.isFinite(Date.parse(lock.startedAt))) {
    throw new Error('Owned Electron server lock has no valid instance identity');
  }
}

function requireIdentityMatch(actual, expected, dbPath) {
  if (actual.electronPid !== expected.electronPid || actual.serverPid !== expected.serverPid
    || actual.serverStartedAt !== expected.serverStartedAt || !samePath(dbPath, actual.dbPath)
    || !samePath(expected.dbPath, actual.dbPath)) throw new Error('Electron runtime identity/database changed');
}

function requireEndpointMatch(endpoint, lock) {
  if (endpoint.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || Number(endpoint.port) !== lock.port || endpoint.searchParams.get('token') !== lock.authToken
    || endpoint.pathname !== '/' || endpoint.username || endpoint.password) {
    throw new Error('Renderer/endpoint does not match the owned Electron runtime');
  }
}
