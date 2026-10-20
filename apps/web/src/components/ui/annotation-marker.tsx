import { MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/** Approximate tail anchor as fractions of the marker box, including Lucide's default 2px stroke. */
export const ANNOTATION_MARKER_TAIL_TIP = { x: 2 / 24, y: 22 / 24 } as const;

/** Props for {@link AnnotationMarker}. */
export interface AnnotationMarkerProps {
  readonly displayNumber: number;
  /** Box size and bubble colour (the bubble paints with `currentColor`). */
  readonly className?: string;
  /** Number colour and type, set apart from the bubble colour. */
  readonly numberClassName?: string;
}

/** A filled speech bubble with an annotation's number centred on its round body. */
export function AnnotationMarker({ displayNumber, className, numberClassName }: AnnotationMarkerProps) {
  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center", className)}>
      <MessageCircle aria-hidden className="absolute inset-0 size-full" fill="currentColor" stroke="currentColor" />
      <span className={cn("relative font-bold leading-none tabular-nums", numberClassName)}>{displayNumber}</span>
    </span>
  );
}
