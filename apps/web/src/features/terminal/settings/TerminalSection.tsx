import { useEffect, useMemo, useState } from "react";
import type { TerminalCustomProfile, TerminalProfileReference } from "@mcode/contracts/models/terminal";
import type { TerminalPreferencesUpdate, TerminalSettings } from "@mcode/contracts/models/terminal-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTerminalSettingsStore } from "./terminalSettingsStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { RangeControl } from "@/components/settings/RangeControl";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SEARCH_HIT_CLASS, Setting, SettingRowFrame, useSettingHit } from "@/components/settings/Setting";
import { settingsGroup, settingsPage, type SettingDef, type SettingRowProps } from "@/components/settings/setting-def";
import { cn } from "@/lib/utils";

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

function ProfileSelect({
  value,
  certified,
  custom,
  disabled,
  onChange,
  allowInherit = false,
}: {
  value: string;
  certified: readonly { id: TerminalProfileReference; name: string }[];
  custom: readonly TerminalCustomProfile[];
  disabled?: boolean;
  onChange: (value: string) => void;
  allowInherit?: boolean;
}) {
  const selectedLabel = terminalProfileLabel(value, certified, custom);
  const unavailable = terminalProfileUnavailable(value, certified, custom);

  return (
    <Select value={value} onValueChange={(next) => { if (next) onChange(next); }} disabled={disabled}>
      <SelectTrigger aria-label={allowInherit ? "Workspace Terminal profile" : "Default Terminal profile"} className="w-full min-w-52 sm:w-64">
        <SelectValue>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {allowInherit ? <SelectItem value={INHERIT_PROFILE}>Use inherited global profile</SelectItem> : null}
        <SelectItem value="automatic">Automatic</SelectItem>
        {certified.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}
        {custom.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}
        {unavailable ? <SelectItem value={value}>{`Unavailable: ${profileName(value as TerminalProfileReference)}`}</SelectItem> : null}
      </SelectContent>
    </Select>
  );
}

function terminalProfileLabel(
  value: string,
  certified: readonly { id: TerminalProfileReference; name: string }[],
  custom: readonly TerminalCustomProfile[],
): string {
  if (value === INHERIT_PROFILE) return "Use inherited global profile";
  if (value === "automatic") return "Automatic";
  return certified.find((profile) => profile.id === value)?.name
    ?? custom.find((profile) => profile.id === value)?.name
    ?? `Unavailable: ${profileName(value as TerminalProfileReference)}`;
}

function terminalProfileUnavailable(
  value: string,
  certified: readonly { id: TerminalProfileReference; name: string }[],
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
 * that needs them: the page shows four profile rows, so later rows skip while a load is in flight.
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
  return {
    certifiedProfiles,
    certifiedOptions,
    customProfiles,
    recovery,
    profilesLoaded,
    profilesLoading,
    pending,
    globalDefault,
    automaticProfile: certifiedProfiles[0],
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

/** Global default profile; its hint names the profile Automatic resolves to, so the row draws it. */
function GlobalProfileRow({ def, variant }: SettingRowProps) {
  const profiles = useTerminalProfiles();
  const setGlobalDefault = useTerminalSettingsStore((state) => state.setGlobalDefault);
  return (
    <SettingRowFrame def={def} variant={variant} hint={globalProfileHint(profiles)}>
      <ProfileSelect
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

const NO_PROJECT_NOTICE = "Open a project to set a project default.";

function NoProjectNotice({ def }: { readonly def: SettingDef }) {
  const hit = useSettingHit([def]);
  return <p ref={hit.ref} {...hit.attrs} data-setting-id={def.id} className={cn(SEARCH_HIT_CLASS, "px-4 py-2.5 text-caption text-muted")}>{NO_PROJECT_NOTICE}</p>;
}

/** Project default profile; without an open project the page shows a notice in its place. */
function ProjectProfileRow({ def, variant }: SettingRowProps) {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  if (!activeWorkspaceId) {
    if (variant === "page") return <NoProjectNotice def={def} />;
    return <SettingRowFrame def={def} variant={variant}><p className="text-caption text-muted">{NO_PROJECT_NOTICE}</p></SettingRowFrame>;
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
        <ProfileSelect
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

function CustomProfileRow({
  profile,
  pending,
  onEdit,
  onDelete,
}: {
  readonly profile: TerminalCustomProfile;
  readonly pending: boolean;
  readonly onEdit: (profile: TerminalCustomProfile) => void;
  readonly onDelete: (profileId: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 px-3 py-2 text-xs">
      <span className="min-w-0 text-fade">
        {profile.name}
        <span className="ml-2 text-muted">{profile.executable}</span>
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

function CertifiedProfilesControl() {
  const profiles = useTerminalProfiles();
  return (
    <div className="grid min-w-52 gap-2 sm:min-w-64">
      {profiles.profilesLoading && !profiles.profilesLoaded ? <p className="text-xs text-muted">Loading profiles…</p> : null}
      {!profiles.profilesLoading && profiles.certifiedProfiles.length === 0 ? <p className="text-xs text-muted">No certified profiles detected.</p> : null}
      {profiles.certifiedProfiles.map((profile) => (
        <div key={profile.id} className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2 text-xs">
          <span className="min-w-0 text-fade">
            {profile.name}
            <span className="ml-2 text-muted">{profile.executable}</span>
          </span>
          <Badge variant="secondary" size="compact">Detected</Badge>
        </div>
      ))}
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
    <div className="grid min-w-52 gap-2 sm:min-w-64">
      {profiles.customProfiles.map((profile) => (
        <CustomProfileRow
          key={profile.id}
          profile={profile}
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
        Add custom profile
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

function handleFontFamilyKey(
  event: React.KeyboardEvent<HTMLInputElement>,
  resetFontFamilyDraft: () => void,
): void {
  if (event.key === "Enter") {
    event.preventDefault();
    event.currentTarget.blur();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    resetFontFamilyDraft();
  }
}

function FontFamilyControl() {
  const { terminal, updatePresentation } = useTerminalPreferences();
  const saved = terminal.presentation.fontFamily;
  const [draft, setDraft] = useState(saved);
  const [draftBase, setDraftBase] = useState(saved);
  // A persisted preference update must replace the unsaved draft.
  if (draftBase !== saved) {
    setDraftBase(saved);
    setDraft(saved);
  }
  const commit = () => {
    const value = draft.trim();
    if (!value) {
      setDraft(saved);
      return;
    }
    if (value !== saved) {
      updatePresentation("fontFamily", value);
    } else if (draft !== value) {
      setDraft(value);
    }
  };
  return (
    <Input
      aria-label="Terminal font family"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => handleFontFamilyKey(event, () => setDraft(saved))}
      maxLength={128}
      className="w-full sm:w-64"
    />
  );
}

function FontSizeControl() {
  const { terminal, pending, updatePresentation } = useTerminalPreferences();
  const presentation = terminal.presentation;
  return (
    <SegmentedControl
      options={(["xs", "sm", "md", "lg", "xl"] as const).map((value) => ({ value, label: value.toUpperCase(), disabled: pending }))}
      value={presentation.fontSize}
      onChange={(value) => updatePresentation("fontSize", value as typeof presentation.fontSize)}
    />
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

function CursorStyleControl() {
  const { terminal, pending, updatePresentation } = useTerminalPreferences();
  const presentation = terminal.presentation;
  return (
    <SegmentedControl
      options={(["block", "underline", "bar"] as const).map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1), disabled: pending }))}
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

const PROFILES = settingsGroup("Profiles and defaults", "Defaults apply to new terminals.");
const PRESENTATION = settingsGroup("Presentation");
const BEHAVIOR = settingsGroup("Behavior");
const ACCESSIBILITY = settingsGroup("Accessibility");

/** Settings on the Terminal page. */
export const TERMINAL = settingsPage("terminal", {
  globalProfile: {
    group: PROFILES,
    label: "Global default profile",
    synonyms: "shell profile powershell pwsh cmd bash wsl git bash default terminal automatic",
    configKey: "terminal.defaultProfileId",
    Row: GlobalProfileRow,
  },
  projectProfile: {
    group: PROFILES,
    label: "Project default profile",
    hint: "Use the inherited global profile, or choose a project override.",
    synonyms: "project workspace shell profile override inherited",
    configKey: "terminal.workspace.defaultProfileId",
    Row: ProjectProfileRow,
  },
  certifiedProfiles: {
    group: PROFILES,
    label: "Certified profiles",
    hint: "Detected profiles are read-only.",
    synonyms: "detected shell profiles powershell pwsh cmd bash wsl",
    Control: CertifiedProfilesControl,
  },
  customProfiles: {
    group: PROFILES,
    label: "Custom profiles",
    hint: "Custom profiles remain after a Terminal preference reset.",
    synonyms: "custom profile shell add executable arguments nushell zsh fish",
    Control: CustomProfilesControl,
  },
  fontFamily: {
    group: PRESENTATION,
    label: "Font family",
    hint: "Changes apply to new and open terminals.",
    synonyms: "font typeface family monospace jetbrains mono cascadia code consolas fira iosevka courier lucida",
    configKey: "terminal.presentation.fontFamily",
    Control: FontFamilyControl,
  },
  fontSize: {
    group: PRESENTATION,
    label: "Font size",
    synonyms: "font size text small large zoom px pixels",
    configKey: "terminal.presentation.fontSize",
    Control: FontSizeControl,
  },
  lineHeight: {
    group: PRESENTATION,
    label: "Line height",
    synonyms: "line height spacing leading",
    configKey: "terminal.presentation.lineHeight",
    Control: LineHeightControl,
  },
  cursorStyle: {
    group: PRESENTATION,
    label: "Cursor style",
    synonyms: "cursor caret block underline bar beam",
    configKey: "terminal.presentation.cursorStyle",
    Control: CursorStyleControl,
  },
  cursorBlink: {
    group: PRESENTATION,
    label: "Cursor blink",
    synonyms: "cursor blink flash",
    configKey: "terminal.presentation.cursorBlink",
    Control: CursorBlinkControl,
  },
  ligatures: {
    group: PRESENTATION,
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

/** Complete global, workspace, presentation, behavior, and accessibility Terminal settings. */
export function TerminalSection() {
  const busy = useTerminalSettingsStore((state) => state.pending || state.profilesLoading || state.workspaceLoading);
  return (
    <div aria-busy={busy} className="space-y-8">
      <TerminalPageStatus />
      <SettingsGroup group={PROFILES}>
        <Setting def={TERMINAL.globalProfile} />
        <ProfileRecoveryNotices />
        <Setting def={TERMINAL.projectProfile} />
        <Setting def={TERMINAL.certifiedProfiles} />
        <Setting def={TERMINAL.customProfiles} />
        <ProfileDeleteReferences />
      </SettingsGroup>
      <SettingsGroup group={PRESENTATION}>
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
