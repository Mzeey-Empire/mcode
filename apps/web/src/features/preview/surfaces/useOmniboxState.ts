import { type RefObject, useCallback, useRef, useState } from "react";

/** Editable address state and input handlers. */
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

/** Preserves the draft until the synced URL changes, including after rejected navigation. */
export function useOmniboxState(url: string): OmniboxState {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState<Draft>(() => ({ sourceUrl: url, value: url, dirty: false }));
  const active = draft.sourceUrl === url ? draft : { sourceUrl: url, value: url, dirty: false };

  const onFocus = useCallback(() => {
    const valueAtFocus = inputRef.current?.value;
    // Selecting after a keystroke would highlight the typed text and let the next key overwrite it.
    requestAnimationFrame(() => {
      if (inputRef.current?.value === valueAtFocus) inputRef.current?.select();
    });
  }, []);

  const onChange = useCallback((value: string) => {
    setDraft({ sourceUrl: url, value, dirty: true });
  }, [url]);

  return { value: active.value, dirty: active.dirty, inputRef, onFocus, onChange };
}
