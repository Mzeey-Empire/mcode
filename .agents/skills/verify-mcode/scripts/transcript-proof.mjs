import * as NodeAssert from "node:assert";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";

/** Reads rendered rows through the public transcript DOM. */
export async function inspectTranscript(page) {
  return page.getByTestId("transcript-viewport").evaluate((viewport) => {
    const bounds = viewport.getBoundingClientRect();
    const rows = [...viewport.querySelectorAll("[data-transcript-key]")];
    const anchor = rows.find((row) => row.getBoundingClientRect().bottom > bounds.top
      && row.getBoundingClientRect().top < bounds.bottom);
    return {
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      mountedRows: rows.length,
      descendants: viewport.querySelectorAll("*").length,
      anchor: anchor ? { key: anchor.dataset.transcriptKey, offset: anchor.getBoundingClientRect().top - bounds.top } : null,
      steps: rows.flatMap((row) => {
        const match = row.textContent.match(/Fixture step (\d+):/);
        return match ? [Number(match[1])] : [];
      }),
    };
  });
}

async function settle(page) {
  let previous;
  let stable = 0;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await inspectTranscript(page);
    stable = JSON.stringify(current) === JSON.stringify(previous) ? stable + 1 : 0;
    if (stable === 3) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Transcript did not settle within 10 seconds; inspect renderer errors.");
}

/** Proves a long fixture's DOM window, order, and cached reading position without database writes. */
export async function proveTranscriptCache(page, { threadTitle, evidenceDirectory }) {
  await NodeFSPromises.mkdir(evidenceDirectory, { recursive: true });
  const viewport = page.getByTestId("transcript-viewport");
  await viewport.hover();
  await page.mouse.wheel(0, 1_000_000);
  const tail = await settle(page);
  NodeAssert.strictEqual(tail.steps.at(-1), 120, "Open a completed long narrative from transcript-provider-fixture.mjs.");
  NodeAssert.match(await viewport.innerText(), /120 steps/i, "The completed turn footer must count its provider-neutral tool records.");
  await page.mouse.wheel(0, -3000);
  const reading = await settle(page);
  NodeAssert.ok(reading.anchor, "The reading position must contain a visible row.");
  NodeAssert.ok(reading.steps.length > 1 && reading.steps.at(-1) < 120, "Older narration must remount and tail narration must unmount.");
  NodeAssert.ok(reading.mountedRows < 50, "One long turn must not mount its full narrative.");
  NodeAssert.ok(reading.steps.every((step, index, steps) => index === 0 || step === steps[index - 1] + 1), "Narration must retain chronological order.");
  await page.screenshot({ path: NodePath.join(evidenceDirectory, "reading-before.png") });
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await page.getByTestId("thread-title").filter({ hasText: threadTitle }).click();
  const restored = await settle(page);
  NodeAssert.strictEqual(restored.anchor?.key, reading.anchor.key, "Cache restore changed the visible row.");
  NodeAssert.ok(Math.abs(restored.anchor.offset - reading.anchor.offset) <= 1, "Cache restore changed the reading offset.");
  await page.screenshot({ path: NodePath.join(evidenceDirectory, "reading-restored.png") });
  const receipt = { tail, reading, restored };
  await NodeFSPromises.writeFile(NodePath.join(evidenceDirectory, "receipt.json"), JSON.stringify(receipt, null, 2));
  return receipt;
}
