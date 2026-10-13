import { type RefObject, useCallback, useRef, useState } from "react";

/** The address pill's editable draft plus the input handlers that drive it. */
export interface OmniboxState {
  /** The draft while edited, else the synced URL. */
  readonly value: string;
  /** True once the user has typed since the URL last changed. */
  readonly dirty: boolean;
  /** Attach to the input so focus can select its text. */
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onFocus: () => void;
  readonly onChange: (value: string) => void;
}

interface Draft {
  readonly sourceUrl: string;
  readonly value: string;
  readonly dirty: boolean;
}

/**
 * The address pill's draft. It resets when the synced `url` changes after a
 * navigation, not on submit, so a rejected or ignored navigation keeps what the
 * user typed.
 */
export function useOmniboxState(url: string): OmniboxState {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState<Draft>(() => ({ sourceUrl: url, value: url, dirty: false }));
  const active = draft.sourceUrl === url ? draft : { sourceUrl: url, value: url, dirty: false };

  const onFocus = useCallback(() => {
    // Select after React commits the focused value, or the selection lands on stale text.
    requestAnimationFrame(() => inputRef.current?.select());
  }, []);

  const onChange = useCallback((value: string) => {
    setDraft({ sourceUrl: url, value, dirty: true });
  }, [url]);

  return { value: active.value, dirty: active.dirty, inputRef, onFocus, onChange };
}
