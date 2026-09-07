/**
 * MCP (Model Context Protocol) Runtime & Tool Manager.
 *
 * Discovers and coordinates external tool servers compliant with the Model Context Protocol.
 * Tools are exposed to CodeRelay agents independent of the active model or provider.
 */

export interface McpServerConfig {
  readonly id: string;
  readonly name: string;
  readonly transport: 'stdio' | 'sse';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly enabled: boolean;
}

export interface McpToolDefinition {
  readonly serverId: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export class McpManager {
  private readonly servers = new Map<string, McpServerConfig>();
  private readonly tools = new Map<string, McpToolDefinition>();

  constructor(initialServers?: readonly McpServerConfig[]) {
    if (initialServers) {
      for (const s of initialServers) {
        this.servers.set(s.id, s);
      }
    }
  }

  registerServer(config: McpServerConfig): void {
    this.servers.set(config.id, config);
  }

  toggleServer(serverId: string, enabled: boolean): void {
    const s = this.servers.get(serverId);
    if (s) {
      this.servers.set(serverId, { ...s, enabled });
    }
  }

  listServers(): readonly McpServerConfig[] {
    return [...this.servers.values()];
  }

  registerTool(tool: McpToolDefinition): void {
    this.tools.set(`${tool.serverId}:${tool.name}`, tool);
  }

  listTools(): readonly McpToolDefinition[] {
    return [...this.tools.values()];
  }
}
