import type {
  ProviderMcodeAttachment,
  ProviderMcodeAttachRequest,
  ProviderMcodePort,
} from "@mcode/providers";
import type { McodeMcpServer } from "./mcode-mcp-server.js";
import type { McodeSessionAuthority } from "./mcode-session-authority.js";

/** Dependencies for the Provider-facing `mcode` port. */
export interface McodeProviderPortOptions {
  authority: Pick<McodeSessionAuthority, "attach" | "retire">;
  /** Resolved per call: the server is built after the Provider host ports. */
  server: () => Pick<McodeMcpServer, "endpoint" | "closeSession">;
  /** Whether Browser automation can issue leases, which decides if the Browser toolkit applies. */
  isBrowserConfigured: () => boolean;
}

/** Gives Providers their per-session `mcode` MCP connection. */
export class McodeProviderPort implements ProviderMcodePort {
  constructor(private readonly options: McodeProviderPortOptions) {}

  async attach(request: ProviderMcodeAttachRequest): Promise<ProviderMcodeAttachment | null> {
    const url = this.options.server().endpoint();
    if (url === null) return null;
    const toolkits = { browser: this.options.isBrowserConfigured(), threadControl: request.threadControl };
    if (!toolkits.browser && !toolkits.threadControl) return null;
    const { token } = this.options.authority.attach(request);
    return { serverName: "mcode", url, token, toolkits };
  }

  async close(sessionId: string): Promise<void> {
    this.options.authority.retire(sessionId);
    await this.options.server().closeSession(sessionId);
  }
}
