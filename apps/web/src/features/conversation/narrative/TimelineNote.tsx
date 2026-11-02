import { RotateCcw } from "lucide-react";

/** A centered divider line carrying one short timeline note. */
export function TimelineNote({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 py-2" role="note">
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <RotateCcw size={12} aria-hidden="true" />
        <span>{text}</span>
      </div>
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
