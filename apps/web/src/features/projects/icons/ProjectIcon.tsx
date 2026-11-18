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

/**
 * Two-letter fallback for a tinted badge: the first letters of the first two words of a
 * multi-word name ("orderwise-sync" reads "OS"), else the first two letters ("mcode" reads "Mc").
 */
export function projectInitials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length > 1) return words.slice(0, 2).map(projectMonogram).join("");
  const letters = [...graphemes.segment(words[0] ?? "")].map((part) => part.segment);
  return `${(letters[0] ?? "").toLocaleUpperCase()}${(letters[1] ?? "").toLocaleLowerCase()}`;
}

/** A stable hue from 0 to 359 for a project id, so its tinted badge keeps one colour everywhere. */
export function projectHue(workspaceId: string): number {
  let hash = 0;
  for (const char of workspaceId) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hash;
}

/** Props for {@link ProjectIcon}. */
export interface ProjectIconProps {
  workspaceId: string;
  /** Project name; its initials are the fallback badge text. */
  name: string;
  size: ProjectIconSize;
  className?: string;
}

/** A project's icon image, or a hue-tinted badge with its initials when it has none or the image fails to load. */
export function ProjectIcon({ workspaceId, name, size, className }: ProjectIconProps) {
  const icon = useProjectIconStore((state) => state.iconsByWorkspaceId[workspaceId]);
  const src = icon && icon.source !== "none" ? buildServerImageUrl(icon.url) : null;
  const hue = projectHue(workspaceId);
  const style = { width: size, height: size, borderRadius: RADIUS_BY_SIZE[size] };
  // Keyed by src so a new version gets a fresh load attempt after an earlier one failed.
  return src
    ? <ProjectIconImage key={src} src={src} name={name} size={size} style={style} className={className} hue={hue} />
    : <ProjectMonogram name={name} size={size} style={style} className={className} hue={hue} />;
}

interface TileProps {
  name: string;
  size: ProjectIconSize;
  style: React.CSSProperties;
  className?: string;
  hue: number;
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

function ProjectMonogram({ name, size, style, className, hue }: TileProps) {
  const tintStyle: React.CSSProperties & { "--project-hue": number } = { ...style, fontSize: Math.round(size / 2), "--project-hue": hue };
  return (
    <span
      aria-hidden
      data-testid="project-monogram"
      style={tintStyle}
      className={cn("project-badge inline-flex shrink-0 select-none items-center justify-center font-semibold leading-none", className)}
    >
      {projectInitials(name)}
    </span>
  );
}
