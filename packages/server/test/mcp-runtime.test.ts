import { expect, test } from 'vitest';
import { executeMcpTool } from '../src/production/mcp-runtime';

test('MCP runtime fails closed for incomplete transport configuration', async () => {
  await expect(
    executeMcpTool({ id: 'broken', transport: 'streamable-http', toolName: 'search' }, {}),
  ).rejects.toThrow('mcp_transport_configuration_missing');
});

test('MCP runtime rejects unsafe tool names before connecting', async () => {
  await expect(
    executeMcpTool(
      { id: 'server', transport: 'stdio', command: 'node', toolName: 'server/search' },
      {},
    ),
  ).rejects.toThrow('invalid_mcp_tool_name');
});
