import { useEffect, useState } from "react";
import { getTransport } from "@/transport";

/** Text of an SVG for its Source view. */
export type SvgSourceState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly content: string }
  | { readonly status: "failed"; readonly message: string };

/** Reads an SVG as text, only while `active`; the regular read returns it as an image URL. */
export function useSvgSource(workspaceId: string, threadId: string | null, path: string, active: boolean): SvgSourceState {
  const key = JSON.stringify([workspaceId, threadId, path]);
  // Keyed by what was read, so a path change shows "loading" without a synchronous reset in the effect.
  const [read, setRead] = useState<{ readonly key: string; readonly state: SvgSourceState } | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    getTransport()
      .readFileContent(workspaceId, path, threadId ?? undefined, "text")
      .then(
        (result): SvgSourceState =>
          result.kind === "text" ? { status: "ready", content: result.content } : { status: "failed", message: "Couldn't read source" },
        (error: unknown): SvgSourceState => ({ status: "failed", message: error instanceof Error ? error.message : String(error) }),
      )
      .then((next) => !cancelled && setRead({ key, state: next }));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, threadId, path, active, key]);
  if (!active) return { status: "idle" };
  return read?.key === key ? read.state : { status: "loading" };
}
