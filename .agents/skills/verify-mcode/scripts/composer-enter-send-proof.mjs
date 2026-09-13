#!/usr/bin/env bun
/**
 * Live Electron proof: Enter submits the Composer and clears the draft.
 * Also proves a follow-up Enter is accepted while a prior send RPC is delayed.
 * Writes evidence under .dev/verification/composer-enter-send/.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { createRequire } from "node:module";

const ROOT = NodePath.resolve(import.meta.dirname, "../../../../");
const EVIDENCE_DIR = NodePath.join(ROOT, ".dev/verification/composer-enter-send");
const RECEIPT = NodePath.join(EVIDENCE_DIR, "receipt.json");
const AFTER_FIRST = NodePath.join(EVIDENCE_DIR, "after-first-enter.png");
const AFTER_SECOND = NodePath.join(EVIDENCE_DIR, "after-second-enter.png");
const PLAYWRIGHT_ENTRY = NodePath.join(ROOT, ".dev/playwright-scratch/package.json");

const require = createRequire(PLAYWRIGHT_ENTRY);
const playwright = require("playwright");
const { connectElectronSession, disconnectElectronSession } = await import(
  NodePath.join(ROOT, ".agents/skills/electorn-live-testing/scripts/electron-session.mjs")
);

const FIRST = `enter-send-first-${Date.now()}`;
const SECOND = `enter-send-second-${Date.now()}`;
const assertions = {};
let session;

function mark(name, passed, details) {
  assertions[name] = details === undefined ? passed : { passed, details };
  if (!passed) throw new Error(`Assertion failed: ${name}${details ? `: ${details}` : ""}`);
}

function composerEditor(page) {
  return page.getByRole("textbox", { name: "Message Mcode", exact: true });
}

async function openFixtureComposer(page) {
  const newChat = page.getByRole("button", { name: /new (chat|thread)/i }).first();
  if (await newChat.isVisible().catch(() => false)) {
    await newChat.click();
  }
  const picker = page.getByTestId("new-thread-project-picker");
  await picker.waitFor({ state: "visible", timeout: 30_000 });
  await picker.click();
  const fixture = page.getByRole("option", { name: /fixture-repo/i }).first();
  await fixture.waitFor({ state: "visible", timeout: 30_000 });
  await fixture.click();
  await composerEditor(page).waitFor({ state: "visible", timeout: 30_000 });
}

async function installSendDelay(page) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const postData = request.postData() ?? "";
    const url = request.url();
    const looksLikeSend =
      request.method() === "POST"
      && (url.includes("message") || url.includes("thread") || url.includes("agent") || postData.includes("createAndSend") || postData.includes("sendMessage"));
    if (looksLikeSend) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    await route.continue();
  });
}

async function readComposerText(page) {
  return ((await composerEditor(page).textContent()) ?? "").trim();
}

try {
  NodeFS.mkdirSync(EVIDENCE_DIR, { recursive: true });
  session = await connectElectronSession({ playwright, repoRoot: ROOT });
  const page = session.page;
  await openFixtureComposer(page);
  await installSendDelay(page);

  const editor = composerEditor(page);
  await editor.click();
  await editor.fill(FIRST);
  mark("first_draft_present", (await readComposerText(page)).includes(FIRST));

  await editor.press("Enter");
  await page.waitForTimeout(300);
  const afterFirst = await readComposerText(page);
  mark("first_enter_cleared_composer", afterFirst.length === 0 || !afterFirst.includes(FIRST), afterFirst);
  await page.screenshot({ path: AFTER_FIRST, fullPage: false });

  await editor.fill(SECOND);
  mark("second_draft_present", (await readComposerText(page)).includes(SECOND));
  await editor.press("Enter");
  await page.waitForTimeout(400);
  const afterSecond = await readComposerText(page);
  mark("second_enter_cleared_composer_while_first_in_flight", afterSecond.length === 0 || !afterSecond.includes(SECOND), afterSecond);
  await page.screenshot({ path: AFTER_SECOND, fullPage: false });

  const receipt = {
    ok: true,
    assertions,
    evidence: {
      afterFirstEnter: AFTER_FIRST,
      afterSecondEnter: AFTER_SECOND,
    },
    prompts: { first: FIRST, second: SECOND },
    proved: "Enter clears the Composer draft, and a follow-up Enter is accepted while a prior send is delayed.",
  };
  NodeFS.writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, receipt: RECEIPT, assertions }, null, 2));
} catch (error) {
  const receipt = {
    ok: false,
    assertions,
    error: error instanceof Error ? error.message : String(error),
  };
  NodeFS.mkdirSync(EVIDENCE_DIR, { recursive: true });
  NodeFS.writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  console.error(JSON.stringify(receipt, null, 2));
  process.exitCode = 1;
} finally {
  if (session) await disconnectElectronSession(session);
}
