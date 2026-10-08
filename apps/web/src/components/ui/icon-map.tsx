import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Diff,
  Ellipsis,
  ExternalLink,
  Files,
  GitBranch,
  GitFork,
  GitPullRequest,
  Globe,
  Hammer,
  Info,
  ListChecks,
  PanelLeft,
  PanelRight,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  RotateCw,
  Search,
  Settings,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Product icon stroke from DESIGN.md Iconography. The `.lucide` rule in
 * `index.css` applies the same value to direct Lucide imports.
 */
export const ICON_STROKE_WIDTH = 1.5;

/** The compact icon role: toolbar, menu, input, row and round-button icons. */
export const ICON_SIZE = 16;

/** Props of a product icon. The stroke is fixed so state never changes icon weight. */
export type ProductIconProps = Omit<ComponentPropsWithRef<LucideIcon>, "strokeWidth" | "absoluteStrokeWidth">;

interface ProductIconOptions {
  /** Directional glyphs flip in right-to-left layouts; object glyphs do not. */
  mirrorInRtl?: boolean;
}

function productIcon(Glyph: LucideIcon, { mirrorInRtl = false }: ProductIconOptions = {}) {
  function ProductIcon({ className, size = ICON_SIZE, ...props }: ProductIconProps) {
    return (
      <Glyph
        {...props}
        size={size}
        strokeWidth={ICON_STROKE_WIDTH}
        className={cn(mirrorInRtl && "rtl:-scale-x-100", className)}
      />
    );
  }
  ProductIcon.displayName = Glyph.displayName;
  return ProductIcon;
}

/** Add or create. */
export const AddIcon = productIcon(Plus);
/** Close or dismiss. */
export const CloseIcon = productIcon(X);
/** Search. */
export const SearchIcon = productIcon(Search);
/** Settings. */
export const SettingsIcon = productIcon(Settings);
/** More actions. */
export const MoreIcon = productIcon(Ellipsis);
/** Expand or next. */
export const ExpandIcon = productIcon(ChevronRight, { mirrorInRtl: true });
/** Collapse or disclose. */
export const CollapseIcon = productIcon(ChevronDown);
/** Back. */
export const BackIcon = productIcon(ArrowLeft, { mirrorInRtl: true });
/** Submit or send. */
export const SendIcon = productIcon(ArrowUp);
/** Retry or refresh. */
export const RetryIcon = productIcon(RotateCw);
/** Copy. */
export const CopyIcon = productIcon(Copy);
/** Edit. */
export const EditIcon = productIcon(Pencil);
/** Delete. */
export const DeleteIcon = productIcon(Trash2);
/** Confirmed. */
export const ConfirmedIcon = productIcon(Check);
/** Warning. */
export const WarningIcon = productIcon(TriangleAlert);
/** Error. */
export const ErrorIcon = productIcon(CircleAlert);
/** Information. */
export const InfoIcon = productIcon(Info);
/** Terminal. */
export const TerminalIcon = productIcon(SquareTerminal);
/** Browser. */
export const BrowserIcon = productIcon(Globe);
/** Review. */
export const ReviewIcon = productIcon(Diff);
/** Files. */
export const FilesIcon = productIcon(Files);
/** Git branch. */
export const BranchIcon = productIcon(GitBranch);
/** Fork. */
export const ForkIcon = productIcon(GitFork);
/** Pull request. */
export const PullRequestIcon = productIcon(GitPullRequest);
/** Open externally. */
export const OpenExternalIcon = productIcon(ExternalLink);
/** Toggle sidebar. */
export const SidebarIcon = productIcon(PanelLeft);
/** Toggle right panel. */
export const RightPanelIcon = productIcon(PanelRight);
/** Pin. */
export const PinIcon = productIcon(Pin);
/** Attachment. */
export const AttachmentIcon = productIcon(Paperclip);
/** Plan. */
export const PlanIcon = productIcon(ListChecks);
/** Build or run. */
export const BuildIcon = productIcon(Hammer);
