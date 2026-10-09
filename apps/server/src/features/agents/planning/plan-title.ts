/** Uses the first prose H1, retaining a readable fallback for headingless plans. */
export function planTitle(content: string): string {
  let firstHeading: string | undefined;
  let firstProse: string | undefined;
  for (const line of proseLines(content)) {
    if (line.trim()) firstProse ??= line.trim();
    const heading = /^ {0,3}(#{1,3})[ \t]+(.+)/.exec(line);
    if (!heading) continue;
    const title = heading[2].replace(/\s+#+\s*$/, "").trim();
    if (!title) continue;
    if (heading[1] === "#") return title.slice(0, 200);
    firstHeading ??= title;
  }
  return (firstHeading ?? firstProse ?? "Plan").slice(0, 200);
}

function* proseLines(content: string): Generator<string> {
  let fence: { marker: string; length: number } | undefined;
  for (const line of content.split("\n")) {
    const code = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (code) {
      if (!fence) fence = { marker: code[1][0], length: code[1].length };
      else if (code[1][0] === fence.marker && code[1].length >= fence.length && !code[2].trim()) fence = undefined;
      continue;
    }
    if (!fence) yield line;
  }
}
