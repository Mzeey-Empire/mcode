import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { Check } from "lucide-react";
import type { Theme } from "@mcode/contracts/models/settings";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settingsStore";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";

type Scheme = "light" | "dark";

const THEMES: readonly { readonly value: Theme; readonly label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

function Bar({ width }: { readonly width: string }) {
  return <div className="h-[0.5rem] rounded-full bg-(--preview-bar)" style={{ width }} />;
}

/** A sidebar and a thread with its composer, drawn in one scheme's colours. */
function MiniWindow({ scheme, className }: { readonly scheme: Scheme; readonly className?: string }) {
  return (
    <div className={cn(`theme-preview-${scheme}`, "absolute inset-0 grid grid-cols-[30%_1fr]", className)}>
      <div className="flex flex-col gap-[9%] bg-(--preview-side) p-[10%]">
        <Bar width="70%" />
        <div className="h-[0.9rem] w-full rounded-full bg-(--preview-selected)" />
        <Bar width="60%" />
        <Bar width="80%" />
      </div>
      <div className="flex flex-col gap-[7%] bg-(--preview-main) px-[10%] pt-[10%] pb-[8%]">
        <Bar width="80%" />
        <Bar width="62%" />
        <Bar width="70%" />
        <div className="flex-1" />
        <div className="relative h-[26%] rounded-[0.6rem] bg-(--preview-composer) inset-ring inset-ring-(--preview-line)">
          <span className="absolute top-1/2 right-[7%] size-[0.9rem] -translate-y-1/2 rounded-full bg-(--preview-accent)" />
        </div>
      </div>
    </div>
  );
}

/** System is the light window with the dark one clipped to its right half. */
function ThemePreview({ theme }: { readonly theme: Theme }) {
  if (theme === "system") {
    return (
      <>
        <MiniWindow scheme="light" />
        <MiniWindow scheme="dark" className="[clip-path:inset(0_0_0_50%)]" />
      </>
    );
  }
  return <MiniWindow scheme={theme} />;
}

/**
 * The Theme choice as three window previews. Arrow keys move focus and the choice together, and Tab
 * enters and leaves the group as one stop.
 */
export function ThemeTiles() {
  const theme = useSettingsStore((s) => s.settings.appearance.theme);
  const update = useSettingsStore((s) => s.update);
  return (
    <RadioGroupPrimitive<Theme>
      aria-label="Theme"
      value={theme}
      onValueChange={(next) => void update({ appearance: { theme: next } })}
      className="grid grid-cols-[repeat(auto-fill,12.8rem)] justify-start gap-3 p-4"
    >
      {THEMES.map(({ value, label }) => (
        <RadioPrimitive.Root<Theme>
          key={value}
          value={value}
          className={cn("group/tile flex cursor-pointer flex-col items-stretch gap-2.5 rounded-lg text-left", FOCUS_RING_CLASS, "focus-visible:outline-offset-4")}
        >
          <span className="relative aspect-[16/10] overflow-hidden rounded-md ring-1 ring-border transition-shadow duration-(--duration-fast) ease-(--ease-standard) group-hover/tile:ring-muted group-data-[checked]/tile:ring-2 group-data-[checked]/tile:ring-ink">
            <ThemePreview theme={value} />
          </span>
          <span className="flex items-center gap-1.5 px-0.5 text-body-small text-muted group-data-[checked]/tile:font-medium group-data-[checked]/tile:text-ink">
            <Check aria-hidden size={14} className="hidden shrink-0 group-data-[checked]/tile:block" />
            {label}
          </span>
        </RadioPrimitive.Root>
      ))}
    </RadioGroupPrimitive>
  );
}
