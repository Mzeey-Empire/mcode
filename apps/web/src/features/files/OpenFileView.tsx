import { CodeFileView, CodeLines } from "./CodeFileView";
import { fileViewKind } from "./file-view-kind";
import type { FileViewMode, ImageScale } from "./filesTabsStore";
import { ImageFileView, type ImageDimensions, type ImageReadResult } from "./ImageFileView";
import { MarkdownFileView } from "./MarkdownFileView";
import type { FileReadState } from "./useFilesData";
import { useSvgSource } from "./useSvgSource";

/** Props for {@link OpenFileView}. */
export interface OpenFileViewProps {
  readonly workspaceId: string;
  readonly threadId: string | null;
  readonly path: string;
  readonly state: FileReadState;
  readonly mode: FileViewMode;
  readonly scale: ImageScale;
  readonly knownPaths: ReadonlySet<string>;
  readonly pathsTruncated: boolean;
  readonly onOpenFile: (path: string) => void;
  readonly onDimensions: (dimensions: ImageDimensions) => void;
  readonly onOpenInEditor: (line?: number) => void;
  readonly onCloseTab: () => void;
}

/** The Files body for the active tab, chosen by {@link fileViewKind}. */
export function OpenFileView(props: OpenFileViewProps) {
  const { path, state } = props;
  const kind = fileViewKind(path, state);
  if (state.status === "ready" && state.result.kind === "text" && kind === "markdown") {
    return (
      <MarkdownFileView
        path={path}
        content={state.result.content}
        mode={props.mode}
        knownPaths={props.knownPaths}
        pathsTruncated={props.pathsTruncated}
        onOpenFile={props.onOpenFile}
      />
    );
  }
  if (state.status === "ready" && state.result.kind === "image") {
    if (kind === "svg") return <SvgFileView {...props} result={state.result} />;
    return <ImageFileView key={path} result={state.result} scale={props.scale} onDimensions={props.onDimensions} />;
  }
  return <CodeFileView path={path} state={state} onOpenInEditor={props.onOpenInEditor} onCloseTab={props.onCloseTab} />;
}

function SvgFileView({ workspaceId, threadId, path, mode, scale, onDimensions, result }: OpenFileViewProps & { readonly result: ImageReadResult }) {
  const source = useSvgSource(workspaceId, threadId, path, mode === "source");
  if (mode === "rendered") return <ImageFileView key={path} result={result} scale={scale} onDimensions={onDimensions} />;
  if (source.status === "ready") return <CodeLines path={path} content={source.content} changedLines={null} />;
  const text = source.status === "failed" ? source.message : "Loading…";
  return <p className="px-4 py-3 font-mono text-code-small text-muted">{text}</p>;
}
