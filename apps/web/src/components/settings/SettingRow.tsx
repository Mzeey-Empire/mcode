import { cn } from "@/lib/utils";

interface SettingRowProps {
  /** Setting display name. */
  label: string;
  /** Short description shown below the label. */
  hint?: string;
  /** JSON key path (reserved for future tooltip use). */
  configKey?: string;
  children: React.ReactNode;
  className?: string;
}

/** Responsive grid shared by standard and provider-specific setting rows. */
export const SETTING_ROW_GRID_CLASS =
  "grid gap-3 min-[80rem]:grid-cols-[minmax(0,1fr)_auto] min-[80rem]:items-center min-[80rem]:gap-x-6";

/**
 * Responsive row layout for a single setting: label + hint on the left,
 * control slot on the right. Stacks the control below the label on narrow viewports.
 */
export function SettingRow({ label, hint, children, className }: SettingRowProps) {
  return (
    <div className={cn(SETTING_ROW_GRID_CLASS, "min-h-18 content-center px-4 py-2.5", className)}>
      <div className="min-w-0">
        <span className="text-body-small font-semibold text-ink">{label}</span>
        {hint && (
          <p className="mt-0.5 max-w-[46rem] text-compact leading-[1.8rem] text-muted">
            {hint}
          </p>
        )}
      </div>
      <div className="min-w-0 min-[80rem]:justify-self-end">{children}</div>
    </div>
  );
}
