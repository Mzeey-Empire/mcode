/**
 * Lexical DecoratorNode for /command slash-command chips.
 *
 * Renders an inline entity token with a namespace-specific icon and the command name.
 * Serializes as `/<commandName>` for plain-text extraction.
 */
import type { JSX } from "react";
import {
  DecoratorNode,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
} from "lexical";
import {
  ProviderCapabilityIdentitySchema,
  type ProviderCapabilityIdentity,
} from "@mcode/contracts";
import { EntityToken } from "../EntityToken";
import { shortenPathPrefixedName } from "../command-name";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The origin namespace of a slash command: built-in, skill, or plugin. */
export type SlashCommandNamespace = "skill" | "mcode" | "plugin" | "command";

/** JSON-serialized form of a SlashCommandNode for editor state persistence. */
export interface SerializedSlashCommandNode extends SerializedLexicalNode {
  readonly type: "slash-command";
  readonly commandName: string;
  readonly namespace: SlashCommandNamespace;
  readonly capabilityIdentity?: ProviderCapabilityIdentity;
  readonly path?: string;
}

/** Valid namespace values for deserialisation fallback. */
const VALID_NAMESPACES = new Set<SlashCommandNamespace>(["skill", "mcode", "plugin", "command"]);

// ---------------------------------------------------------------------------
// SlashCommandChip (React component rendered by decorate())
// ---------------------------------------------------------------------------

function SlashCommandChip({
  commandName,
  namespace,
}: {
  readonly commandName: string;
  readonly namespace: SlashCommandNamespace;
}): JSX.Element {
  return (
    <EntityToken
      kind={namespace}
      label={`/${shortenPathPrefixedName(commandName)}`}
      tone="composer"
      invocation
    />
  );
}

// ---------------------------------------------------------------------------
// SlashCommandNode (Lexical DecoratorNode)
// ---------------------------------------------------------------------------

export class SlashCommandNode extends DecoratorNode<JSX.Element> {
  __commandName: string;
  __namespace: SlashCommandNamespace;
  __capabilityIdentity?: ProviderCapabilityIdentity;
  __path?: string;

  static getType(): string {
    return "slash-command";
  }

  static clone(node: SlashCommandNode): SlashCommandNode {
    return new SlashCommandNode(
      node.__commandName,
      node.__namespace,
      node.__capabilityIdentity,
      node.__path,
      node.__key,
    );
  }

  constructor(
    commandName: string,
    namespace: SlashCommandNamespace,
    capabilityIdentity?: ProviderCapabilityIdentity,
    path?: string,
    key?: NodeKey,
  ) {
    super(key);
    this.__commandName = commandName;
    this.__namespace = namespace;
    this.__capabilityIdentity = capabilityIdentity;
    this.__path = path;
  }

  // -- Accessors ------------------------------------------------------------

  getCommandName(): string {
    return this.getLatest().__commandName;
  }

  getNamespace(): SlashCommandNamespace {
    return this.getLatest().__namespace;
  }

  getCapabilityIdentity(): ProviderCapabilityIdentity | undefined {
    return this.getLatest().__capabilityIdentity;
  }

  getPath(): string | undefined {
    return this.getLatest().__path;
  }

  // -- Behavior -------------------------------------------------------------

  isInline(): boolean {
    return true;
  }

  getTextContent(): string {
    return `/${this.getCommandName()}`;
  }

  // -- DOM ------------------------------------------------------------------

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.style.display = "inline";
    return span;
  }

  updateDOM(): false {
    return false;
  }

  // -- Serialization --------------------------------------------------------

  exportJSON(): SerializedSlashCommandNode {
    return {
      type: "slash-command",
      commandName: this.__commandName,
      namespace: this.__namespace,
      ...(this.__capabilityIdentity ? { capabilityIdentity: this.__capabilityIdentity } : {}),
      ...(this.__path ? { path: this.__path } : {}),
      version: 1,
    };
  }

  static importJSON(
    serializedNode: SerializedSlashCommandNode,
  ): SlashCommandNode {
    const ns = VALID_NAMESPACES.has(serializedNode.namespace)
      ? serializedNode.namespace
      : "mcode";
    const identity = ProviderCapabilityIdentitySchema().safeParse(
      serializedNode.capabilityIdentity,
    );
    return $createSlashCommandNode(
      serializedNode.commandName,
      ns,
      identity.success ? identity.data : undefined,
      serializedNode.path,
    );
  }

  // -- Decoration -----------------------------------------------------------

  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return (
      <SlashCommandChip
        commandName={this.__commandName}
        namespace={this.__namespace}
      />
    );
  }
}

// ---------------------------------------------------------------------------
// Helper exports
// ---------------------------------------------------------------------------

/** Create a new SlashCommandNode with the given name and namespace. */
export function $createSlashCommandNode(
  commandName: string,
  namespace: SlashCommandNamespace,
  capabilityIdentity?: ProviderCapabilityIdentity,
  path?: string,
): SlashCommandNode {
  return new SlashCommandNode(commandName, namespace, capabilityIdentity, path);
}

/** Type guard: returns true when the node is a SlashCommandNode. */
export function $isSlashCommandNode(
  node: LexicalNode | null | undefined,
): node is SlashCommandNode {
  return node instanceof SlashCommandNode;
}
