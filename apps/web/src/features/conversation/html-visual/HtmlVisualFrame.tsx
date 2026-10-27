import { HTML_VISUAL_MIN_HEIGHT, type HtmlVisual } from "@mcode/contracts/models/html-visual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppearance } from "@/hooks/useTheme";
import { buildHtmlVisualDocument, HTML_VISUAL_THEME_MESSAGE, readHtmlVisualHeight, readHtmlVisualTheme } from "./html-visual-document";

/**
 * Shows an agent's HTML visual in a sandboxed frame as wide as the reply column.
 * The page is untrusted. Without allow-same-origin it runs in an opaque origin, so it cannot
 * reach the app document, storage, or cookies, and it gets no top navigation, popups, or forms.
 */
export function HtmlVisualFrame({ visual }: { readonly visual: HtmlVisual }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(HTML_VISUAL_MIN_HEIGHT);
  const appearance = useAppearance();
  // Built once per page: theme changes are posted to the running page, because a new srcdoc would reload it.
  const srcDoc = useMemo(() => buildHtmlVisualDocument(visual.html, readHtmlVisualTheme()), [visual.html]);

  const postTheme = useCallback(() => {
    // The sandboxed page has an opaque origin, so "*" is the only target that reaches it.
    frameRef.current?.contentWindow?.postMessage({ type: HTML_VISUAL_THEME_MESSAGE, theme: readHtmlVisualTheme() }, "*");
  }, []);

  useEffect(postTheme, [appearance, postTheme]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source === null || event.source !== frameRef.current?.contentWindow) return;
      const contentHeight = readHtmlVisualHeight(event.data);
      if (contentHeight === null) return;
      setHeight(Math.min(visual.maxHeight, Math.max(HTML_VISUAL_MIN_HEIGHT, Math.ceil(contentHeight))));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [visual.maxHeight]);

  return (
    <iframe
      ref={frameRef}
      title={visual.title}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={postTheme}
      className="block w-full border-0 bg-transparent"
      style={{ height }}
    />
  );
}
