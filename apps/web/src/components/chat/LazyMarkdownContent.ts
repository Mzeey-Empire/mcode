import { lazy } from "react";

/**
 * The one lazy wrapper for {@link import("./MarkdownContent").default}. Each `lazy()` call suspends on its first
 * render even when the module already loaded, so a surface with its own wrapper flashes its raw-text fallback. Sharing
 * this one means a surface opened after the conversation rendered markdown renders it at once.
 */
export const LazyMarkdownContent = lazy(() => import("./MarkdownContent"));
