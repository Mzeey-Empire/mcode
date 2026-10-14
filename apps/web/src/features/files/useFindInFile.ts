import { useCallback, useDeferredValue, useMemo, useState } from "react";
import { DEFAULT_FIND_OPTIONS, findInLines, stepMatchIndex, type FindOptions, type FindResult } from "./find-in-file";

/** What the code view needs to paint matches and scroll to the current one. */
export interface FindHighlight {
  readonly result: FindResult;
  /** Index into `result.matches` of the current match. */
  readonly index: number;
  /** Bumps whenever the current match should be scrolled into view, even if `index` did not change. */
  readonly navigation: number;
}

export interface FindInFile extends FindHighlight {
  readonly query: string;
  readonly options: FindOptions;
  readonly setQuery: (query: string) => void;
  readonly toggleOption: (option: keyof FindOptions) => void;
  readonly step: (direction: 1 | -1) => void;
}

interface Cursor {
  readonly result: FindResult;
  readonly index: number;
  readonly navigation: number;
}

/** Find state for one file's lines. A new result restarts at the first match. */
export function useFindInFile(lines: readonly string[]): FindInFile {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState(DEFAULT_FIND_OPTIONS);
  const deferredQuery = useDeferredValue(query);
  const result = useMemo(() => findInLines(lines, deferredQuery, options), [lines, deferredQuery, options]);

  const [cursor, setCursor] = useState<Cursor>({ result, index: 0, navigation: 0 });
  if (cursor.result !== result) setCursor({ result, index: 0, navigation: cursor.navigation + 1 });

  const toggleOption = useCallback((option: keyof FindOptions) => setOptions((current) => ({ ...current, [option]: !current[option] })), []);
  const step = useCallback(
    (direction: 1 | -1) =>
      setCursor((current) => {
        const count = current.result.status === "ready" ? current.result.matches.length : 0;
        return { ...current, index: stepMatchIndex(current.index, direction, count), navigation: current.navigation + 1 };
      }),
    [],
  );

  return { query, options, setQuery, toggleOption, step, result, index: cursor.index, navigation: cursor.navigation };
}
