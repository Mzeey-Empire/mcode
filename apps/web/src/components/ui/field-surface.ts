/**
 * Paper's field recipe, shared by text inputs, textareas and select triggers so their states
 * stay in step: the selected fill, a control-border edge that shifts to muted on hover, the
 * offset focus ring, an error edge when invalid, and the panel fill at half opacity when disabled.
 */
export const FIELD_SURFACE_CLASS =
  "w-full rounded-control border border-control-border bg-selected text-body-small text-ink transition-colors duration-(--duration-fast) ease-(--ease-standard) placeholder:text-muted hover:not-aria-invalid:border-muted focus-ring aria-invalid:border-error disabled:pointer-events-none disabled:bg-panel disabled:opacity-50";

/**
 * Read-only text fields drop to the panel fill. Only editable elements use this:
 * `:read-only` matches every button, so a select trigger must not carry it.
 */
export const FIELD_READ_ONLY_CLASS = "read-only:bg-panel read-only:hover:border-control-border";
