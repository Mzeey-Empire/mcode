import { RefreshCw } from "lucide-react";
import { FilesPanel, type FilesPanelProps } from "@/components/files/FilesPanel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { FilesNavigator, type FilesNavigatorModel } from "./FilesNavigator";

/** Props for the Files navigator docked beside a Review diff. */
export interface FilesDockedPaneProps extends FilesNavigatorModel {
  readonly onClose: () => void;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number | string;
  readonly defaultWidth: number;
  readonly wideWidth: number;
  readonly getMaxWidth: NonNullable<FilesPanelProps["getMaxWidth"]>;
  readonly onWidthChange: NonNullable<FilesPanelProps["onWidthChange"]>;
  readonly onCollapseRequest?: () => void;
}

/** The resizable Files pane that docks beside the diff once the panel is wide enough. */
export function FilesDockedPane({
  onClose,
  refreshing,
  onRefresh,
  width,
  minWidth,
  maxWidth,
  defaultWidth,
  wideWidth,
  getMaxWidth,
  onWidthChange,
  onCollapseRequest,
  ...navigator
}: FilesDockedPaneProps) {
  return (
    <FilesPanel
      title="Files"
      count={navigator.files.length}
      ariaLabel="Files"
      testId="dev-worktree-files-pane"
      onClose={onClose}
      width={width}
      minWidth={minWidth}
      maxWidth={maxWidth}
      defaultWidth={defaultWidth}
      wideWidth={wideWidth}
      getMaxWidth={getMaxWidth}
      onWidthChange={onWidthChange}
      onCollapseRequest={onCollapseRequest}
    >
      <FilesNavigator
        {...navigator}
        trailing={
          <Button
            type="button"
            variant="ghost"
            size="icon-compact"
            aria-label="Refresh comparison"
            disabled={refreshing}
            onClick={onRefresh}
            className="ml-1 h-7 w-7 shrink-0 text-muted"
          >
            {refreshing ? <Spinner size={12} /> : <RefreshCw size={12} aria-hidden="true" />}
          </Button>
        }
      />
    </FilesPanel>
  );
}
