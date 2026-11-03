/**
 * Returns the URL the page loaded a source module from, such as "/src/stores/threadStore.ts".
 *
 * Import that exact URL inside `page.evaluate` to reach the app's own module instance. Vite serves
 * a module that was edited during the dev server's life as `<path>?t=<timestamp>`, so importing
 * the bare path creates a second instance whose stores are empty. The page's resource timings are
 * no help: Chromium keeps only the first 250, and the app loads more modules than that.
 */
export async function appModuleUrl(page, modulePath) {
  if (typeof modulePath !== "string" || !modulePath.startsWith("/")) {
    throw new Error("Pass a served module path such as /src/stores/threadStore.ts");
  }
  const cdp = await page.context().newCDPSession(page);
  const loaded = [];
  cdp.on("Debugger.scriptParsed", ({ url }) => {
    if (url && new URL(url).pathname === modulePath) loaded.push(new URL(url));
  });
  try {
    // Enabling the debugger replays scriptParsed for every script the page has already parsed.
    await cdp.send("Debugger.enable");
    await cdp.send("Debugger.disable");
  } finally {
    await cdp.detach();
  }
  if (loaded.length === 0) {
    throw new Error(`The page has not loaded ${modulePath} yet. Wait for the app to finish loading.`);
  }
  // The app imports the URL with the latest edit time. A bare URL can also come from a probe's
  // own earlier import, so it is the app's only when no timestamped version is loaded.
  return loaded.reduce((latest, url) => (editTime(url) > editTime(latest) ? url : latest)).href;
}

function editTime(url) {
  return url.searchParams.has("t") ? Number(url.searchParams.get("t")) : -1;
}

/**
 * Page function that samples matching elements on every animation frame until read.
 * Run it with `page.evaluate(installFrameProbe, { selector, label })`, then act.
 */
export function installFrameProbe({ selector, label }) {
  const probes = (window.__liveTestingFrameProbes ??= {});
  const samples = (probes[label] = []);
  const startedAt = performance.now();
  const sample = () => {
    if (probes[label] !== samples) return;
    const elements = [...document.querySelectorAll(selector)];
    samples.push({
      t: Math.round(performance.now() - startedAt),
      count: elements.length,
      boxes: elements.slice(0, 4).map((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
          opacity: style.opacity,
          visibility: style.visibility,
        };
      }),
    });
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

/**
 * Page function that stops a frame probe and returns its samples.
 * Run it with `page.evaluate(readFrameProbe, label)`.
 */
export function readFrameProbe(label) {
  const probes = window.__liveTestingFrameProbes ?? {};
  const samples = probes[label] ?? [];
  delete probes[label];
  return samples;
}
