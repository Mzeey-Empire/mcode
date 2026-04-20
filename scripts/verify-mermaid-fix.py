"""
Playwright screenshot proof for issue #323 fix.

Demonstrates that:
  1. Without the fix (direct render) — invalid mermaid leaves an orphan node in document.body.
  2. With the fix (parse-first) — no orphan node is created; an inline error banner appears.

Screenshots are saved to apps/web/e2e/screenshots/.
"""

import os
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).parent.parent
SCREENSHOT_DIR = ROOT / "apps" / "web" / "e2e" / "screenshots"
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

# Minimal HTML harness that loads mermaid 11 from the CDN and exposes
# two helper functions for the test to call via page.evaluate().
HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Mermaid orphan test</title>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    window._mermaid = mermaid;
    window._mermaidReady = true;
  </script>
  <style>
    body { font-family: sans-serif; padding: 20px; background: #1a1a1a; color: #eee; }
    #result { margin-top: 12px; padding: 12px; border-radius: 6px; font-size: 14px; }
    .error  { background: #3a1010; border: 1px solid #7a2020; color: #f88; }
    .info   { background: #102030; border: 1px solid #204060; color: #8cf; }
    #orphan-report { margin-top: 8px; font-size: 13px; }
  </style>
</head>
<body>
  <h2>Mermaid orphan verification</h2>
  <div id="result"></div>
  <div id="orphan-report"></div>

  <script>
    // --- WITHOUT fix: direct render ---
    window.testWithoutFix = async function(code, id) {
      const mermaid = window._mermaid;
      const resultEl = document.getElementById('result');
      try {
        const { svg } = await mermaid.render(id, code);
        resultEl.className = 'info';
        resultEl.textContent = 'Rendered OK (should not happen for invalid code)';
      } catch (err) {
        resultEl.className = 'error';
        resultEl.textContent = 'Diagram could not be rendered (raw render error)';
      }
      const orphan = document.getElementById('d' + id);
      const report = document.getElementById('orphan-report');
      report.textContent = orphan
        ? '⚠ ORPHAN PRESENT: #d' + id + ' found in document.body (the bug)'
        : '✓ No orphan in document.body';
      return !!orphan;
    };

    // --- WITH fix: parse-first ---
    window.testWithFix = async function(code, id) {
      const mermaid = window._mermaid;
      const resultEl = document.getElementById('result');
      const parseResult = await mermaid.parse(code, { suppressErrors: true });
      if (!parseResult) {
        resultEl.className = 'error';
        resultEl.textContent = 'Diagram could not be rendered (parse-first caught it — no render called)';
        const report = document.getElementById('orphan-report');
        report.textContent = '✓ No orphan in document.body (render was never called)';
        return false;
      }
      try {
        const { svg } = await mermaid.render(id, code);
        resultEl.className = 'info';
        resultEl.textContent = 'Rendered OK';
      } catch (err) {
        document.getElementById('d' + id)?.remove();
        resultEl.className = 'error';
        resultEl.textContent = 'Diagram could not be rendered (render error, orphan cleaned up)';
      }
      const orphan = document.getElementById('d' + id);
      const report = document.getElementById('orphan-report');
      report.textContent = orphan
        ? '⚠ ORPHAN PRESENT (cleanup failed)'
        : '✓ No orphan in document.body';
      return !!orphan;
    };
  </script>
</body>
</html>
"""

INVALID_CODE = "this is not valid mermaid DSL"


def wait_for_mermaid(page):
    page.wait_for_function("window._mermaidReady === true", timeout=30_000)


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 900, "height": 500})

        # Load the harness page
        page.set_content(HTML, wait_until="domcontentloaded")
        wait_for_mermaid(page)

        # --- Screenshot 1: WITHOUT fix (direct render leaves orphan) ---
        has_orphan = page.evaluate(
            "([code, id]) => window.testWithoutFix(code, id)",
            [INVALID_CODE, "mermaid-test-without-fix"]
        )
        out_before = SCREENSHOT_DIR / "mermaid-without-fix.png"
        page.screenshot(path=str(out_before), full_page=True)
        print(f"[without-fix] orphan present: {has_orphan}")
        print(f"  Screenshot: {out_before}")

        # Reset: remove leftover element so next test is isolated
        page.evaluate("id => document.getElementById('d' + id)?.remove()",
                       "mermaid-test-without-fix")

        # --- Screenshot 2: WITH fix (parse-first, no orphan) ---
        # Reload to get a clean DOM
        page.set_content(HTML, wait_until="domcontentloaded")
        wait_for_mermaid(page)

        has_orphan_after = page.evaluate(
            "([code, id]) => window.testWithFix(code, id)",
            [INVALID_CODE, "mermaid-test-with-fix"]
        )
        out_after = SCREENSHOT_DIR / "mermaid-with-fix.png"
        page.screenshot(path=str(out_after), full_page=True)
        print(f"[with-fix]    orphan present: {has_orphan_after}")
        print(f"  Screenshot: {out_after}")

        browser.close()

        # Assertions
        assert has_orphan, "Expected orphan to exist WITHOUT the fix (confirms the bug)"
        assert not has_orphan_after, "Expected NO orphan WITH the fix (confirms the fix)"
        print("\n✓ Both assertions passed — fix verified.")


if __name__ == "__main__":
    run()
