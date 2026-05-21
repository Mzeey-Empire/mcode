#!/usr/bin/env node
// Live-app test: drive the dev web at localhost:5183 with msedge (Playwright),
// open MyVueApp, open / create a Codex thread, send a tool-forcing prompt,
// and capture session.textDelta WS frames to verify isFinalResponse routing.
import { chromium } from "file:///C:/Users/cjnwo/.mcode/worktrees/mcode/feat-openai-codex-eaa72655/node_modules/.bun/playwright@1.59.1/node_modules/playwright/index.mjs";
import { appendFileSync, writeFileSync } from "node:fs";

const log = "/tmp/codex-live.log";
writeFileSync(log, "");
const w = (s) => { appendFileSync(log, s + "\n"); console.log(s); };

const browser = await chromium.launch({ channel: "msedge", headless: false });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const textDeltas = []; // { delta, isFinalResponse }
const toolEvents = []; // toolUse / toolResult
page.on("websocket", (ws) => {
  if (!ws.url().includes(":19400")) return;
  w(`[ws] open ${ws.url()}`);
  ws.on("framereceived", (f) => {
    const p = typeof f.payload === "string" ? f.payload : f.payload?.toString?.();
    if (!p) return;
    if (p.includes('"channel":"session.textDelta"') || p.includes('session.textDelta')) {
      try {
        const obj = JSON.parse(p);
        const params = obj?.params ?? obj?.data ?? {};
        textDeltas.push({
          delta: (params.delta ?? "").slice(0, 40),
          isFinalResponse: params.isFinalResponse === true,
        });
      } catch {}
    }
    if (p.includes('toolUse') || p.includes('toolResult')) {
      toolEvents.push(p.slice(0, 160));
    }
  });
});

await page.goto("http://localhost:5183/", { waitUntil: "domcontentloaded" });
await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
w(`[ok] loaded`);

// Click the MyVueApp project entry
const projectClicked = await page.evaluate(() => {
  const links = [...document.querySelectorAll("a, button, [role='button']")];
  const target = links.find((el) => /MyVueApp/.test(el.textContent ?? "") && !/Add/.test(el.textContent ?? ""));
  if (target) { target.click(); return true; }
  return false;
});
w(`[step] clicked MyVueApp: ${projectClicked}`);
await page.waitForTimeout(1500);

// Find a NEW thread / composer. The app uses a composer in chat view by default
// after thread creation. Just look for a recent thread that already has codex
// configured — clicking it puts us into a codex chat.
const threadClicked = await page.evaluate(() => {
  const links = [...document.querySelectorAll("[data-testid*='thread'], a, button, [role='button']")];
  const target = links.find((el) => /Using sub-agents/.test(el.textContent ?? ""));
  if (target) { target.click(); return target.textContent?.slice(0, 60); }
  return null;
});
w(`[step] clicked recent thread: ${threadClicked}`);
await page.waitForTimeout(2500);
await page.screenshot({ path: "/tmp/codex-live-2-thread.png", fullPage: false });

// Look at what we landed on
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 600));
w(`[body] ${bodyText.replace(/\s+/g, " ").slice(0, 500)}`);

// Try to find a "+" or "new thread" button so we have a clean turn
const newThreadClicked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button, [role='button']")];
  const target = btns.find((b) => /new thread|new chat/i.test(b.getAttribute?.("aria-label") ?? b.title ?? b.textContent ?? ""));
  if (target) { target.click(); return target.textContent?.slice(0, 40) || target.getAttribute("aria-label"); }
  return null;
});
w(`[step] new-thread btn: ${newThreadClicked}`);
await page.waitForTimeout(1500);

// Locate composer textbox
const composer = await page.$("textarea, [contenteditable='true']");
if (composer) {
  await composer.click();
  await composer.type("Run the shell command: dir   Then in one short sentence say the count of items.", { delay: 10 });
  await page.screenshot({ path: "/tmp/codex-live-3-composed.png", fullPage: false });

  // Find provider selector if visible; pick codex
  const providerSet = await page.evaluate(() => {
    const els = [...document.querySelectorAll("button, [role='combobox'], [role='button']")];
    const pick = els.find((e) => /codex/i.test(e.textContent ?? ""));
    if (pick) { pick.click(); return pick.textContent?.slice(0, 60); }
    return null;
  });
  w(`[step] picked codex (if shown): ${providerSet}`);
  await page.waitForTimeout(500);

  await page.keyboard.press("Control+Enter");
  w(`[step] submitted prompt; waiting up to 60s for events…`);
  const start = Date.now();
  while (Date.now() - start < 60000) {
    await page.waitForTimeout(1000);
    if (textDeltas.length > 5 && Date.now() - start > 8000) {
      const tailHasFinal = textDeltas.slice(-3).some((d) => d.isFinalResponse);
      if (tailHasFinal) break;
    }
  }
} else {
  w(`[err] composer not found`);
}

await page.screenshot({ path: "/tmp/codex-live-4-result.png", fullPage: true });

// Summarize
const pre = textDeltas.filter((d) => !d.isFinalResponse).length;
const fin = textDeltas.filter((d) => d.isFinalResponse).length;
w(`\n[summary] textDelta total=${textDeltas.length}  thoughts(no isFinalResponse)=${pre}  final(isFinalResponse:true)=${fin}`);
w(`[summary] tool events captured: ${toolEvents.length}`);
w(`[summary] first 12 deltas:`);
for (const d of textDeltas.slice(0, 12)) {
  w(`   isFinal=${d.isFinalResponse ? "TRUE " : "false"}  delta=${JSON.stringify(d.delta)}`);
}
w(`[summary] last 8 deltas:`);
for (const d of textDeltas.slice(-8)) {
  w(`   isFinal=${d.isFinalResponse ? "TRUE " : "false"}  delta=${JSON.stringify(d.delta)}`);
}

await page.waitForTimeout(2000);
await browser.close();
