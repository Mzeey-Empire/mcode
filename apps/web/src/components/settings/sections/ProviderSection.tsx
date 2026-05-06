import { useState } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { SettingRow } from "../SettingRow";
import { SectionHeading } from "../SectionHeading";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProviderAvailability, ProviderId } from "@mcode/contracts";
import { ConfirmDisableDialog } from "./ConfirmDisableDialog";

/** Provider IDs that expose a CLI path input field. */
type CliProvider = "claude" | "codex" | "copilot" | "cursor";
const HAS_CLI_INPUT: readonly CliProvider[] = ["claude", "codex", "copilot", "cursor"];

/** Narrows a ProviderId to those that have an editable CLI path setting. */
function hasCliInput(id: ProviderId): id is CliProvider {
  return (HAS_CLI_INPUT as readonly string[]).includes(id);
}

/**
 * Settings section for enabling AI providers and configuring their CLI paths.
 * Renders one toggle row per provider. When a provider is enabled, a CLI path
 * input is shown below it (for providers that have CLI binaries).
 */
export function ProviderSection() {
  const providers = useProviderAvailabilityStore((s) => s.providers);
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const [pendingDisable, setPendingDisable] = useState<ProviderId | null>(null);

  // Count how many adapter-backed providers are currently enabled, so we can
  // prevent the user from disabling the last one.
  const enabledCount = providers.filter((p) => p.enabled && p.hasAdapter).length;

  async function flipEnabled(id: ProviderId, next: boolean) {
    if (!next) {
      // Block turning off the last enabled adapter-backed provider.
      const isLastEnabled = enabledCount === 1 && providers.find((p) => p.id === id)?.enabled;
      if (isLastEnabled) return;

      // Warn before disabling a provider that is currently set as the default.
      const isDefault =
        settings.model.defaults.provider === id || settings.model.utility.provider === id;
      if (isDefault) {
        setPendingDisable(id);
        return;
      }
    }
    await update({ provider: { enabled: { [id]: next } } });
  }

  return (
    <div>
      <SectionHeading>Provider</SectionHeading>
      <div>
        {providers.map((p) => (
          <ProviderRow
            key={p.id}
            row={p}
            isLastEnabled={enabledCount === 1 && p.enabled && p.hasAdapter}
            onToggle={(next) => flipEnabled(p.id, next)}
            cliPath={hasCliInput(p.id) ? settings.provider.cli[p.id] : undefined}
            onCliPathChange={
              hasCliInput(p.id)
                ? (val: string) => void update({ provider: { cli: { [p.id]: val } } })
                : undefined
            }
          />
        ))}
      </div>
      {pendingDisable && (
        <ConfirmDisableDialog
          providerId={pendingDisable}
          onCancel={() => setPendingDisable(null)}
          onConfirm={async () => {
            setPendingDisable(null);
          }}
        />
      )}
    </div>
  );
}

interface ProviderRowProps {
  /** Availability and configuration snapshot for this provider. */
  row: ProviderAvailability;
  /** True when this is the only enabled adapter-backed provider. */
  isLastEnabled: boolean;
  /** Called when the user flips the enable toggle. */
  onToggle: (next: boolean) => void | Promise<void>;
  /** Current CLI path setting value; undefined for providers without CLI path config. */
  cliPath: string | undefined;
  /** Called when the user edits the CLI path; undefined when no CLI path config exists. */
  onCliPathChange?: (v: string) => void;
}

/**
 * Single provider row: label, status badges, enable switch, and optional CLI path input.
 * The CLI path input is rendered only when the provider is enabled and has a configurable path.
 */
function ProviderRow({ row, isLastEnabled, onToggle, cliPath, onCliPathChange }: ProviderRowProps) {
  // Coming-soon and adapter-less providers cannot be toggled; the last enabled
  // provider also blocks toggling to prevent an unusable state.
  const switchDisabled = row.comingSoon || !row.hasAdapter || isLastEnabled;

  return (
    <>
      <SettingRow
        label={labelFor(row.id)}
        hint={hintFor(row, isLastEnabled)}
      >
        <div className="flex items-center gap-2">
          {row.beta && (
            <Tooltip>
              <TooltipTrigger>
                <Badge variant="secondary" data-testid={`provider-badge-${row.id}-beta`}>
                  Beta
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                This provider is in early phase. Expect bugs or incomplete features.
              </TooltipContent>
            </Tooltip>
          )}
          {row.comingSoon && (
            <Badge variant="outline" data-testid={`provider-badge-${row.id}-comingsoon`}>
              Coming soon
            </Badge>
          )}
          {row.enabled && row.cli.status === "not_found" && (
            <Tooltip>
              <TooltipTrigger>
                <Badge variant="destructive" data-testid={`provider-badge-${row.id}-cli-missing`}>
                  CLI not found
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                Tried:{" "}
                {row.cli.configuredPath ? row.cli.configuredPath : "PATH lookup"}. Install
                the CLI or set the path below.
              </TooltipContent>
            </Tooltip>
          )}
          <Switch
            data-testid={`provider-switch-${row.id}`}
            checked={row.enabled && row.hasAdapter}
            disabled={switchDisabled}
            onCheckedChange={onToggle}
          />
        </div>
      </SettingRow>
      {row.enabled && onCliPathChange && (
        <SettingRow label={`${labelFor(row.id)} CLI path`} className="pl-6">
          <Input
            data-testid={`provider-cli-path-${row.id}`}
            value={cliPath ?? ""}
            onChange={(e) => onCliPathChange(e.target.value)}
            placeholder={row.id}
            className="h-7 w-56 text-xs"
          />
        </SettingRow>
      )}
    </>
  );
}

/** Returns the human-readable display name for a provider ID. */
function labelFor(id: ProviderId): string {
  if (id === "copilot") return "GitHub Copilot";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Returns the hint text shown below the provider label. */
function hintFor(row: ProviderAvailability, isLastEnabled: boolean): string {
  if (isLastEnabled) return "At least one provider must be enabled.";
  if (row.comingSoon) return "Adapter not available yet.";
  if (row.enabled && row.cli.status === "not_found") {
    return `CLI not found${row.cli.configuredPath ? ` at ${row.cli.configuredPath}` : ""}.`;
  }
  return "";
}
