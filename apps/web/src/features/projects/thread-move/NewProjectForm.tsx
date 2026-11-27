import { useId, type ReactNode, type Ref } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FolderBrowseButton } from "./FolderBrowseButton";
import type { FieldMessages, NewProjectValues } from "./new-project-fields";

interface NewProjectFormProps {
  readonly values: NewProjectValues;
  readonly initGit: boolean;
  readonly messages: FieldMessages;
  readonly nameFieldRef?: Ref<HTMLInputElement>;
  /** Locks every control while the move runs. */
  readonly locked: boolean;
  /** An error about the Location itself, shown under it. While it shows, the field takes the error state. */
  readonly locationNotice?: ReactNode;
  readonly onChange: (values: NewProjectValues) => void;
  readonly onInitGitChange: (initGit: boolean) => void;
}

export function NewProjectForm({ values, initGit, messages, nameFieldRef, locked, locationNotice, onChange, onInitGitChange }: NewProjectFormProps) {
  const nameId = useId();
  const locationId = useId();
  const gitId = useId();
  const nameErrorId = `${nameId}-error`;
  const locationErrorId = `${locationId}-error`;
  return (
    <fieldset disabled={locked} className="grid min-w-0 gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor={nameId} className="text-caption text-muted">Name</Label>
        <Input
          id={nameId}
          ref={nameFieldRef}
          size="compact"
          value={values.name}
          placeholder="Project name"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={messages.name !== null || undefined}
          aria-describedby={messages.name === null ? undefined : nameErrorId}
          onChange={(event) => onChange({ ...values, name: event.target.value })}
        />
        {messages.name === null ? null : <FieldError id={nameErrorId}>{messages.name}</FieldError>}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={locationId} className="text-caption text-muted">Location</Label>
        <div className="flex items-start gap-2">
          <Input
            id={locationId}
            size="compact"
            value={values.location}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 font-code text-caption"
            aria-invalid={messages.location !== null || Boolean(locationNotice) || undefined}
            aria-describedby={messages.location === null ? undefined : locationErrorId}
            onChange={(event) => onChange({ ...values, location: event.target.value })}
          />
          <FolderBrowseButton startPath={values.location} disabled={locked} onPick={(location) => onChange({ ...values, location })} />
        </div>
        {messages.location === null ? null : <FieldError id={locationErrorId}>{messages.location}</FieldError>}
      </div>
      {locationNotice}
      <div className="flex items-center gap-2">
        <Checkbox id={gitId} checked={initGit} aria-labelledby={`${gitId}-label`} onCheckedChange={(checked) => onInitGitChange(checked)} />
        <Label id={`${gitId}-label`} htmlFor={gitId} className="text-body-small font-normal">Start a git repo</Label>
      </div>
    </fieldset>
  );
}
