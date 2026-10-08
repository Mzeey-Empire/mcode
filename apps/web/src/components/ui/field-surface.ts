import { FOCUS_RING_CLASS } from "./focus-ring";

/**
 * Paper's field recipe, shared by text inputs, textareas and select triggers so their states
 * stay in step: the field fill, a control-border edge that shifts to muted on hover, the
 * offset focus ring, an error edge when invalid, and the panel fill at half opacity when disabled.
 * State variants stay one level deep so a caller's `hover:` or `focus-visible:` class replaces
 * them; only the invalid hover goes deeper, so the error edge outlasts the hover.
 */
export const FIELD_SURFACE_CLASS = `w-full rounded-control border border-control-border bg-field text-body-small text-ink transition-colors duration-(--duration-fast) ease-(--ease-standard) placeholder:text-muted hover:border-muted aria-invalid:border-error aria-invalid:hover:border-error disabled:pointer-events-none disabled:bg-panel disabled:opacity-50 ${FOCUS_RING_CLASS}`;

/**
 * Read-only text fields drop to the panel fill. Only editable elements use this:
 * `:read-only` matches every button, so a select trigger must not carry it.
 */
export const FIELD_READ_ONLY_CLASS = "read-only:bg-panel";
