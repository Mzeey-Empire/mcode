import { useState } from "react";
import { cn } from "@/lib/utils";
import { buildServerImageUrl } from "@/lib/server-image-url";
import { useProjectIconStore } from "./projectIconStore";

/** Sizes used by the sidebar, breadcrumb, chooser, and settings surfaces. */
export type ProjectIconSize = 14 | 16 | 20 | 40;

const RADIUS_BY_SIZE: Record<ProjectIconSize, number> = { 14: 3, 16: 4, 20: 4, 40: 10 };

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** First user-perceived character of a project name, upper-cased, so "élan" shows "É" rather than a bare accent. */
export function projectMonogram(name: string): string {
  const first = graphemes.segment(name.trim())[Symbol.iterator]().next();
  return first.done ? "?" : first.value.segment.toLocaleUpperCase();
}

/** Props for {@link ProjectIcon}. */
export interface ProjectIconProps {
  workspaceId: string;
  /** Project name; its first character is the fallback monogram. */
  name: string;
  size: ProjectIconSize;
  className?: string;
}

/** A project's icon image, or a monogram tile when it has none or the image fails to load. */
export function ProjectIcon({ workspaceId, name, size, className }: ProjectIconProps) {
  const icon = useProjectIconStore((state) => state.iconsByWorkspaceId[workspaceId]);
  const src = icon && icon.source !== "none" ? buildServerImageUrl(icon.url) : null;
  const style = { width: size, height: size, borderRadius: RADIUS_BY_SIZE[size] };
  // Keyed by src so a new version gets a fresh load attempt after an earlier one failed.
  return src
    ? <ProjectIconImage key={src} src={src} name={name} size={size} style={style} className={className} />
    : <ProjectMonogram name={name} size={size} style={style} className={className} />;
}

interface TileProps {
  name: string;
  size: ProjectIconSize;
  style: React.CSSProperties;
  className?: string;
}

function ProjectIconImage({ src, ...tile }: TileProps & { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ProjectMonogram {...tile} />;
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFailed(true)}
      style={tile.style}
      className={cn("shrink-0 object-contain", tile.className)}
    />
  );
}

function ProjectMonogram({ name, size, style, className }: TileProps) {
  return (
    <span
      aria-hidden
      data-testid="project-monogram"
      style={{ ...style, fontSize: size === 40 ? 18 : Math.round(size * 0.6) }}
      className={cn("inline-flex shrink-0 select-none items-center justify-center bg-primary leading-none text-primary-ink", size === 40 ? "font-bold" : "font-semibold", className)}
    >
      {projectMonogram(name)}
    </span>
  );
}
