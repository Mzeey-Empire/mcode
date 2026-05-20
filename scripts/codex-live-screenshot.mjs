#!/usr/bin/env node
// Open dev web in msedge, navigate to the codex-trace workspace's most recent
// thread, and screenshot it so we can visually confirm the live thought-vs-final
// rendering.
import { chromium } from "file:///C:/Users/cjnwo/.mcode/worktrees/mcode/feat-openai-codex-eaa72655/node_modules/.bun/playwright@1.59.1/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

page.on("console", (m) => {
  if (m.type() === "error") console.log("[browser-error]", m.text().slice(0, 200));
});

const VITE_PORT = process.env.VITE_PORT || "5188";
await page.goto(`http://localhost:${VITE_PORT}/`, { waitUntil: "domcontentloaded" });
await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);

// Click into the codex-trace project
const clicked = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("[data-testid^='project-row-']")];
  const row = rows.find((r) => /codex-trace/i.test(r.textContent ?? ""));
  if (row) { row.click(); return true; }
  return false;
});
console.log(`[step] click project: ${clicked}`);
await page.waitForTimeout(1500);

// Click the most recent thread
const threadClicked = await page.evaluate(() => {
  const items = [...document.querySelectorAll("[data-testid='thread-item']")];
  if (items[0]) { items[0].click(); return items[0].textContent?.slice(0, 80) ?? "?"; }
  return null;
});
console.log(`[step] click thread: ${threadClicked}`);
await page.waitForTimeout(5000);

const outPath = String.raw`C:\Users\cjnwo\AppData\Local\Temp\codex-thread-rendered.png`;
await page.screenshot({ path: outPath, fullPage: true });
console.log(`[ok] screenshot saved to ${outPath}`);

// Capture inner text — try a broader selector since chat-view may take time to mount.
const chatBody = await page.evaluate(() => {
  const view = document.querySelector("[data-testid='chat-view'], [data-testid='message-list'], main");
  return view ? view.innerText.slice(0, 3000) : `(no chat view; body: ${document.body.innerText.slice(0, 500)})`;
});
console.log("---CHAT TEXT---");
console.log(chatBody.replace(/\n{2,}/g, "\n"));
console.log("---END---");

await browser.close();
