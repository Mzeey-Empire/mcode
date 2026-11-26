import { WS_METHODS } from "@mcode/contracts/ws/methods";

const MAX_SLUG_LENGTH = 24;
const FOLDER_NAME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})-(?:([a-z0-9]+(?:-[a-z0-9]+)*)-)?(.{36})$/;

/** Name a No project folder using the local day, the first message's words, and the workspace ID. */
export function noProjectFolderName(id: string, nameHint: string | undefined, date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const localDay = `${year}-${month}-${day}`;

  const words = (nameHint ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let slug = words.slice(0, 4).join("-");
  if (slug.length > MAX_SLUG_LENGTH) {
    const wordBoundary = slug.lastIndexOf("-", MAX_SLUG_LENGTH);
    slug = slug.slice(0, wordBoundary === -1 ? MAX_SLUG_LENGTH : wordBoundary);
  }

  return slug ? `${localDay}-${slug}-${id}` : `${localDay}-${id}`;
}

/** Extract the workspace ID from a managed No project folder name. */
export function noProjectIdFromFolderName(name: string): string | null {
  const match = FOLDER_NAME_PATTERN.exec(name);
  if (!match) return null;

  const [, year, month, day, slug, id] = match;
  const parsed = WS_METHODS()["workspace.createNoProject"].params.shape.id.safeParse(id);
  if (!parsed.success) return null;

  // The sweep can delete any folder whose name this parser accepts.
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return noProjectFolderName(parsed.data, slug, date) === name ? parsed.data : null;
}
