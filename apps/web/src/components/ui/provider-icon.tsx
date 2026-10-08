import type { ComponentType } from "react";
import type { SettingsProviderId } from "@mcode/contracts";
import {
  ClaudeIcon,
  CodexIcon,
  CopilotIcon,
  CursorProviderIcon,
  DevinIcon,
  GeminiIcon,
  OpenCodeIcon,
} from "@/components/chat/ProviderIcons";
import { cn } from "@/lib/utils";

/**
 * Provider icon sizes. 16 and 20 are the product roles; 12 is the mark inside
 * a disc and in dense rows that their section tickets have not restyled yet.
 */
export type ProviderIconSize = 12 | 16 | 20;

// A size class, not only width and height attributes: parents such as Button
// size every descendant SVG that lacks a `size-*` class.
const SIZE_CLASS: Record<ProviderIconSize, string> = {
  12: "size-3",
  16: "size-4",
  20: "size-5",
};

type ProviderMark = ComponentType<{ size?: number; className?: string }>;

const PROVIDER_MARKS: Record<SettingsProviderId, ProviderMark> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  copilot: CopilotIcon,
  cursor: CursorProviderIcon,
  devin: DevinIcon,
  gemini: GeminiIcon,
  opencode: OpenCodeIcon,
};

// An own-key check, so ids such as "toString" do not resolve to prototype members.
function isKnownProvider(provider: string): provider is SettingsProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDER_MARKS, provider);
}

function providerMark(provider: string): ProviderMark | undefined {
  return isKnownProvider(provider) ? PROVIDER_MARKS[provider] : undefined;
}

/** Props for {@link ProviderIcon}. */
export interface ProviderIconProps {
  /** Provider id, for example `"claude"` or `"codex"`. Thread rows carry it as a plain string. */
  provider: string;
  size?: ProviderIconSize;
  className?: string;
}

/**
 * The one way to show a provider. Renders the provider's authentic mark with no
 * recolour: monochrome marks are ink even inside muted text, Claude keeps its
 * own fill.
 * An unknown id renders a muted placeholder ring of the same size so rows keep
 * their alignment.
 */
export function ProviderIcon({ provider, size = 16, className }: ProviderIconProps) {
  const Mark = providerMark(provider);
  if (!Mark) {
    return (
      <span
        aria-hidden
        data-provider-icon="unknown"
        className={cn("inline-block shrink-0 rounded-full border border-muted/60", SIZE_CLASS[size], className)}
      />
    );
  }
  return (
    <span aria-hidden data-provider-icon={provider} className={cn("inline-flex shrink-0 text-ink", className)}>
      <Mark size={size} className={SIZE_CLASS[size]} />
    </span>
  );
}

const DISC_SIZE_PX = 20;
const DISC_STEP_PX = 12;

/** Props for {@link ProviderDiscStack}. */
export interface ProviderDiscStackProps {
  /** One provider id per subagent, in display order. Only the first `max` render. */
  providers: readonly string[];
  max?: number;
  className?: string;
}

/**
 * Overlapping provider discs for overview rows. Shows at most `max` discs; the
 * text beside the stack carries the total, so the stack is decorative.
 */
export function ProviderDiscStack({ providers, max = 3, className }: ProviderDiscStackProps) {
  const visible = providers.slice(0, max);
  if (visible.length === 0) return null;
  return (
    <span
      aria-hidden
      data-testid="provider-disc-stack"
      className={cn("relative block shrink-0", className)}
      style={{ width: DISC_SIZE_PX + DISC_STEP_PX * (visible.length - 1), height: DISC_SIZE_PX }}
    >
      {visible.map((provider, index) => (
        <span
          // Providers repeat within a stack, so the position is the identity.
          key={index}
          data-testid="provider-disc"
          className="absolute top-0 flex size-5 items-center justify-center rounded-full border-[1.5px] border-panel bg-selected"
          style={{ left: DISC_STEP_PX * index }}
        >
          <ProviderIcon provider={provider} size={12} />
        </span>
      ))}
    </span>
  );
}
