import { MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Where the speech bubble's tail tip sits, as fractions of the marker box. Derived from lucide's
 * `MessageCircle` path (24 viewBox, tail ends near (2.4, 21.6)) plus half its 2px stroke, so
 * placement code can land the tip exactly on an anchor point.
 */
export const ANNOTATION_MARKER_TAIL_TIP = { x: 2 / 24, y: 22 / 24 } as const;

/** Props for {@link AnnotationMarker}. */
export interface AnnotationMarkerProps {
  readonly displayNumber: number;
  /** Box size and bubble colour (the bubble paints with `currentColor`). */
  readonly className?: string;
  /** Number colour and type, set apart from the bubble colour. */
  readonly numberClassName?: string;
}

/**
 * A filled speech bubble with an annotation's number centred on its round body. The bubble's
 * circle is centred in the 24 viewBox, so centring the number in the box centres it on the body.
 */
export function AnnotationMarker({ displayNumber, className, numberClassName }: AnnotationMarkerProps) {
  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center", className)}>
      <MessageCircle aria-hidden className="absolute inset-0 size-full" fill="currentColor" stroke="currentColor" />
      <span className={cn("relative font-bold leading-none tabular-nums", numberClassName)}>{displayNumber}</span>
    </span>
  );
}
