import { cn } from "@/lib/utils";

/** Splits after each separator, so a segment keeps the separator that ends it. */
const AFTER_SEPARATOR = /(?<=[\\/])/;

/**
 * A path a notice quotes in running text. It wraps only after a separator, so no folder name is cut in two. A
 * folder name wider than its line still wraps inside the name, because letting it overflow would clip the notice.
 */
export function BreakablePath({ path, className }: { readonly path: string; readonly className?: string }) {
  return (
    <span className={cn("font-code", className)}>
      {path.split(AFTER_SEPARATOR).map((segment, index) => (
        // An atomic inline box has a break opportunity on either side and none inside, so each segment stays whole.
        <span key={`${index}:${segment}`} className="inline-block max-w-full break-all">{segment}</span>
      ))}
    </span>
  );
}
