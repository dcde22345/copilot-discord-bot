export interface McpRemoteServerConfig {
    type: "http" | "sse";
    url: string;
    tools?: string[];
}
export interface McpLocalServerConfig {
    type: "local" | "stdio";
    command: string;
    args?: string[];
    /** Passed to the MCP subprocess (same as Copilot CLI `.mcp.json`). */
    env?: Record<string, string>;
    tools?: string[];
}
export interface CustomAgentConfig {
    name: string;
    prompt: string;
    [key: string]: unknown;
}
export interface SessionConfigState {
    model?: string;
    streaming?: boolean;
    availableTools?: string[];
    excludedTools?: string[];
    mcpServers?: Record<string, McpRemoteServerConfig | McpLocalServerConfig> | null;
    customAgents?: CustomAgentConfig[] | null;
    skillDirectories?: string[];
    disabledSkills?: string[];
    autoApprovePermissions?: boolean;
}
export declare function defaultSessionConfig(defaultModel: string): SessionConfigState;
//# sourceMappingURL=SessionConfigState.d.ts.map