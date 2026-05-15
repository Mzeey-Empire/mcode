import { memo, useMemo, lazy, Suspense } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import { resolveCodeBlockLanguage } from "@/lib/resolve-code-block-language";
import { useDiffStore } from "@/stores/diffStore";
import { isMac } from "@/lib/platform";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

/** Props for {@link MarkdownContent}. */
interface MarkdownContentProps {
  /** Raw markdown string to render. */
  content: string;
  /** When true, code blocks skip syntax highlighting. Defaults to false. */
  isStreaming?: boolean;
  /**
   * Controls prose styling. 'user' adapts colors for the primary-colored user bubble.
   * Defaults to 'assistant'.
   */
  variant?: "assistant" | "user";
}

/** Stable remark plugin list, hoisted to avoid re-creating on every render. */
const plugins = [remarkGfm];

/** Lazy-loaded MermaidBlock - only fetched when a mermaid fence is encountered. */
const LazyMermaidBlock = lazy(() => import("./MermaidBlock"));

/** Matches a standalone HTTP(S) URL (used to detect URLs inside inline code spans). */
const HTTP_URL_RE = /^https?:\/\/\S+$/;

/** Tooltip label for the Ctrl/Cmd+click preview hint. */
const previewHint = `${isMac ? "\u2318" : "Ctrl"}+click to open in preview`;

/** Whether the desktop preview bridge is available. */
function hasPreview(): boolean {
  return !!window.desktopBridge?.preview;
}

/**
 * Handles a click on a previewable URL. Opens in the browser preview panel on
 * Ctrl/Cmd+click, otherwise opens externally.
 */
function handleLinkClick(e: React.MouseEvent | React.KeyboardEvent, url: string): void {
  e.preventDefault();

  const isModifierClick = e.ctrlKey || e.metaKey;
  if (isModifierClick && hasPreview()) {
    const threadId = useWorkspaceStore.getState().activeThreadId;
    if (threadId) {
      const { showRightPanel, setRightPanelTab } = useDiffStore.getState();
      showRightPanel(threadId);
      setRightPanelTab(threadId, "preview");
      // Defer navigation so React can re-render and sync BrowserView bounds
      setTimeout(() => {
        window.desktopBridge?.preview?.navigate(url).then((r) => {
          if (!r?.ok) window.desktopBridge?.openExternalUrl?.(url);
        });
      }, 0);
      return;
    }
    // No active thread; fall through to open externally
  }

  if (window.desktopBridge?.openExternalUrl) {
    window.desktopBridge.openExternalUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Builds the static component overrides that depend on `variant`.
 * Elements whose colors differ between assistant and user bubble are variant-conditional.
 */
function makeStaticComponents(variant: "assistant" | "user") {
  const isUser = variant === "user";

  return {
    h1: ({ children }: { children?: React.ReactNode }) => <h1 className="text-xl font-bold mt-4 mb-2">{children}</h1>,
    h2: ({ children }: { children?: React.ReactNode }) => <h2 className="text-lg font-semibold mt-3 mb-2">{children}</h2>,
    h3: ({ children }: { children?: React.ReactNode }) => <h3 className="text-base font-semibold mt-2 mb-1">{children}</h3>,
    p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 leading-relaxed">{children}</p>,
    ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
    ol: ({ children }: { children?: React.ReactNode }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
    li: ({ children }: { children?: React.ReactNode }) => <li className="leading-relaxed">{children}</li>,
    strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      let safeHref: string | undefined;
      if (href) {
        try {
          const { protocol } = new URL(href);
          if (protocol === "https:" || protocol === "http:" || protocol === "mailto:") {
            safeHref = href;
          }
        } catch {
          // Invalid URL - safeHref stays undefined
        }
      }
      const linkClass = isUser
        ? "text-primary-foreground underline hover:opacity-80"
        : "text-primary underline hover:text-primary";
      const isPreviewable = safeHref && (safeHref.startsWith("http:") || safeHref.startsWith("https:"));
      const showHint = isPreviewable && hasPreview();
      const anchor = (
        <a
          href={safeHref}
          className={linkClass}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            if (!safeHref) return;
            if (isPreviewable) return handleLinkClick(e, safeHref);
            e.preventDefault();
            if (window.desktopBridge?.openExternalUrl) {
              window.desktopBridge.openExternalUrl(safeHref);
            } else {
              window.open(safeHref, "_blank", "noopener,noreferrer");
            }
          }}
        >
          {children}
        </a>
      );
      if (!showHint) return anchor;
      return (
        <Tooltip>
          <TooltipTrigger render={anchor} />
          <TooltipContent side="top" className="text-xs">{previewHint}</TooltipContent>
        </Tooltip>
      );
    },
    blockquote: ({ children }: { children?: React.ReactNode }) => (
      <blockquote
        className={
          isUser
            ? "border-l-2 pl-3 my-2 italic border-primary-foreground/40 text-primary-foreground/80"
            : "border-l-2 border-border pl-3 my-2 text-muted-foreground italic"
        }
      >
        {children}
      </blockquote>
    ),
    pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    hr: () => (
      <hr className={isUser ? "my-4 border-primary-foreground/20" : "my-4 border-border"} />
    ),
    table: ({ children }: { children?: React.ReactNode }) => (
      <div className="overflow-x-auto my-2">
        <table
          className={
            isUser
              ? "min-w-full border rounded border-primary-foreground/20"
              : "min-w-full border border-border rounded"
          }
        >
          {children}
        </table>
      </div>
    ),
    th: ({ children }: { children?: React.ReactNode }) => (
      <th
        className={
          isUser
            ? "border border-primary-foreground/20 bg-primary-foreground/10 px-3 py-1.5 text-left text-sm font-semibold"
            : "border border-border bg-muted/50 px-3 py-1.5 text-left text-sm font-semibold"
        }
      >
        {children}
      </th>
    ),
    td: ({ children }: { children?: React.ReactNode }) => (
      <td
        className={
          isUser
            ? "border border-primary-foreground/20 px-3 py-1.5 text-sm"
            : "border border-border px-3 py-1.5 text-sm"
        }
      >
        {children}
      </td>
    ),
  };
}

/**
 * Builds the `code` override that depends on `isStreaming` and `variant`.
 * Only recreated when those props change; static overrides are reused.
 */
function makeComponents(isStreaming: boolean, variant: "assistant" | "user") {
  const isUser = variant === "user";
  return {
    ...makeStaticComponents(variant),
    code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
      // Detect inline vs block code. In react-markdown's HAST, fenced code
      // blocks are wrapped in a <pre> parent (even without a language tag).
      // Fenced blocks always have a trailing newline from the code fence.
      // Check BEFORE stripping the trailing newline so even single-line
      // fenced blocks without a language are detected.
      const rawContent = String(children);
      const isInline = !className && !rawContent.includes("\n");

      if (isInline) {
        const codeClass = isUser
          ? "bg-primary-foreground/15 rounded px-1.5 py-0.5 text-sm font-mono"
          : "bg-muted rounded px-1.5 py-0.5 text-sm font-mono";

        // Detect URLs inside inline code and make them clickable
        const text = rawContent.trim();
        if (HTTP_URL_RE.test(text)) {
          const linkClass = isUser
            ? "text-primary-foreground underline decoration-dotted hover:opacity-80 cursor-pointer"
            : "text-primary underline decoration-dotted hover:text-primary cursor-pointer";
          const codeLink = (
            <code
              role="link"
              tabIndex={0}
              className={`${codeClass} ${linkClass}`}
              onClick={(e) => handleLinkClick(e, text)}
              onKeyDown={(e) => { if (e.key === "Enter") handleLinkClick(e, text); }}
            >
              {children}
            </code>
          );
          if (!hasPreview()) return codeLink;
          return (
            <Tooltip>
              <TooltipTrigger render={codeLink} />
              <TooltipContent side="top" className="text-xs">{previewHint}</TooltipContent>
            </Tooltip>
          );
        }

        return <code className={codeClass}>{children}</code>;
      }

      const langMatch = className?.match(/language-(\S+)/);
      const rawFence = langMatch ? langMatch[1] : "";

      // Suppress the fenced block the model emits to signal plan questions —
      // the wizard renders from the parsed payload, not from raw markdown.
      if (rawFence === "plan-questions") return null;

      const code = String(children).replace(/\n$/, "");

      if (rawFence === "mermaid") {
        return (
          <Suspense fallback={
            <pre className="bg-muted/30 rounded-lg p-4 overflow-x-auto"><code>{code}</code></pre>
          }>
            <LazyMermaidBlock code={code} isStreaming={isStreaming} />
          </Suspense>
        );
      }

      const { language, label } = resolveCodeBlockLanguage(rawFence, code);

      return (
        <CodeBlock
          code={code}
          language={language}
          languageLabel={label}
          isStreaming={isStreaming}
          disableHighlighting={isUser}
        />
      );
    },
  };
}

/** Renders a markdown string with GFM support. Memoized to skip re-renders when content is unchanged. */
export const MarkdownContent = memo(function MarkdownContent({
  content,
  isStreaming = false,
  variant = "assistant",
}: MarkdownContentProps) {
  const components = useMemo(() => makeComponents(isStreaming, variant), [isStreaming, variant]);

  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {content}
    </ReactMarkdown>
  );
});

export default MarkdownContent;
