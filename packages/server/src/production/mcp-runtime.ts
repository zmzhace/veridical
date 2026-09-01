import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import type { ProductionTool } from './runner';

export type McpRuntimeConfig = {
  id: string;
  transport: 'streamable-http' | 'stdio';
  endpoint?: string;
  command?: string;
  args?: string[];
  credentialRef?: string;
  toolName: string;
};

/** Execute one MCP tool call with a short-lived client; no credentials are returned to callers. */
export async function executeMcpTool(
  config: McpRuntimeConfig,
  args: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!config.toolName || config.toolName.includes('/')) throw new Error('invalid_mcp_tool_name');
  const client = new Client({ name: 'veridical', version: '1.0.0' }, { capabilities: {} });
  const credential = config.credentialRef ? process.env[config.credentialRef] : undefined;
  const transport =
    config.transport === 'streamable-http'
      ? config.endpoint
        ? new StreamableHTTPClientTransport(new URL(config.endpoint), {
            requestInit: credential
              ? { headers: { Authorization: `Bearer ${credential}` } }
              : undefined,
          })
        : undefined
      : config.command
        ? new StdioClientTransport({
            command: config.command,
            args: config.args ?? [],
            stderr: 'pipe',
          })
        : undefined;
  if (!transport) throw new Error('mcp_transport_configuration_missing');
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  const abort = () => transport.close().catch(() => undefined);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await client.connect(transport);
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    return await client.callTool(
      { name: config.toolName, arguments: args as Record<string, unknown> },
      undefined,
      signal ? { signal } : undefined,
    );
  } finally {
    signal?.removeEventListener('abort', abort);
    await client.close().catch(() => undefined);
  }
}

/** Turn a reviewed, fixed MCP binding into the same Tool contract as built-ins. */
export function createMcpProductionTool(config: McpRuntimeConfig): ProductionTool {
  return {
    name: `${config.id}/${config.toolName}`,
    version: 'mcp-1',
    description: `MCP ${config.id} · ${config.toolName}`,
    readOnly: true,
    schema: z.unknown(),
    execute: (args, context) => executeMcpTool(config, args, context.signal),
  };
}
