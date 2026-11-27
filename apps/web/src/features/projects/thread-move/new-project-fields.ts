import { joinPaths } from "@/lib/path";

// These mirror the server's checks in `workspace-move-files.ts` so the dialog gives the verdict before the
// request. The server stays the authority: a rejection it sends maps to the same copy through `describeFieldRefusal`.
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** The server's refusal texts that name a field the user can fix. Anything else is not about one field. */
const SERVER_REFUSALS = {
  invalidName: "Invalid project name",
  duplicateName: "A project with this name already exists",
  destinationExists: "Project destination already exists",
  relativeLocation: "Project location must be an absolute folder",
} as const;

export type NewProjectField = "name" | "location";

export interface FieldProblem {
  readonly field: NewProjectField;
  readonly message: string;
}

export interface NewProjectValues {
  readonly name: string;
  readonly location: string;
}

export const LOCATION_PROBLEM = "Enter a full path, such as ~/src.";

const CHARACTER_PROBLEM = "Use letters, numbers, dots, dashes or underscores.";

function reservedProblem(name: string): string {
  return `${name} can't be used as a folder name. Choose another name.`;
}

function duplicateProblem(name: string): string {
  return `A project named ${name} already exists. Choose another name.`;
}

/** The path the folder would end up at, as the user would read it. */
export function destinationPath(values: NewProjectValues): string {
  return joinPaths(values.location.trim(), values.name);
}

function isFolderNameReserved(name: string): boolean {
  return name.endsWith(".") || name.endsWith(" ") || WINDOWS_RESERVED_NAME.test(name);
}

/**
 * What is wrong with a project name, or null. An empty name has no problem to show: the button waits for one. The
 * name is not trimmed, because the server does not trim it, so a trailing space is a real verdict.
 */
export function nameProblem(name: string, projectNames: readonly string[]): string | null {
  if (name === "") return null;
  if (isFolderNameReserved(name)) return reservedProblem(name);
  if (!NAME_PATTERN.test(name)) return CHARACTER_PROBLEM;
  const lowered = name.toLowerCase();
  return projectNames.some((existing) => existing.toLowerCase() === lowered) ? duplicateProblem(name) : null;
}

function isFullPath(location: string): boolean {
  return location === "~"
    || location.startsWith("~/")
    || location.startsWith("~\\")
    || location.startsWith("/")
    || location.startsWith("\\\\")
    || WINDOWS_DRIVE_PATH.test(location);
}

/** What is wrong with a typed Location, or null. An empty one has no problem to show, as an empty name has none. */
export function locationProblem(location: string): string | null {
  const trimmed = location.trim();
  return trimmed === "" || isFullPath(trimmed) ? null : LOCATION_PROBLEM;
}

export function isSubmittable(values: NewProjectValues, projectNames: readonly string[]): boolean {
  return values.name !== ""
    && values.location.trim() !== ""
    && nameProblem(values.name, projectNames) === null
    && locationProblem(values.location) === null;
}

/**
 * Words for a refusal the server sent before touching the folder, when it is about one field the user can fix.
 * Returns null for any other refusal, which the dialog reports as a failed move.
 */
export function describeFieldRefusal(error: string, values: NewProjectValues): FieldProblem | null {
  switch (error) {
    case SERVER_REFUSALS.invalidName:
      return { field: "name", message: nameProblem(values.name, []) ?? CHARACTER_PROBLEM };
    case SERVER_REFUSALS.duplicateName:
      return { field: "name", message: duplicateProblem(values.name) };
    case SERVER_REFUSALS.destinationExists:
      return { field: "name", message: `${destinationPath(values)} already exists. Choose another name or location.` };
    case SERVER_REFUSALS.relativeLocation:
      return { field: "location", message: LOCATION_PROBLEM };
    default:
      return null;
  }
}

/** The message under each field, or null for a field with nothing wrong. */
export interface FieldMessages {
  readonly name: string | null;
  readonly location: string | null;
}

/**
 * What to say under each field. The client's own verdict comes first, so a typo shows before any request; a refusal
 * the server sent for these exact values fills in a field the client has no objection to, such as a folder that
 * already exists.
 */
export function fieldMessages(values: NewProjectValues, projectNames: readonly string[], serverProblem: FieldProblem | null): FieldMessages {
  return {
    name: nameProblem(values.name, projectNames) ?? (serverProblem?.field === "name" ? serverProblem.message : null),
    location: locationProblem(values.location) ?? (serverProblem?.field === "location" ? serverProblem.message : null),
  };
}
