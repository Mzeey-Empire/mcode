import { useState, type ComponentType, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { SETTING_ROW_GRID_CLASS, SEARCH_HIT_CLASS, Setting, SettingRowFrame, useSettingHit } from "../Setting";
import { settingsGroup, settingsPage, type SettingDef, type SettingId, type SettingInput, type SettingRowProps } from "../setting-def";
import { SettingsGroup } from "../SettingsGroup";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { getCatalogEntry, PROVIDER_CATALOG } from "@mcode/contracts/providers/catalog";
import { getDefaultSettings, PartialSettingsSchema } from "@mcode/contracts/models/settings";
import { type ProviderAvailability } from "@mcode/contracts/providers/availability";
import { type ProviderId } from "@mcode/contracts/providers/interfaces";
import { ConfirmDisableDialog } from "./ConfirmDisableDialog";

/** Provider IDs that expose a CLI path input field, read from the settings schema so a new CLI key needs no list edit. */
type CliProvider = keyof ReturnType<typeof getDefaultSettings>["provider"]["cli"];
const CLI_PROVIDERS = new Set<string>(Object.keys(getDefaultSettings().provider.cli));

/** Narrows a ProviderId to those that have an editable CLI path setting. */
function hasCliInput(id: ProviderId): id is CliProvider {
  return CLI_PROVIDERS.has(id);
}

/**
 * Enable switch state for every provider, shared by the page and search results so both
 * keep the last-provider guard and the confirmation before disabling a default provider.
 */
function useProviderToggle(): {
  readonly isLastEnabled: (row: ProviderAvailability) => boolean;
  readonly flip: (id: ProviderId, next: boolean) => Promise<void>;
  readonly dialog: ReactNode;
} {
  const providers = useProviderAvailabilityStore((s) => s.providers);
  const defaultProvider = useSettingsStore((s) => s.settings.model.defaults.provider);
  const utilityProvider = useSettingsStore((s) => s.settings.model.utility.provider);
  const update = useSettingsStore((s) => s.update);
  const [pendingDisable, setPendingDisable] = useState<ProviderId | null>(null);
  // Count how many adapter-backed providers are currently enabled, so we can
  // prevent the user from disabling the last one.
  const enabledCount = providers.filter((p) => p.enabled && p.hasAdapter).length;

  async function flip(id: ProviderId, next: boolean) {
    if (!next) {
      // Block turning off the last enabled adapter-backed provider.
      const isLastEnabled = enabledCount === 1 && providers.find((p) => p.id === id)?.enabled;
      if (isLastEnabled) return;

      // Warn before disabling a provider that is currently set as the default.
      if (defaultProvider === id || utilityProvider === id) {
        setPendingDisable(id);
        return;
      }
    }
    await update({ provider: { enabled: { [id]: next } } });
  }

  return {
    isLastEnabled: (row) => enabledCount === 1 && row.enabled && row.hasAdapter,
    flip,
    dialog: pendingDisable ? (
      <ConfirmDisableDialog
        providerId={pendingDisable}
        onCancel={() => setPendingDisable(null)}
        onConfirm={async () => {
          setPendingDisable(null);
        }}
      />
    ) : null,
  };
}

function useAvailability(id: ProviderId): ProviderAvailability | undefined {
  return useProviderAvailabilityStore((s) => s.providers.find((row) => row.id === id));
}

function ProviderControls({ row, switchDisabled, onToggle }: { row: ProviderAvailability; switchDisabled: boolean; onToggle: (next: boolean) => void | Promise<void> }) {
  return <div className="flex items-center gap-2 min-[80rem]:min-w-[9.2rem] min-[80rem]:justify-end">
    {row.beta && <Tooltip><TooltipTrigger><Badge variant="secondary" data-testid={`provider-badge-${row.id}-beta`}>Beta</Badge></TooltipTrigger><TooltipContent>This provider is in early phase. Expect bugs or incomplete features.</TooltipContent></Tooltip>}
    {row.enabled && row.cli.status === "not_found" && <Tooltip><TooltipTrigger><Badge variant="destructive" data-testid={`provider-badge-${row.id}-cli-missing`}>CLI not found</Badge></TooltipTrigger><TooltipContent>{row.cli.message ?? "Install the CLI or set the path below."}</TooltipContent></Tooltip>}
    <Switch data-testid={`provider-switch-${row.id}`} aria-label={`${labelFor(row.id)} enabled`} checked={row.enabled && row.hasAdapter} disabled={switchDisabled} onCheckedChange={onToggle} />
  </div>;
}

function CliPathInput({ id }: { id: CliProvider }) {
  const cliPath = useSettingsStore((s) => s.settings.provider.cli[id]);
  const update = useSettingsStore((s) => s.update);
  return <Input id={`provider-cli-path-${id}`} data-testid={`provider-cli-path-${id}`} aria-label={`${labelFor(id)} CLI path`} value={cliPath ?? ""} onChange={(event) => void update({ provider: { cli: { [id]: event.target.value } } })} placeholder={id} className="h-7 w-56 text-xs" />;
}

/** The CLI path line inside a provider's disclosure. */
function CliPathField({ def, id }: { def: SettingDef; id: CliProvider }) {
  const hit = useSettingHit([def]);
  return <div ref={hit.ref} {...hit.attrs} data-setting-id={def.id} className={cn(SETTING_ROW_GRID_CLASS, SEARCH_HIT_CLASS, "mt-3 border-t border-border pt-3 pl-2")}><label htmlFor={`provider-cli-path-${id}`} className="text-sm font-medium text-ink">{def.label}</label><CliPathInput id={id} /></div>;
}

/** Parse a serve URL draft through the settings contract; null when it would be rejected. */
function parseServeUrlDraft(draft: string): string | null {
  const parsed = PartialSettingsSchema().safeParse({ provider: { opencode: { serveUrl: draft } } });
  return parsed.success ? (parsed.data.provider?.opencode?.serveUrl ?? "") : null;
}

/**
 * OpenCode serve URL editor. Commits on blur or Enter rather than per
 * keystroke, because a half-typed URL fails validation and would be dropped.
 */
function OpenCodeServeUrlField({ def }: { def: SettingDef }) {
  const saved = useSettingsStore((s) => s.settings.provider.opencode.serveUrl);
  const update = useSettingsStore((s) => s.update);
  const [draft, setDraft] = useState(saved);
  const [invalid, setInvalid] = useState(false);
  const hit = useSettingHit([def]);

  const commit = () => {
    const normalized = parseServeUrlDraft(draft);
    if (normalized === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(normalized);
    if (normalized !== saved) void update({ provider: { opencode: { serveUrl: normalized } } });
  };

  return <div ref={hit.ref} {...hit.attrs} data-setting-id={def.id} className={cn(SETTING_ROW_GRID_CLASS, SEARCH_HIT_CLASS, "mt-3 pl-2")}>
    <div className="min-w-0">
      <label htmlFor="provider-serve-url-opencode" className="text-sm font-medium text-ink">{def.label}</label>
      <p id="provider-serve-url-opencode-hint" className={cn("mt-1 max-w-[62ch] text-xs", invalid ? "text-destructive" : "text-muted")}>
        {invalid
          ? "Enter an http or https URL, or leave it empty."
          : def.hint}
      </p>
    </div>
    <Input
      id="provider-serve-url-opencode"
      data-testid="provider-serve-url-opencode"
      value={draft}
      aria-invalid={invalid || undefined}
      aria-describedby="provider-serve-url-opencode-hint"
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      placeholder="http://127.0.0.1:4096"
      className="h-7 w-56 text-xs"
    />
  </div>;
}

/** One provider's settings: its enable switch, and its CLI path and other configuration when it has any. */
export interface ProviderSettingDefs {
  readonly enabled: SettingDef;
  readonly cliPath?: SettingDef;
  readonly serveUrl?: SettingDef;
}

interface ProviderRowProps {
  /** Availability and configuration snapshot for this provider. */
  row: ProviderAvailability;
  /** This provider's setting definitions. */
  defs: ProviderSettingDefs;
  /** True when this is the only enabled adapter-backed provider. */
  isLastEnabled: boolean;
  /** Called when the user flips the enable toggle. */
  onToggle: (next: boolean) => void | Promise<void>;
}

/**
 * Single provider row with a disclosure for editable CLI path configuration.
 * A search hit on the CLI path or serve URL opens the disclosure so the marked line can mount.
 */
function ProviderRow({ row, defs, isLastEnabled, onToggle }: ProviderRowProps) {
  // Adapter-less providers cannot be toggled; the last enabled provider also
  // blocks toggling to prevent an unusable state.
  const switchDisabled = !row.hasAdapter || isLastEnabled;
  const label = labelFor(row.id);
  const hint = hintFor(row, isLastEnabled);
  const controls = <ProviderControls row={row} switchDisabled={switchDisabled} onToggle={onToggle} />;
  const headerHit = useSettingHit([defs.enabled]);
  const inside = useSettingHit([defs.cliPath, defs.serveUrl].filter((def) => def !== undefined));
  const [isConfigOpen, setIsConfigOpen] = useState(row.beta);
  const [openedForHit, setOpenedForHit] = useState<SettingId | null>(null);
  // Adjusts state during render (not in an effect) so the disclosure is already open when the hit line first mounts.
  if (inside.hitId !== openedForHit) {
    setOpenedForHit(inside.hitId);
    if (inside.hitId !== null) setIsConfigOpen(true);
  }

  if (!defs.cliPath || !hasCliInput(row.id)) {
    return (
      <SettingRowFrame def={defs.enabled} variant="page" hint={hint}>
        {controls}
      </SettingRowFrame>
    );
  }

  return <Collapsible open={isConfigOpen} onOpenChange={setIsConfigOpen}><div className="px-4 py-2.5"><div ref={headerHit.ref} {...headerHit.attrs} data-setting-id={defs.enabled.id} className={cn(SETTING_ROW_GRID_CLASS, SEARCH_HIT_CLASS, "min-h-13 content-center")}>
    <CollapsibleTrigger asChild><Button type="button" variant="ghost" size="compact" data-testid={`provider-config-trigger-${row.id}`} aria-label={`${isConfigOpen ? "Hide" : "Show"} ${label} configuration`} className="-ml-2 h-auto w-full min-w-0 items-start justify-between gap-4 rounded-md px-2 py-1 text-left hover:bg-selected/60 aria-expanded:bg-transparent dark:aria-expanded:bg-transparent"><span className="flex min-w-0 flex-col items-start"><span className="text-body-small font-semibold text-ink">{label}</span>{hint && <span className="mt-0.5 text-compact leading-[1.8rem] text-muted">{hint}</span>}</span><ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform duration-200 motion-reduce:transition-none", isConfigOpen && "rotate-180")} aria-hidden /></Button></CollapsibleTrigger>
    {controls}
  </div><CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none"><CliPathField def={defs.cliPath} id={row.id} />{defs.serveUrl ? <OpenCodeServeUrlField def={defs.serveUrl} /> : null}</CollapsibleContent></div></Collapsible>;
}

/** Search result for a provider's enable switch: the same switch, guard and confirmation as the page row. */
function providerEnabledRow(id: ProviderId): ComponentType<SettingRowProps> {
  function ProviderEnabledRow({ def, variant }: SettingRowProps) {
    const row = useAvailability(id);
    const toggle = useProviderToggle();
    if (!row) {
      return <SettingRowFrame def={def} variant={variant}><span className="text-caption text-muted">Loading…</span></SettingRowFrame>;
    }
    const isLastEnabled = toggle.isLastEnabled(row);
    return (
      <SettingRowFrame def={def} variant={variant} hint={hintFor(row, isLastEnabled)}>
        <ProviderControls row={row} switchDisabled={!row.hasAdapter || isLastEnabled} onToggle={(next) => toggle.flip(id, next)} />
        {toggle.dialog}
      </SettingRowFrame>
    );
  }
  return ProviderEnabledRow;
}

/** Search result for a provider's CLI path: the same input as inside the page's disclosure. */
function providerCliPathRow(id: CliProvider): ComponentType<SettingRowProps> {
  function ProviderCliPathRow({ def, variant }: SettingRowProps) {
    return <SettingRowFrame def={def} variant={variant}><CliPathInput id={id} /></SettingRowFrame>;
  }
  return ProviderCliPathRow;
}

function OpenCodeServeUrlRow({ def }: SettingRowProps) {
  return <div className="px-4 pb-2.5"><OpenCodeServeUrlField def={def} /></div>;
}

function providerInputs(): Record<string, SettingInput> {
  const inputs: Record<string, SettingInput> = {};
  for (const entry of PROVIDER_CATALOG) {
    if (entry.comingSoon) continue;
    const group = settingsGroup(entry.name);
    inputs[`${entry.id}.enabled`] = {
      group,
      label: entry.name,
      synonyms: `${entry.id} ${entry.cliBinary} provider enable disable sign in login auth account turn on off`,
      configKey: `provider.enabled.${entry.id}`,
      Row: providerEnabledRow(entry.id),
    };
    if (!hasCliInput(entry.id)) continue;
    inputs[`${entry.id}.cliPath`] = {
      group,
      label: `${entry.name} CLI path`,
      synonyms: `cli path binary executable command location not found exe ${entry.id} ${entry.cliBinary}`,
      problems: `${entry.id} not found command not found cli missing`,
      configKey: `provider.cli.${entry.id}`,
      Row: providerCliPathRow(entry.id),
    };
  }
  inputs["opencode.serveUrl"] = {
    group: settingsGroup(getCatalogEntry("opencode").name),
    label: "Serve URL",
    hint: "Empty spawns a local server per worktree. A URL attaches to a shared server the app never closes.",
    synonyms: "opencode server url serve host port shared attach http",
    configKey: "provider.opencode.serveUrl",
    Row: OpenCodeServeUrlRow,
  };
  inputs.cliUpdates = {
    label: "Check for CLI updates",
    hint: "Asks the npm registry once a day for newer provider CLIs.",
    synonyms: "update cli npm version upgrade provider checks",
    configKey: "updates.providerCliChecks",
    Control: CliUpdateChecksControl,
  };
  return inputs;
}

function CliUpdateChecksControl() {
  const enabled = useSettingsStore((s) => s.settings.updates?.providerCliChecks ?? true);
  const update = useSettingsStore((s) => s.update);
  return (
    <Switch
      aria-label="Check for CLI updates"
      checked={enabled}
      onCheckedChange={(value) => void update({ updates: { providerCliChecks: value } })}
    />
  );
}

/** Settings on the Providers page, generated from the provider catalog: `<id>.enabled`, `<id>.cliPath`, then OpenCode's serve URL and the CLI update check. */
export const PROVIDERS = settingsPage<string>("providers", providerInputs());

function providerDefs(id: ProviderId): ProviderSettingDefs | undefined {
  const enabled = PROVIDERS[`${id}.enabled`];
  if (!enabled) return undefined;
  return { enabled, cliPath: PROVIDERS[`${id}.cliPath`], serveUrl: PROVIDERS[`${id}.serveUrl`] };
}

/** The shared CLI update check row, rendered under the provider list. */
export function CliUpdateChecksSetting() {
  return <Setting def={PROVIDERS.cliUpdates} />;
}

/**
 * Settings section for enabling AI providers and configuring their CLI paths.
 * Available providers expose a collapsible CLI path input. Beta providers start
 * expanded so their configuration stays available before they are enabled.
 */
export function ProviderSection() {
  const providers = useProviderAvailabilityStore((s) => s.providers);
  const toggle = useProviderToggle();
  const comingSoonProviders = providers.filter((provider) => provider.comingSoon);

  return (
    <div>
      <SettingsGroup>
        {providers.map((p) => {
          const defs = p.comingSoon ? undefined : providerDefs(p.id);
          return defs ? (
            <ProviderRow
              key={p.id}
              row={p}
              defs={defs}
              isLastEnabled={toggle.isLastEnabled(p)}
              onToggle={(next) => toggle.flip(p.id, next)}
            />
          ) : null;
        })}
        {comingSoonProviders.length > 0 && (
          <div data-testid="coming-soon-providers" className="px-4 py-2.5">
            <h3 className="text-caption font-semibold text-muted">
              Coming soon
            </h3>
            <div className="mt-2 space-y-0.5">
              {comingSoonProviders.map((provider) => (
                <ComingSoonProviderRow key={provider.id} row={provider} />
              ))}
            </div>
          </div>
        )}
      </SettingsGroup>
      {toggle.dialog}
    </div>
  );
}

/** Displays a non-interactive provider that is not available yet. */
function ComingSoonProviderRow({ row }: { row: ProviderAvailability }) {
  return (
    <div className="flex items-center justify-between gap-4 px-1 py-2.5">
      <span className="text-sm font-medium text-ink/75">
        {labelFor(row.id)}
      </span>
      <Badge
        variant="secondary"
        data-testid={`provider-badge-${row.id}-comingsoon`}
      >
        Coming soon
      </Badge>
    </div>
  );
}

/** Returns the human-readable display name for a provider ID. */
function labelFor(id: ProviderId): string {
  return getCatalogEntry(id).name;
}

/** Returns the hint text shown below the provider label: every message that applies, most important first. */
function hintFor(row: ProviderAvailability, isLastEnabled: boolean): string {
  return [
    isLastEnabled ? "At least one provider must be enabled." : undefined,
    row.enabled ? cliHint(row.cli) : undefined,
  ].filter(Boolean).join(" ");
}

function cliHint(cli: ProviderAvailability["cli"]): string | undefined {
  if (cli.status === "not_found") return cli.message ?? `CLI not found${cli.configuredPath ? ` at ${cli.configuredPath}` : ""}.`;
  return cli.warning;
}
