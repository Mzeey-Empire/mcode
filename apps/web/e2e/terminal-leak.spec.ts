import { test, expect, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";

/**
 * Mocks the WS server with terminal-aware RPC responses.
 * Tracks issued ptyIds so terminal.create returns a unique id each time.
 */
async function mockWebSocketServer(page: Page): Promise<void> {
  // Match the mcode server port range (19400-19800, 5 digits) to avoid
  // intercepting Vite's HMR socket at port 5173 (4 digits).
  await page.routeWebSocket(/ws:\/\/localhost:\d{5}/, (ws) => {
    let ptyCounter = 0;
    ws.onMessage((data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const method = msg.method as string;
      let result: unknown = null;
      if (method?.endsWith(".list")) result = [];
      else if (method === "git.currentBranch") result = "main";
      else if (method === "agent.activeCount") result = 0;
      else if (method === "app.version") result = "0.0.1-test";
      else if (method === "config.discover") result = {};
      else if (method === "settings.get") result = getDefaultSettings();
      else if (method === "terminal.create") {
        ptyCounter += 1;
        result = `pty-test-${ptyCounter}`;
      } else if (
        method === "terminal.write" ||
        method === "terminal.resize" ||
        method === "terminal.kill" ||
        method === "terminal.killByThread"
      ) {
        result = true;
      }
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });
}

test.describe("Terminal dispose hygiene", () => {
  test.beforeEach(async ({ page }) => {
    await mockWebSocketServer(page);
  });

  test("live terminal counter returns to zero after create + close", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const initial = await page.evaluate(
      () => (window as unknown as { __mcodeLiveTerminals?: number }).__mcodeLiveTerminals ?? null,
    );
    expect(initial, "__mcodeLiveTerminals must be exposed in dev builds").not.toBeNull();
    expect(initial).toBe(0);

    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press("Control+J");
      await page.getByRole("button", { name: /new terminal/i }).click();
      await page.waitForTimeout(50);
      await page.keyboard.press("Control+J");
      await page.waitForTimeout(50);
    }

    await page.waitForTimeout(100);

    const final = await page.evaluate(
      () => (window as unknown as { __mcodeLiveTerminals?: number }).__mcodeLiveTerminals,
    );
    expect(final).toBe(0);
  });
});
