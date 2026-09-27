import type { StoredAttachment } from "@mcode/contracts";

/** Data needed to decide which assistant body a completed execution persists. */
export interface AssistantMaterializationInput {
  content: string;
  model: string | null;
  attachments: StoredAttachment[];
  fromProvider: boolean;
}

interface BufferedBody {
  content: string;
  model: string | null;
  attachments: StoredAttachment[];
}

/** Volatile assistant state for one provider execution, with no persistence or transport dependencies. */
export class AssistantExecutionState {
  private streamingText = "";
  private bufferedBody: BufferedBody | undefined;
  private bufferedAttachments: StoredAttachment[] = [];
  private materialized = false;

  appendStreamingText(delta: string): void {
    this.streamingText += delta;
  }

  getStreamingText(): string {
    return this.streamingText;
  }

  resetStreamingText(): void {
    this.streamingText = "";
  }

  bufferBody(content: string, model: string | null, attachments = this.bufferedAttachments): void {
    this.bufferedBody = { content, model, attachments };
  }

  bufferAttachments(attachments: StoredAttachment[]): void {
    if (attachments.length === 0) return;
    const byId = new Map(this.bufferedAttachments.map((attachment) => [attachment.id, attachment]));
    for (const attachment of attachments) byId.set(attachment.id, attachment);
    this.bufferedAttachments = [...byId.values()];
  }

  getBufferedAttachments(): StoredAttachment[] {
    return this.bufferedAttachments;
  }

  hasBufferedBody(): boolean {
    return Boolean(this.bufferedBody?.content.trim() || this.streamingText.trim());
  }

  hasProviderBody(): boolean {
    return this.bufferedBody !== undefined;
  }

  hasMaterialized(): boolean {
    return this.materialized;
  }

  materializationInput(fallbackModel: string | null): AssistantMaterializationInput {
    const buffered = this.bufferedBody;
    if (buffered) {
      return {
        content: buffered.content,
        model: buffered.model,
        attachments: mergeAttachments(buffered.attachments, this.bufferedAttachments),
        fromProvider: true,
      };
    }
    return {
      content: this.streamingText.trim(),
      model: fallbackModel,
      attachments: this.bufferedAttachments,
      fromProvider: false,
    };
  }

  commitMaterialization(): void {
    this.streamingText = "";
    this.bufferedBody = undefined;
    this.bufferedAttachments = [];
    this.materialized = true;
  }
}

function mergeAttachments(first: StoredAttachment[], second: StoredAttachment[]): StoredAttachment[] {
  if (first.length === 0) return second;
  if (second.length === 0) return first;
  const byId = new Map(first.map((attachment) => [attachment.id, attachment]));
  for (const attachment of second) byId.set(attachment.id, attachment);
  return [...byId.values()];
}
