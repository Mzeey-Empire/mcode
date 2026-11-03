import { afterEach, expect, test } from "bun:test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { connectElectronSession, reloadElectronAppPage } from "./electron-session.mjs";

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

function createPage() {
  return {
    isClosed: () => false,
    setViewportSize: async () => {},
    url: () => "file:///index.html",
  };
}

function createSessionFixture(sessionFileName = "electron-live-testing.json") {
  const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "electron-session-test-"));
  tempRoots.push(repoRoot);
  NodeFS.mkdirSync(NodePath.join(repoRoot, ".dev"));
  NodeFS.writeFileSync(NodePath.join(repoRoot, ".dev", sessionFileName), JSON.stringify({
    status: "running",
    pid: 4242,
    debugPort: 9222,
    repoRoot,
    appUrlPrefix: "file://",
  }));
  const page = createPage();
  const listeners = new Map();
  const context = {
    pages: () => [page],
    on: (event, listener) => { listeners.set(event, listener); },
  };
  let connectionCount = 0;
  const playwright = {
    chromium: {
      connectOverCDP: async () => {
        connectionCount += 1;
        return { contexts: () => [context] };
      },
    },
  };
  return {
    options: { playwright, repoRoot, sessionFileName, reload: false },
    emitPage: (newPage) => { listeners.get("page")?.(newPage); },
    connectionCount: () => connectionCount,
  };
}

test("blocks viewport emulation on the default session page", async () => {
  const fixture = createSessionFixture();
  const session = await connectElectronSession(fixture.options);

  await expect(session.page.setViewportSize({ width: 1200, height: 800 }))
    .rejects.toThrow("setElectronWindowSize");
});

test("blocks viewport emulation on pages opened later", async () => {
  const fixture = createSessionFixture();
  await connectElectronSession(fixture.options);
  const laterPage = createPage();
  fixture.emitPage(laterPage);

  await expect(laterPage.setViewportSize({ width: 1200, height: 800 }))
    .rejects.toThrow("setElectronWindowSize");
});

test("allows viewport emulation in an opted-in disposable session", async () => {
  const fixture = createSessionFixture("electron-perf-test.json");
  const session = await connectElectronSession({ ...fixture.options, allowViewportEmulation: true });

  await expect(session.page.setViewportSize({ width: 1440, height: 1000 }))
    .resolves.toBeUndefined();
});

test("rejects viewport emulation in the default session before connecting", async () => {
  const fixture = createSessionFixture();

  await expect(connectElectronSession({ ...fixture.options, allowViewportEmulation: true }))
    .rejects.toThrow("own sessionFileName");
  expect(fixture.connectionCount()).toBe(0);
});

test("reacquires the replacement app page after an aborted reload", async () => {
  const originalPage = {
    isClosed: () => true,
    reload: async () => {
      throw new Error("reload: net::ERR_ABORTED; maybe frame was detached?");
    },
    url: () => "http://127.0.0.1:41890/",
  };
  const replacementPage = {
    isClosed: () => false,
    url: () => "http://127.0.0.1:41890/",
  };
  const context = { pages: () => [originalPage, replacementPage] };

  await expect(reloadElectronAppPage(context, originalPage, "http://127.0.0.1:41890/"))
    .resolves.toBe(replacementPage);
});

test("does not return a page that closes during a successful reload", async () => {
  let closed = false;
  const originalPage = {
    isClosed: () => closed,
    reload: async () => { closed = true; },
    url: () => "http://127.0.0.1:41890/",
  };
  const replacementPage = {
    isClosed: () => false,
    url: () => "http://127.0.0.1:41890/",
  };
  const context = { pages: () => [originalPage, replacementPage] };

  await expect(reloadElectronAppPage(context, originalPage, "http://127.0.0.1:41890/"))
    .resolves.toBe(replacementPage);
});

test("preserves unexpected reload failures", async () => {
  const page = {
    isClosed: () => false,
    reload: async () => {
      throw new Error("reload: navigation timeout");
    },
    url: () => "http://127.0.0.1:41890/",
  };

  await expect(reloadElectronAppPage({ pages: () => [page] }, page, "http://127.0.0.1:41890/"))
    .rejects.toThrow("reload: navigation timeout");
});
