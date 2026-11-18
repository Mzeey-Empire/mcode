import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ChevronDown, Plus, SquareTerminal } from "lucide-react";
import type { TerminalCustomProfile, TerminalProfileReference } from "@mcode/contracts/models/terminal";
import type { TerminalPreferencesUpdate, TerminalSettings } from "@mcode/contracts/models/terminal-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PICKER_PANEL_CLASS, Picker, type PickerRow } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTerminalSettingsStore } from "./terminalSettingsStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { RangeControl } from "@/components/settings/RangeControl";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { SettingsSelectPicker, type SettingsPickOption } from "@/components/settings/SettingsSelectPicker";
import { PathLine, PathTooltipRoot, usePathTooltip } from "@/components/settings/PathLine";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SEARCH_HIT_CLASS, Setting, SettingRowFrame, useSettingHit } from "@/components/settings/Setting";
import { settingsGroup, settingsPage, type SettingRowProps } from "@/components/settings/setting-def";
import { cn } from "@/lib/utils";
import { TERMINAL_FONT_SIZES, TERMINAL_LINE_HEIGHTS } from "../terminal-metrics";
import { detectRenderableFonts, fontStackFor, primaryFontFamily, type TerminalFontChoice } from "./terminal-fonts";

const INHERIT_PROFILE = "__terminal_inherit__";

const profileName = (profileId: TerminalProfileReference): string => {
  if (profileId === "automatic") return "Automatic";
  if (profileId.startsWith("custom:")) return "Custom profile";
  return profileId
    .replace("certified:", "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
};

interface ProfileDialogProps {
  open: boolean;
  profile: TerminalCustomProfile | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: Omit<TerminalCustomProfile, "id">, profileId?: string) => Promise<boolean>;
}

function ProfileDialog({ open, profile, pending, onOpenChange, onSubmit }: ProfileDialogProps) {
  const [name, setName] = useState("");
  const [executable, setExecutable] = useState("");
  const [argumentsText, setArgumentsText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Opening a profile from the settings store starts a fresh editable form.
    setName(profile?.name ?? "");
    setExecutable(profile?.executable ?? "");
    setArgumentsText(profile?.arguments.join("\n") ?? "");
    setError(null);
  }, [open, profile]);

  const submit = async () => {
    const input = {
      name: name.trim(),
      executable: executable.trim(),
      arguments: argumentsText.split("\n").map((value) => value.trim()).filter(Boolean),
    };
    if (!input.name || !input.executable) {
      setError("Enter a name and executable.");
      return;
    }
    const saved = await onSubmit(input, profile?.id);
    if (saved) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{profile ? "Edit custom profile" : "Add custom profile"}</DialogTitle>
          <DialogDescription>Changes apply to new terminals.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm">
            Name
            <Input
              aria-label="Profile name"
              value={name}
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Executable
            <Input
              aria-label="Profile executable"
              value={executable}
              maxLength={1024}
              onChange={(event) => setExecutable(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Arguments
            <Textarea
              aria-label="Profile arguments"
              value={argumentsText}
              className="min-h-28 resize-none"
              onChange={(event) => setArgumentsText(event.target.value)}
              placeholder="One argument per line"
            />
          </label>
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={pending} onClick={() => void submit()}>{pending ? "Saving…" : "Save profile"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ProfileOption = { readonly id: TerminalProfileReference; readonly name: string };

function ProfilePicker({
  value,
  certified,
  custom,
  disabled,
  onChange,
  allowInherit = false,
}: {
  value: string;
  certified: readonly ProfileOption[];
  custom: readonly TerminalCustomProfile[];
  disabled?: boolean;
  onChange: (value: string) => void;
  allowInherit?: boolean;
}) {
  const options: SettingsPickOption[] = [
    ...(allowInherit ? [{ value: INHERIT_PROFILE, label: "Use inherited global profile" }] : []),
    { value: "automatic", label: "Automatic" },
    ...certified.map((profile) => ({ value: profile.id, label: profile.name })),
    ...custom.map((profile) => ({ value: profile.id, label: profile.name })),
    ...(terminalProfileUnavailable(value, certified, custom)
      ? [{ value, label: `Unavailable: ${profileName(value as TerminalProfileReference)}` }]
      : []),
  ];
  return (
    <SettingsSelectPicker
      aria-label={allowInherit ? "Workspace Terminal profile" : "Default Terminal profile"}
      value={value}
      options={options}
      searchPlaceholder="Search profiles"
      disabled={disabled}
      onChange={onChange}
    />
  );
}

function terminalProfileUnavailable(
  value: string,
  certified: readonly ProfileOption[],
  custom: readonly TerminalCustomProfile[],
): boolean {
  if (value === INHERIT_PROFILE || value === "automatic") return false;
  return !certified.some((profile) => profile.id === value)
    && !custom.some((profile) => profile.id === value);
}

function PreferencesStatus({ pending, error }: { pending: boolean; error: string | null }) {
  if (error) return <p role="alert" className="mb-3 text-xs text-destructive">{error}</p>;
  if (pending) return <p role="status" className="mb-3 text-xs text-muted" aria-live="polite">Saving Terminal preferences…</p>;
  return null;
}

/**
 * Terminal profile lists for one control. Loads them once per mount of the first control
 * that needs them: the page shows several profile rows, so later rows skip while a load is in flight.
 */
function useTerminalProfiles() {
  const terminal = useSettingsStore((state) => state.settings.terminal);
  const certifiedProfiles = useTerminalSettingsStore((state) => state.certifiedProfiles);
  const customProfiles = useTerminalSettingsStore((state) => state.customProfiles);
  const recovery = useTerminalSettingsStore((state) => state.recovery);
  const profilesLoaded = useTerminalSettingsStore((state) => state.profilesLoaded);
  const profilesLoading = useTerminalSettingsStore((state) => state.profilesLoading);
  const pending = useTerminalSettingsStore((state) => state.pending);
  const fetchProfiles = useTerminalSettingsStore((state) => state.fetchProfiles);

  useEffect(() => {
    if (!useTerminalSettingsStore.getState().profilesLoading) void fetchProfiles();
  }, [fetchProfiles]);

  const certifiedOptions = useMemo(
    () => certifiedProfiles.map((profile) => ({ id: profile.id, name: profile.name })),
    [certifiedProfiles],
  );
  const globalDefault = recovery?.unavailableProfileId ?? terminal.defaultProfileId;
  const automaticProfile = certifiedProfiles[0];
  return {
    certifiedProfiles,
    certifiedOptions,
    customProfiles,
    recovery,
    profilesLoaded,
    profilesLoading,
    pending,
    globalDefault,
    automaticProfile,
    /** The profile a new terminal opens with: the chosen one, or the first detected under Automatic. */
    inUseProfileId: globalDefault === "automatic" ? automaticProfile?.id : globalDefault,
    selectedProfileUnavailable: Boolean(recovery?.unavailableProfileId)
      || terminalProfileUnavailable(globalDefault, certifiedOptions, customProfiles),
  };
}

type TerminalProfiles = ReturnType<typeof useTerminalProfiles>;

function globalProfileHint(profiles: TerminalProfiles): string | undefined {
  if (profiles.globalDefault === "automatic" && profiles.automaticProfile) {
    return `Automatic currently uses ${profiles.automaticProfile.name}.`;
  }
  if (profiles.selectedProfileUnavailable) return "The selected profile is unavailable. Choose another profile.";
  return undefined;
}

/** Default profile; its hint names the profile Automatic resolves to, so the row draws it. */
function GlobalProfileRow({ def, variant }: SettingRowProps) {
  const profiles = useTerminalProfiles();
  const setGlobalDefault = useTerminalSettingsStore((state) => state.setGlobalDefault);
  return (
    <SettingRowFrame def={def} variant={variant} hint={globalProfileHint(profiles)}>
      <ProfilePicker
        value={profiles.globalDefault}
        certified={profiles.certifiedOptions}
        custom={profiles.customProfiles}
        disabled={!profiles.profilesLoaded || profiles.pending}
        onChange={(value) => { void setGlobalDefault(value as TerminalProfileReference); }}
      />
    </SettingRowFrame>
  );
}

function ProfileRecoveryNotices() {
  const profiles = useTerminalProfiles();
  return (
    <>
      {profiles.selectedProfileUnavailable ? (
        <p role="alert" className="px-4 py-2.5 text-caption text-destructive">
          Selected profile is unavailable: {profiles.globalDefault}
        </p>
      ) : null}
      {profiles.recovery ? (
        <div role="alert" className="px-4 py-2.5 text-caption text-destructive">
          Terminal settings need repair. Reset Terminal preferences to restore defaults.
        </div>
      ) : null}
    </>
  );
}

/** Project default profile; without an open project the row dims and says why. */
function ProjectProfileRow({ def, variant }: SettingRowProps) {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  if (!activeWorkspaceId) {
    return <SettingRowFrame def={def} variant={variant} hint="Open a project to set one." className="opacity-55">{null}</SettingRowFrame>;
  }
  return <ProjectProfileFrame def={def} variant={variant} workspaceId={activeWorkspaceId} />;
}

function ProjectProfileFrame({ def, variant, workspaceId }: SettingRowProps & { readonly workspaceId: string }) {
  const profiles = useTerminalProfiles();
  const workspaceOverride = useTerminalSettingsStore((state) => state.workspaceOverride);
  const workspaceLoading = useTerminalSettingsStore((state) => state.workspaceLoading);
  const fetchWorkspaceOverride = useTerminalSettingsStore((state) => state.fetchWorkspaceOverride);
  const setWorkspaceDefault = useTerminalSettingsStore((state) => state.setWorkspaceDefault);
  const resetWorkspaceDefault = useTerminalSettingsStore((state) => state.resetWorkspaceDefault);

  useEffect(() => {
    void fetchWorkspaceOverride(workspaceId);
  }, [workspaceId, fetchWorkspaceOverride]);

  const selectWorkspaceProfile = (value: string) => {
    if (value === INHERIT_PROFILE) {
      void resetWorkspaceDefault(workspaceId);
      return;
    }
    void setWorkspaceDefault(workspaceId, value as TerminalProfileReference);
  };

  return (
    <SettingRowFrame def={def} variant={variant}>
      <div className="flex flex-wrap items-center gap-2">
        <ProfilePicker
          value={workspaceOverride?.defaultProfileId ?? INHERIT_PROFILE}
          certified={profiles.certifiedOptions}
          custom={profiles.customProfiles}
          disabled={!profiles.profilesLoaded || workspaceLoading || profiles.pending}
          allowInherit
          onChange={selectWorkspaceProfile}
        />
        {workspaceOverride ? (
          <Button variant="ghost" size="compact" disabled={profiles.pending} onClick={() => void resetWorkspaceDefault(workspaceId)}>
            Use inherited profile
          </Button>
        ) : null}
      </div>
    </SettingRowFrame>
  );
}

function InUseTag() {
  return <Badge variant="secondary" size="compact">In use</Badge>;
}

function CustomProfileRow({
  profile,
  inUse,
  pending,
  onEdit,
  onDelete,
}: {
  readonly profile: TerminalCustomProfile;
  readonly inUse: boolean;
  readonly pending: boolean;
  readonly onEdit: (profile: TerminalCustomProfile) => void;
  readonly onDelete: (profileId: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 px-3 py-2 text-xs">
      <span className="flex min-w-0 items-center gap-2 text-fade">
        {profile.name}
        {inUse ? <InUseTag /> : null}
        <span className="text-muted">{profile.executable}</span>
      </span>
      <span className="flex shrink-0 gap-1">
        <Button variant="ghost" size="compact" disabled={pending} onClick={() => onEdit(profile)}>Edit</Button>
        <Button variant="ghost" size="compact" disabled={pending} onClick={() => onDelete(profile.id)}>Delete</Button>
      </span>
    </div>
  );
}

function ProfileDeleteReferences() {
  const references = useTerminalSettingsStore((state) => state.deleteReferences);
  if (!references) return null;
  return (
    <div role="alert" className="px-4 py-2.5 text-caption text-destructive">
      This profile is still in use.
      {references.globalDefault ? " It is the global default." : ""}
      {references.workspaceIds.length ? ` Project references: ${references.workspaceIds.join(", ")}.` : ""}
    </div>
  );
}

function detectedProfilesStatus(profiles: TerminalProfiles): string | null {
  if (profiles.profilesLoading && !profiles.profilesLoaded) return "Loading profiles…";
  if (!profiles.profilesLoading && profiles.certifiedProfiles.length === 0) return "No profiles detected.";
  return null;
}

/**
 * One row per detected profile: its name, an "In use" tag on the profile a new terminal opens with,
 * and its executable path. The rows share one path tooltip root.
 */
function DetectedProfilesRow({ def, variant }: SettingRowProps) {
  const profiles = useTerminalProfiles();
  const hit = useSettingHit([def]);
  const pathTooltip = usePathTooltip();
  const statusText = detectedProfilesStatus(profiles);
  const status = statusText ? <p className="text-caption text-muted">{statusText}</p> : null;
  const rows = profiles.certifiedProfiles.map((profile) => (
    <div key={profile.id} className="flex min-h-14 min-w-0 flex-col justify-center gap-0.5 px-4 py-2.5">
      <div className="flex items-center gap-2 text-body-small font-medium text-ink">
        {profile.name}
        {profile.id === profiles.inUseProfileId ? <InUseTag /> : null}
      </div>
      <PathLine path={profile.executable} tooltip={pathTooltip} />
    </div>
  ));
  if (variant !== "page") {
    return (
      <SettingRowFrame def={def} variant={variant}>
        {status}
        <div className="grid min-w-52 gap-1 sm:min-w-64">{rows}</div>
        <PathTooltipRoot handle={pathTooltip} />
      </SettingRowFrame>
    );
  }
  return (
    <div ref={hit.ref} {...hit.attrs} data-setting-id={def.id} className={cn(SEARCH_HIT_CLASS, "divide-y divide-border")}>
      {status ? <div className="px-4 py-2.5">{status}</div> : null}
      {rows}
      <PathTooltipRoot handle={pathTooltip} />
    </div>
  );
}

/** Custom profile list with add, edit and delete; owns the profile dialog so search results can add one too. */
function CustomProfilesControl() {
  const profiles = useTerminalProfiles();
  const createProfile = useTerminalSettingsStore((state) => state.createProfile);
  const updateProfile = useTerminalSettingsStore((state) => state.updateProfile);
  const deleteProfile = useTerminalSettingsStore((state) => state.deleteProfile);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<TerminalCustomProfile | null>(null);

  const openDialog = (profile: TerminalCustomProfile | null) => {
    setEditingProfile(profile);
    setDialogOpen(true);
  };

  return (
    <div className="grid justify-items-end gap-2">
      {profiles.customProfiles.map((profile) => (
        <CustomProfileRow
          key={profile.id}
          profile={profile}
          inUse={profile.id === profiles.inUseProfileId}
          pending={profiles.pending}
          onEdit={openDialog}
          onDelete={(profileId) => { void deleteProfile(profileId); }}
        />
      ))}
      {profiles.recovery?.blockedProfiles.map((profile) => (
        <div key={`recovered-${profile.id}`} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 px-3 py-2 text-xs">
          <span className="min-w-0 text-fade">
            {profile.name}
            <span className="ml-2 text-muted">{profile.executable}</span>
          </span>
          <Badge variant="secondary" size="compact">Recovered</Badge>
        </div>
      ))}
      <Button
        variant="outline"
        size="compact"
        disabled={profiles.pending || profiles.customProfiles.length >= 32}
        onClick={() => openDialog(null)}
      >
        <Plus aria-hidden className="size-3.5" />
        Add profile
      </Button>
      <ProfileDialog
        open={dialogOpen}
        profile={editingProfile}
        pending={profiles.pending}
        onOpenChange={setDialogOpen}
        onSubmit={(input, profileId) => profileId ? updateProfile({ ...input, profileId }) : createProfile(input)}
      />
    </div>
  );
}

/**
 * Terminal preferences and their writer. Writes go through the terminal store, which also
 * applies the server's answer to the settings store, so page and search show the same value.
 */
function useTerminalPreferences() {
  const terminal = useSettingsStore((state) => state.settings.terminal);
  const pending = useTerminalSettingsStore((state) => state.pending);
  const updatePreferences = useTerminalSettingsStore((state) => state.updatePreferences);
  const update = (input: TerminalPreferencesUpdate) => { void updatePreferences(input); };
  return {
    terminal,
    pending,
    updatePresentation: <K extends keyof TerminalSettings["presentation"]>(key: K, value: TerminalSettings["presentation"][K]) => update({ presentation: { [key]: value } } as TerminalPreferencesUpdate),
    updateBehavior: <K extends keyof TerminalSettings["behavior"]>(key: K, value: TerminalSettings["behavior"][K]) => update({ behavior: { [key]: value } } as TerminalPreferencesUpdate),
    updateAccessibility: (mode: TerminalSettings["accessibility"]["screenReaderMode"]) => update({ accessibility: { screenReaderMode: mode } }),
  };
}

/** A font picker row: a listed font, or the typed name when nothing matches. */
interface FontRow {
  readonly key: string;
  readonly family: string;
  readonly label: string;
  readonly mono?: boolean;
}

function fontRows(fonts: readonly TerminalFontChoice[], query: string): FontRow[] {
  const needle = query.trim().toLowerCase();
  const hits = fonts.filter((font) => font.name.toLowerCase().includes(needle));
  if (hits.length === 0) {
    const typed = query.trim().replace(/\s+/g, " ");
    // A font the list does not know can still be used by name.
    return typed ? [{ key: `typed:${typed}`, family: typed, label: `Use "${typed}"` }] : [];
  }
  // Monospace faces first: a terminal almost always wants one.
  return [...hits.filter((font) => font.mono), ...hits.filter((font) => !font.mono)]
    .map((font) => ({ key: font.name, family: font.name, label: font.name, mono: font.mono }));
}

function fontPickerRow(row: FontRow): PickerRow {
  if (row.mono === undefined) return { key: row.key, name: row.label };
  const group = row.mono ? "Monospace" : "All fonts";
  return { key: row.key, name: row.label, fontFamily: `"${row.family}", var(--font-sans)`, group, groupLabel: group };
}

/** Font family pill: shows the current face in itself, and opens a searchable list of faces this machine renders. */
function FontFamilyControl() {
  const { terminal, pending, updatePresentation } = useTerminalPreferences();
  const current = primaryFontFamily(terminal.presentation.fontFamily);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Measuring every face forces layout, so it runs once, when the list first opens.
  const [fonts, setFonts] = useState<readonly TerminalFontChoice[] | null>(null);
  const handleOpenChange = (next: boolean) => {
    if (next && fonts === null) setFonts(detectRenderableFonts());
    if (!next) setQuery("");
    setOpen(next);
  };
  const rows = useMemo(() => fontRows(fonts ?? [], query), [fonts, query]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="compact"
            disabled={pending}
            aria-label={`Terminal font family: ${current}`}
            className="max-w-[28rem] justify-between gap-1.5 rounded-full pr-2 pl-3 font-normal hover:bg-hover data-popup-open:bg-hover"
          >
            <span className="min-w-0 flex-1 text-fade text-left" style={{ fontFamily: `"${current}", var(--font-mono)` }}>{current}</span>
            <ChevronDown aria-hidden className="size-4 shrink-0 text-muted" />
          </Button>
        }
      />
      <PopoverContent align="end" side="bottom" sideOffset={4} className={PICKER_PANEL_CLASS}>
        <Picker
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder="Search fonts"
          items={rows}
          total={null}
          status="ready"
          selectedKey={current}
          renderItem={fontPickerRow}
          onSelect={(row) => {
            updatePresentation("fontFamily", fontStackFor(row.family));
            handleOpenChange(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function FontSizeControl() {
  const { terminal, pending, updatePresentation } = useTerminalPreferences();
  const presentation = terminal.presentation;
  return (
    <span className="flex items-center gap-2">
      <SegmentedControl
        aria-label="Font size"
        className="font-mono"
        options={(["xs", "sm", "md", "lg", "xl"] as const).map((value) => ({ value, label: String(TERMINAL_FONT_SIZES[value]), disabled: pending }))}
        value={presentation.fontSize}
        onChange={(value) => updatePresentation("fontSize", value as typeof presentation.fontSize)}
      />
      <span className="text-caption text-muted">px</span>
    </span>
  );
}

function LineHeightControl() {
  const { terminal, pending, updatePresentation } = useTerminalPreferences();
  const presentation = terminal.presentation;
  return (
    <SegmentedControl
      options={(["compact", "normal", "relaxed"] as const).map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1), disabled: pending }))}
      value={presentation.lineHeight}
      onChange={(value) => updatePresentation("lineHeight", value as typeof presentation.lineHeight)}
    />
  );
}

/** A small filled shape of each cursor style, drawn in the segment's text colour. */
const CURSOR_GLYPHS: Record<TerminalSettings["presentation"]["cursorStyle"], string> = {
  block: "h-3 w-2",
  underline: "mt-2.5 h-0.5 w-2",
  bar: "h-3 w-0.5",
};

function CursorStyleControl() {
  const { terminal, pending, updatePresentation } = useTerminalPreferences();
  const presentation = terminal.presentation;
  return (
    <SegmentedControl
      options={(["block", "underline", "bar"] as const).map((value) => ({
        value,
        label: value[0].toUpperCase() + value.slice(1),
        icon: <span aria-hidden className={cn("inline-block bg-current", CURSOR_GLYPHS[value])} />,
        disabled: pending,
      }))}
      value={presentation.cursorStyle}
      onChange={(value) => updatePresentation("cursorStyle", value as typeof presentation.cursorStyle)}
    />
  );
}

function CursorBlinkControl() {
  const { terminal, pending, updatePresentation } = useTerminalPreferences();
  return <Switch aria-label="Cursor blink" checked={terminal.presentation.cursorBlink} disabled={pending} onCheckedChange={(value) => updatePresentation("cursorBlink", value)} />;
}

function LigaturesControl() {
  const { terminal, pending, updatePresentation } = useTerminalPreferences();
  return <Switch aria-label="Terminal ligatures" checked={terminal.presentation.ligatures} disabled={pending} onCheckedChange={(value) => updatePresentation("ligatures", value)} />;
}

const SAMPLE_CURSOR: Record<TerminalSettings["presentation"]["cursorStyle"], string> = {
  block: "h-[1.15em] w-[0.6em] align-text-bottom",
  underline: "h-[0.12em] w-[0.6em] align-baseline",
  bar: "h-[1.15em] w-[0.12em] align-text-bottom",
};

/** Fixed, so a larger font or line height clips inside the sample instead of pushing the rows below. */
const SAMPLE_HEIGHT = "19.2rem";

function TerminalSampleHead() {
  const profiles = useTerminalProfiles();
  const inUse = profiles.certifiedProfiles.find((profile) => profile.id === profiles.inUseProfileId)
    ?? profiles.customProfiles.find((profile) => profile.id === profiles.inUseProfileId);
  return (
    <div className="flex h-9 items-center gap-2 pr-1 pl-4 text-caption text-muted">
      <SquareTerminal aria-hidden className="size-3.5" />
      <span className="font-medium text-ink">{inUse?.name ?? "Terminal"}</span>
      {profiles.globalDefault === "automatic" ? <span>· Auto</span> : null}
    </div>
  );
}

/** A live terminal sample in the current font, size, line height, ligatures and cursor. Only the page shows it. */
function TerminalSample() {
  const presentation = useSettingsStore((state) => state.settings.terminal.presentation);
  const style: CSSProperties = {
    height: SAMPLE_HEIGHT,
    fontFamily: presentation.fontFamily,
    fontSize: `${TERMINAL_FONT_SIZES[presentation.fontSize]}px`,
    lineHeight: TERMINAL_LINE_HEIGHTS[presentation.lineHeight],
    fontVariantLigatures: presentation.ligatures ? "normal" : "none",
  };
  const prompt = <span className="text-muted">PS C:\dev\mcode&gt;</span>;
  return (
    <div className="mx-2 mt-1 mb-2 rounded-md bg-page">
      <TerminalSampleHead />
      <div role="img" aria-label="Terminal preview" style={style} className="overflow-hidden px-4 pt-0.5 pb-3.5 text-ink [&>div]:break-all [&>div]:whitespace-pre-wrap">
        <div>{prompt} git log --oneline -2</div>
        <div><span className="text-warning">fc7b2ff2c</span> feat: discover Claude models from Claude Code</div>
        <div><span className="text-warning">e662c02e8</span> fix(claude): launch the user-installed Claude Code CLI</div>
        <div>{prompt} echo "-&gt; =&gt; != &gt;="</div>
        <div>-&gt; =&gt; != &gt;=</div>
        <div>
          {prompt}{" "}
          <span
            aria-hidden
            className={cn(
              "inline-block bg-ink",
              SAMPLE_CURSOR[presentation.cursorStyle],
              presentation.cursorBlink && "animate-[blink_1.06s_steps(1)_infinite] motion-reduce:animate-none",
            )}
          />
        </div>
      </div>
    </div>
  );
}

function ScrollbackControl() {
  const { terminal, updateBehavior } = useTerminalPreferences();
  return <RangeControl ariaLabel="Scrollback lines" min={100} max={5000} step={100} value={terminal.behavior.scrollback} onCommit={(value) => updateBehavior("scrollback", value)} />;
}

function SessionLimitControl() {
  const { terminal, updateBehavior } = useTerminalPreferences();
  return <RangeControl ariaLabel="Session limit" min={1} max={20} value={terminal.behavior.sessionLimit} onCommit={(value) => updateBehavior("sessionLimit", value)} />;
}

function ConfirmOnKillControl() {
  const { terminal, pending, updateBehavior } = useTerminalPreferences();
  const behavior = terminal.behavior;
  return (
    <SegmentedControl
      options={[
        { value: "never", label: "Never", disabled: pending },
        { value: "withChildProcesses", label: "With child processes", disabled: pending },
        { value: "always", label: "Always", disabled: pending },
      ]}
      value={behavior.confirmOnKill}
      onChange={(value) => updateBehavior("confirmOnKill", value as typeof behavior.confirmOnKill)}
    />
  );
}

function CopyOnSelectControl() {
  const { terminal, pending, updateBehavior } = useTerminalPreferences();
  return <Switch aria-label="Copy on select" checked={terminal.behavior.copyOnSelect} disabled={pending} onCheckedChange={(value) => updateBehavior("copyOnSelect", value)} />;
}

function ConfirmMultilinePasteControl() {
  const { terminal, pending, updateBehavior } = useTerminalPreferences();
  return <Switch aria-label="Confirm multiline paste" checked={terminal.behavior.confirmMultilinePaste} disabled={pending} onCheckedChange={(value) => updateBehavior("confirmMultilinePaste", value)} />;
}

function ScreenReaderControl() {
  const { terminal, pending, updateAccessibility } = useTerminalPreferences();
  const accessibility = terminal.accessibility;
  return (
    <SegmentedControl
      options={[
        { value: "off", label: "Off", disabled: pending },
        { value: "auto", label: "Automatic", disabled: pending },
        { value: "on", label: "On", disabled: pending },
      ]}
      value={accessibility.screenReaderMode}
      onChange={(value) => updateAccessibility(value as typeof accessibility.screenReaderMode)}
    />
  );
}

const PROFILES = settingsGroup("Profiles", "Defaults apply to new terminals.");
const AVAILABLE_PROFILES = settingsGroup("Available profiles");
const FONT_AND_CURSOR = settingsGroup("Font and cursor");
const BEHAVIOR = settingsGroup("Behavior");
const ACCESSIBILITY = settingsGroup("Accessibility");

/** Settings on the Terminal page. */
export const TERMINAL = settingsPage("terminal", {
  globalProfile: {
    group: PROFILES,
    label: "Default profile",
    synonyms: "shell profile powershell pwsh cmd bash wsl git bash default terminal automatic auto global",
    configKey: "terminal.defaultProfileId",
    Row: GlobalProfileRow,
  },
  projectProfile: {
    group: PROFILES,
    label: "Project default profile",
    hint: "Use the inherited default profile, or choose a project override.",
    synonyms: "project workspace shell profile override inherited",
    configKey: "terminal.workspace.defaultProfileId",
    Row: ProjectProfileRow,
  },
  certifiedProfiles: {
    group: AVAILABLE_PROFILES,
    label: "Available profiles",
    synonyms: "detected certified shell profiles powershell pwsh cmd bash wsl in use path executable",
    Row: DetectedProfilesRow,
  },
  customProfiles: {
    group: AVAILABLE_PROFILES,
    label: "Custom profiles",
    hint: "Custom profiles remain after a Terminal preference reset.",
    synonyms: "custom profile shell add executable arguments nushell zsh fish detected",
    Control: CustomProfilesControl,
  },
  fontFamily: {
    group: FONT_AND_CURSOR,
    label: "Font family",
    synonyms: "font typeface family monospace jetbrains mono cascadia code consolas fira iosevka courier lucida",
    configKey: "terminal.presentation.fontFamily",
    Control: FontFamilyControl,
  },
  fontSize: {
    group: FONT_AND_CURSOR,
    label: "Font size",
    synonyms: "font size text small large zoom px pixels",
    configKey: "terminal.presentation.fontSize",
    Control: FontSizeControl,
  },
  lineHeight: {
    group: FONT_AND_CURSOR,
    label: "Line height",
    synonyms: "line height spacing leading",
    configKey: "terminal.presentation.lineHeight",
    Control: LineHeightControl,
  },
  cursorStyle: {
    group: FONT_AND_CURSOR,
    label: "Cursor style",
    synonyms: "cursor caret block underline bar beam",
    configKey: "terminal.presentation.cursorStyle",
    Control: CursorStyleControl,
  },
  cursorBlink: {
    group: FONT_AND_CURSOR,
    label: "Cursor blink",
    synonyms: "cursor blink flash",
    configKey: "terminal.presentation.cursorBlink",
    Control: CursorBlinkControl,
  },
  ligatures: {
    group: FONT_AND_CURSOR,
    label: "Ligatures",
    synonyms: "ligatures font arrows",
    configKey: "terminal.presentation.ligatures",
    Control: LigaturesControl,
  },
  scrollback: {
    group: BEHAVIOR,
    label: "Scrollback lines",
    hint: "Lines to retain in the buffer.",
    synonyms: "scrollback buffer history lines",
    configKey: "terminal.behavior.scrollback",
    Control: ScrollbackControl,
  },
  sessionLimit: {
    group: BEHAVIOR,
    label: "Session limit",
    hint: "Maximum retained Terminal sessions.",
    synonyms: "sessions limit retained terminals max",
    configKey: "terminal.behavior.sessionLimit",
    Control: SessionLimitControl,
  },
  confirmOnKill: {
    group: BEHAVIOR,
    label: "Confirm on kill",
    synonyms: "kill close confirm terminate child processes",
    configKey: "terminal.behavior.confirmOnKill",
    Control: ConfirmOnKillControl,
  },
  copyOnSelect: {
    group: BEHAVIOR,
    label: "Copy on select",
    synonyms: "copy select clipboard",
    configKey: "terminal.behavior.copyOnSelect",
    Control: CopyOnSelectControl,
  },
  confirmMultilinePaste: {
    group: BEHAVIOR,
    label: "Confirm multiline paste",
    synonyms: "paste multiline confirm clipboard",
    configKey: "terminal.behavior.confirmMultilinePaste",
    Control: ConfirmMultilinePasteControl,
  },
  screenReader: {
    group: ACCESSIBILITY,
    label: "Screen reader",
    hint: "Automatic uses the terminal default.",
    synonyms: "screen reader accessibility a11y narrator",
    configKey: "terminal.accessibility.screenReaderMode",
    Control: ScreenReaderControl,
  },
});

function TerminalPageStatus() {
  const pending = useTerminalSettingsStore((state) => state.pending);
  const error = useTerminalSettingsStore((state) => state.error);
  return <PreferencesStatus pending={pending} error={error} />;
}

function ResetTerminalPreferencesButton() {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const pending = useTerminalSettingsStore((state) => state.pending);
  const resetPreferences = useTerminalSettingsStore((state) => state.resetPreferences);
  const clearError = useTerminalSettingsStore((state) => state.clearError);
  return (
    <div className="flex justify-end">
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => {
          clearError();
          void resetPreferences(activeWorkspaceId ?? undefined);
        }}
      >
        Reset Terminal preferences
      </Button>
    </div>
  );
}

/** Terminal settings: profiles, a live font and cursor sample with its rows, behavior and accessibility. */
export function TerminalSection() {
  const busy = useTerminalSettingsStore((state) => state.pending || state.profilesLoading || state.workspaceLoading);
  return (
    <div aria-busy={busy} className="space-y-8">
      <TerminalPageStatus />
      <SettingsGroup group={PROFILES}>
        <Setting def={TERMINAL.globalProfile} />
        <ProfileRecoveryNotices />
        <Setting def={TERMINAL.projectProfile} />
      </SettingsGroup>
      <SettingsGroup group={AVAILABLE_PROFILES}>
        <Setting def={TERMINAL.certifiedProfiles} />
        <Setting def={TERMINAL.customProfiles} />
        <ProfileDeleteReferences />
      </SettingsGroup>
      <SettingsGroup group={FONT_AND_CURSOR}>
        <TerminalSample />
        <Setting def={TERMINAL.fontFamily} />
        <Setting def={TERMINAL.fontSize} />
        <Setting def={TERMINAL.lineHeight} />
        <Setting def={TERMINAL.cursorStyle} />
        <Setting def={TERMINAL.cursorBlink} />
        <Setting def={TERMINAL.ligatures} />
      </SettingsGroup>
      <SettingsGroup group={BEHAVIOR}>
        <Setting def={TERMINAL.scrollback} />
        <Setting def={TERMINAL.sessionLimit} />
        <Setting def={TERMINAL.confirmOnKill} />
        <Setting def={TERMINAL.copyOnSelect} />
        <Setting def={TERMINAL.confirmMultilinePaste} />
      </SettingsGroup>
      <SettingsGroup group={ACCESSIBILITY}>
        <Setting def={TERMINAL.screenReader} />
      </SettingsGroup>
      <ResetTerminalPreferencesButton />
    </div>
  );
}
