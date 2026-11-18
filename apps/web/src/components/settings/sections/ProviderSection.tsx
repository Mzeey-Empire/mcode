import { useId, useState, type ComponentType, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { SEARCH_HIT_CLASS, Setting, SettingRowFrame, useSettingHit } from "../Setting";
import { settingsGroup, settingsPage, type SettingDef, type SettingId, type SettingInput, type SettingRowProps } from "../setting-def";
import { SettingsGroup } from "../SettingsGroup";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { createTooltipHandle, Tooltip, TooltipContent, TooltipTrigger, type TooltipHandle } from "@/components/ui/tooltip";
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

function BetaTag({ id }: { id: ProviderId }) {
  return <Tooltip><TooltipTrigger><Badge variant="secondary" data-testid={`provider-badge-${id}-beta`}>Beta</Badge></TooltipTrigger><TooltipContent>This provider is in early phase. Expect bugs or incomplete features.</TooltipContent></Tooltip>;
}

/**
 * The CLI state for an enabled provider. The app knows only whether the CLI was found, not
 * whether the user is signed in, so a found CLI shows nothing. Fixed width so switches line up.
 */
function CliStatus({ row }: { row: ProviderAvailability }) {
  const status = row.enabled ? row.cli.status : "found";
  return <span className={cn("w-33 shrink-0 text-compact", status === "not_found" ? "text-warning" : "text-muted")}>
    {status === "not_found" && <span data-testid={`provider-badge-${row.id}-cli-missing`}>CLI not found</span>}
    {status === "unchecked" && "Checking"}
  </span>;
}

function ProviderSwitch({ row, disabled, onToggle }: { row: ProviderAvailability; disabled: boolean; onToggle: (next: boolean) => void | Promise<void> }) {
  return <Switch data-testid={`provider-switch-${row.id}`} aria-label={`${labelFor(row.id)} enabled`} checked={row.enabled && row.hasAdapter} disabled={disabled} onCheckedChange={onToggle} />;
}

function CliPathInput({ id }: { id: CliProvider }) {
  const cliPath = useSettingsStore((s) => s.settings.provider.cli[id]);
  const update = useSettingsStore((s) => s.update);
  return <Input id={`provider-cli-path-${id}`} data-testid={`provider-cli-path-${id}`} aria-label={`${labelFor(id)} CLI path`} value={cliPath ?? ""} onChange={(event) => void update({ provider: { cli: { [id]: event.target.value } } })} placeholder={id} className="h-7 w-56 text-xs" />;
}

/** Parse a serve URL draft through the settings contract; null when it would be rejected. */
function parseServeUrlDraft(draft: string): string | null {
  const parsed = PartialSettingsSchema().safeParse({ provider: { opencode: { serveUrl: draft } } });
  return parsed.success ? (parsed.data.provider?.opencode?.serveUrl ?? "") : null;
}

/**
 * OpenCode server URL editor. Commits on blur or Enter rather than per
 * keystroke, because a half-typed URL fails validation and would be dropped.
 */
function OpenCodeServeUrlRow({ def, variant }: SettingRowProps) {
  const saved = useSettingsStore((s) => s.settings.provider.opencode.serveUrl);
  const update = useSettingsStore((s) => s.update);
  const [draft, setDraft] = useState(saved);
  const [invalid, setInvalid] = useState(false);

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

  const hint = <span id="provider-serve-url-opencode-hint" className={cn(invalid && "text-destructive")}>
    {invalid ? "Enter an http or https URL, or leave it empty." : def.hint}
  </span>;

  return <SettingRowFrame def={def} variant={variant} hint={hint}>
    <Input
      id="provider-serve-url-opencode"
      data-testid="provider-serve-url-opencode"
      aria-label={`OpenCode ${def.label}`}
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
  </SettingRowFrame>;
}

/** One provider's settings: its enable switch, and its CLI path and other configuration when it has any. */
export interface ProviderSettingDefs {
  readonly enabled: SettingDef;
  readonly cliPath?: SettingDef;
  readonly serveUrl?: SettingDef;
}

/** The path the provider runs: resolved when known, else configured, else the bare binary name found on PATH. */
function cliPathFor(row: ProviderAvailability): string {
  return row.cli.resolvedPath ?? (row.cli.configuredPath || getCatalogEntry(row.id).cliBinary);
}

/** File name first in ink, then the folder in muted fading at the right edge, so the file name always shows. */
function PathLine({ path, tooltip }: { path: string; tooltip: TooltipHandle<string> }) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const file = path.slice(cut + 1);
  const dir = cut < 0 ? "" : path.slice(0, cut);
  return <TooltipTrigger handle={tooltip} payload={path} render={
    <span aria-label={path} data-testid="provider-cli-path-line" className="flex min-w-0 gap-2 font-mono text-caption [font-variant-ligatures:none]">
      <span className="shrink-0 text-ink">{file}</span>
      {dir && <span className="text-fade text-muted">{dir}</span>}
    </span>
  } />;
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
  /** The page's one shared tooltip for full CLI paths. */
  pathTooltip: TooltipHandle<string>;
}

/**
 * One provider: icon, name and CLI path, CLI state, enable switch and a details toggle.
 * Clicking anywhere on the row but the switch opens its CLI path and server URL in place.
 * A search hit on one of those opens the details so the marked row can mount.
 */
function ProviderRow({ row, defs, isLastEnabled, onToggle, pathTooltip }: ProviderRowProps) {
  const headerHit = useSettingHit([defs.enabled]);
  const inside = useSettingHit([defs.cliPath, defs.serveUrl].filter((def) => def !== undefined));
  const [isOpen, setIsOpen] = useState(false);
  const [openedForHit, setOpenedForHit] = useState<SettingId | null>(null);
  const detailsId = useId();
  // Adjusts state during render (not in an effect) so the details are already open when the hit line first mounts.
  if (inside.hitId !== openedForHit) {
    setOpenedForHit(inside.hitId);
    if (inside.hitId !== null) setIsOpen(true);
  }
  const hasDetails = hasProviderDetails(row.id, defs);
  const toggleOpen = () => setIsOpen((open) => !open);

  return <>
    <div
      ref={headerHit.ref}
      {...headerHit.attrs}
      data-setting-id={defs.enabled.id}
      onClick={hasDetails ? toggleOpen : undefined}
      className={cn(SEARCH_HIT_CLASS, "flex min-h-15 items-center gap-4 py-2.5 pr-3 pl-4 transition-colors", hasDetails && "cursor-pointer hover:bg-hover")}
    >
      <ProviderIcon provider={row.id} size={20} />
      <ProviderSummary row={row} hint={hintFor(row, isLastEnabled)} pathTooltip={pathTooltip} />
      <CliStatus row={row} />
      {/* The switch sits inside the clickable row; stop its click so toggling never opens the details. */}
      <span className="flex" onClick={(event) => event.stopPropagation()}>
        <ProviderSwitch row={row} disabled={!row.hasAdapter || isLastEnabled} onToggle={onToggle} />
      </span>
      {hasDetails && <DetailsToggle id={row.id} isOpen={isOpen} detailsId={detailsId} onToggle={toggleOpen} />}
    </div>
    {isOpen && <ProviderDetails id={row.id} defs={defs} detailsId={detailsId} />}
  </>;
}

function hasProviderDetails(id: ProviderId, defs: ProviderSettingDefs): boolean {
  return (defs.cliPath !== undefined && hasCliInput(id)) || defs.serveUrl !== undefined;
}

/** The provider's own settings, opened in place under its row. */
function ProviderDetails({ id, defs, detailsId }: { id: ProviderId; defs: ProviderSettingDefs; detailsId: string }) {
  return <div id={detailsId} className="pl-9 bg-hover/40">
    {defs.cliPath && hasCliInput(id) && <SettingRowFrame def={defs.cliPath} variant="page" label="CLI path"><CliPathInput id={id} /></SettingRowFrame>}
    {defs.serveUrl && <OpenCodeServeUrlRow def={defs.serveUrl} variant="page" />}
  </div>;
}

/** Name and Beta tag over the CLI path, or over the hint in its place when one applies so it shows without hover. */
function ProviderSummary({ row, hint, pathTooltip }: { row: ProviderAvailability; hint: string; pathTooltip: TooltipHandle<string> }) {
  return <div className="flex min-w-0 flex-1 flex-col gap-0.5">
    <div className="flex items-center gap-2 text-body-small font-medium whitespace-nowrap text-ink">{labelFor(row.id)}{row.beta && <BetaTag id={row.id} />}</div>
    {hint
      ? <p className={cn("text-caption", row.enabled && row.cli.status === "not_found" ? "text-warning" : "text-muted")}>{hint}</p>
      : <PathLine path={cliPathFor(row)} tooltip={pathTooltip} />}
  </div>;
}

function DetailsToggle({ id, isOpen, detailsId, onToggle }: { id: ProviderId; isOpen: boolean; detailsId: string; onToggle: () => void }) {
  return <Button
    type="button"
    variant="ghost"
    size="icon-inline"
    aria-expanded={isOpen}
    aria-controls={detailsId}
    aria-label={`${labelFor(id)} settings`}
    data-testid={`provider-config-trigger-${id}`}
    onClick={(event) => {
      // The row toggles on click too; stop here so one click toggles once.
      event.stopPropagation();
      onToggle();
    }}
    className="text-muted"
  >
    <ChevronDown className={cn("size-3.5 transition-transform duration-200 motion-reduce:transition-none", isOpen && "rotate-180")} aria-hidden />
  </Button>;
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
        <div className="flex items-center gap-2">
          {row.beta && <BetaTag id={row.id} />}
          <CliStatus row={row} />
          <ProviderSwitch row={row} disabled={!row.hasAdapter || isLastEnabled} onToggle={(next) => toggle.flip(id, next)} />
        </div>
        {toggle.dialog}
      </SettingRowFrame>
    );
  }
  return ProviderEnabledRow;
}

/** Search result for a provider's CLI path: the same input as inside the page's details. */
function providerCliPathRow(id: CliProvider): ComponentType<SettingRowProps> {
  function ProviderCliPathRow({ def, variant }: SettingRowProps) {
    return <SettingRowFrame def={def} variant={variant}><CliPathInput id={id} /></SettingRowFrame>;
  }
  return ProviderCliPathRow;
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
    label: "Server URL",
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

/** Settings on the Providers page, generated from the provider catalog: `<id>.enabled`, `<id>.cliPath`, then OpenCode's server URL and the CLI update check. */
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
 * Settings section listing every provider as one row, with each provider's CLI path and
 * other configuration opening in place under its row. Coming-soon providers follow, dimmed.
 */
export function ProviderSection() {
  const providers = useProviderAvailabilityStore((s) => s.providers);
  const toggle = useProviderToggle();
  const [pathTooltip] = useState(() => createTooltipHandle<string>());

  return (
    <div>
      <SettingsGroup>
        {providers.map((p) => {
          if (p.comingSoon) return <ComingSoonProviderRow key={p.id} row={p} />;
          const defs = providerDefs(p.id);
          return defs ? (
            <ProviderRow
              key={p.id}
              row={p}
              defs={defs}
              isLastEnabled={toggle.isLastEnabled(p)}
              onToggle={(next) => toggle.flip(p.id, next)}
              pathTooltip={pathTooltip}
            />
          ) : null;
        })}
      </SettingsGroup>
      <Tooltip handle={pathTooltip}>
        {({ payload }) => (payload ? <TooltipContent side="top" align="start" className="font-mono">{payload}</TooltipContent> : null)}
      </Tooltip>
      {toggle.dialog}
    </div>
  );
}

/** A provider that is not available yet: dimmed, with no switch and no details. */
function ComingSoonProviderRow({ row }: { row: ProviderAvailability }) {
  return (
    <div aria-disabled="true" data-testid={`provider-row-${row.id}-comingsoon`} className="flex min-h-15 items-center gap-4 py-2.5 pr-3 pl-4 opacity-55">
      <ProviderIcon provider={row.id} size={20} />
      <div className="flex items-center gap-2 text-body-small font-medium text-ink">
        {labelFor(row.id)}
        <Badge variant="secondary" data-testid={`provider-badge-${row.id}-comingsoon`}>Coming soon</Badge>
      </div>
    </div>
  );
}

/** Returns the human-readable display name for a provider ID. */
function labelFor(id: ProviderId): string {
  return getCatalogEntry(id).name;
}

/** Returns the hint text shown in place of the CLI path: every message that applies, most important first. */
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
