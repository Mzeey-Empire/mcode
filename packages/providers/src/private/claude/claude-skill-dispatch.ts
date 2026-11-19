/**
 * Claude Code expands a skill only when the last text block starts with `/`.
 * Its Skill tool refuses earlier user-only skills, so a note points Claude
 * to each one's file. Reading the file does not substitute `$ARGUMENTS`.
 */

/** A Claude skill the user can start with `/name`, keyed by that name. */
export interface ClaudeSkillTarget {
  readonly path: string;
  readonly userInvocationOnly: boolean;
}

/** Text blocks for a prompt with a recognized Claude skill mention. */
export interface ClaudeSkillDispatch {
  /** The whole prompt, or `undefined` when the last skill mention opens it. */
  readonly leadingText: string | undefined;
  /** `/name` plus everything after the last mention: the block Claude Code expands. */
  readonly commandText: string;
  /** Name of the skill Claude Code expands. */
  readonly skillName: string;
}

/** Plan the text blocks that make named skills available to Claude Code. */
export function planClaudeSkillDispatch(
  prompt: string,
  skills: ReadonlyMap<string, ClaudeSkillTarget>,
): ClaudeSkillDispatch | undefined {
  const mentions = [];
  for (const match of prompt.matchAll(/(?<!\S)\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g)) {
    const name = match[1];
    const target = skills.get(name);
    if (!target) continue;
    mentions.push({ name, target, start: match.index, end: match.index + match[0].length });
  }
  const last = mentions.pop();
  if (!last) return undefined;

  const commandText = prompt.slice(last.start).trimEnd();
  let leadingText: string | undefined;
  if (prompt.slice(0, last.start).trim()) {
    const noted = new Set([last.name]);
    let previousEnd = 0;
    let annotated = "";
    for (const mention of mentions) {
      if (!mention.target.userInvocationOnly || noted.has(mention.name)) continue;
      annotated += prompt.slice(previousEnd, mention.end);
      annotated += ` [The user invoked this skill. Follow the instructions at: ${mention.target.path}]`;
      previousEnd = mention.end;
      noted.add(mention.name);
    }
    leadingText = (annotated + prompt.slice(previousEnd)).trimEnd();
  }
  return { leadingText, commandText, skillName: last.name };
}
