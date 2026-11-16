import { cn } from "@/lib/utils";
import { McodeMark } from "./mark/McodeMark";
import type { McodeMarkState } from "./mark/mark-svg";

/** Named size classes for each Mcode logo surface. */
export const MCODE_LOGO_SCALES = {
  sidebar: {
    root: "h-control-compact gap-1 pl-1",
    mark: "size-[2.2rem]",
    wordmark: "text-sm leading-5",
  },
} as const;

/** Known Mcode logo variants. */
export type McodeLogoVariant = keyof typeof MCODE_LOGO_SCALES;

interface McodeLogoProps {
  readonly variant?: McodeLogoVariant;
  /** Hide the wordmark when the logo acts as a quiet screen marker. */
  readonly markOnly?: boolean;
  /** Which animated state the mark shows. */
  readonly state?: McodeMarkState;
}

/** Renders the Mcode logo mark with the app wordmark. */
export function McodeLogo({ variant = "sidebar", markOnly = false, state = "quiet" }: McodeLogoProps) {
  const scale = MCODE_LOGO_SCALES[variant];

  return (
    <div
      className={cn(
        "flex select-none items-center",
        scale.root,
      )}
    >
      <McodeMark state={state} className={cn("shrink-0", scale.mark)} />
      {!markOnly && (
        <div
          aria-hidden="true"
          className={cn(
            "flex items-baseline gap-1 font-mono font-semibold leading-none text-ink",
            scale.wordmark,
          )}
        >
          <span>Mcode</span>
        </div>
      )}
    </div>
  );
}
