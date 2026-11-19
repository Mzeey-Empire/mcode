import { useId, type ReactNode } from "react";
import type { SettingsGroupRef } from "./setting-def";

/** Props for a visually grouped set of related settings. */
export interface SettingsGroupProps {
  /** Named group shared with the page's setting definitions; supplies title and description. */
  group?: SettingsGroupRef;
  /** Heading that identifies the settings group; a page's only group may go without one. */
  title?: string;
  /** Short explanation of what the group controls. */
  description?: string;
  /** Muted caption at the heading's right end, such as where else the group's values are set. */
  aside?: ReactNode;
  /** Setting rows rendered inside the group surface. */
  children: ReactNode;
}

function GroupHeading({ id, title, aside }: { readonly id: string; readonly title: string; readonly aside: ReactNode }) {
  return (
    // At 900px and narrower the caption moves under the heading, as in the approved prototype; Tailwind's max-* excludes its bound.
    <div className="flex items-baseline justify-between gap-3 max-[901px]:flex-col max-[901px]:gap-0.5">
      <h2 id={id} className="text-body-small font-semibold text-ink">
        {title}
      </h2>
      {aside ? <span className="text-caption text-muted">{aside}</span> : null}
    </div>
  );
}

/**
 * Renders a settings group: an optional heading over a panel whose rows are split by hairlines.
 * The first and last rows take the panel's corners so a row's hover fill never squares them off.
 */
export function SettingsGroup({
  group,
  title = group?.title,
  description = group?.description,
  aside,
  children,
}: SettingsGroupProps) {
  const headingId = useId();

  return (
    <section aria-labelledby={title ? headingId : undefined}>
      {(title || description) && (
        <div className="mb-2 px-1">
          {title && <GroupHeading id={headingId} title={title} aside={aside} />}
          {description && (
            <p className="mt-0.5 max-w-[56rem] text-caption text-muted">
              {description}
            </p>
          )}
        </div>
      )}
      <div className="divide-y divide-border rounded-lg bg-panel inset-ring inset-ring-border [&>:first-child]:rounded-t-lg [&>:last-child]:rounded-b-lg">
        {children}
      </div>
    </section>
  );
}
