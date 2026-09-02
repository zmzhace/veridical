import { describe, expect, it } from 'vitest';
import {
  compileWorkspaceSpec,
  validateWorkspace,
  workspaceFromSpec,
} from '../src/workspace/graph/compiler';
import { simpleAgentGraph } from '../src/workspace/graph/model';
import { parse } from 'yaml';

describe('workspace graph', () => {
  it('compiles the simple task-first graph into a runnable spec', () => {
    expect(validateWorkspace(simpleAgentGraph)).toEqual([]);
    const spec = parse(compileWorkspaceSpec(simpleAgentGraph));
    expect(spec.flow.loop).toEqual({ engine: 'orchestrator', strategy: 'direct' });
    expect(spec.tools).toEqual([]);
  });

  it('keeps capabilities inside Agent configuration when reconstructing a spec', () => {
    const spec = parse(compileWorkspaceSpec(simpleAgentGraph));
    const graph = workspaceFromSpec(spec);
    expect(graph.nodes.map((node) => node.type)).toEqual(['input', 'agent', 'output']);
    expect(graph.edges.map((edge) => edge.kind)).toEqual(['message', 'message']);
    expect(graph.nodes.find((node) => node.type === 'agent')?.config.memoryScopes).toEqual([
      'turn',
      'task',
    ]);
  });

  it('compiles capability bindings and output policy into the spec', () => {
    const graph = structuredClone(simpleAgentGraph);
    graph.nodes.find((node) => node.type === 'agent')!.config.outputProfile = 'structured';
    graph.nodes.push({
      id: 'kb',
      type: 'condition',
      label: 'Knowledge',
      title: 'project-kb',
      description: '',
      position: { x: 30, y: 80 },
      config: { kind: 'knowledge', backendId: 'native' },
    });
    const spec = parse(compileWorkspaceSpec(graph));
    expect(spec.output.profile).toBe('structured');
    expect(spec.capabilities.knowledge_backends).toEqual(['native']);
  });

  it('preserves namespaced MCP tool bindings instead of slugifying them', () => {
    const graph = structuredClone(simpleAgentGraph);
    graph.nodes.push({
      id: 'mcp-tool',
      type: 'tool',
      label: 'Tool',
      title: 'research-tools/search',
      description: '研究检索',
      position: { x: 40, y: 70 },
      config: { source: 'mcp', serverRef: 'research-tools@1.0.0', access: 'allow' },
    });
    graph.edges.push({
      id: 'mcp-tool-agent',
      source: 'mcp-tool',
      target: 'agent',
      kind: 'capability',
    });
    const spec = parse(compileWorkspaceSpec(graph));
    expect(spec.tools).toEqual([{ name: 'research-tools/search', access: 'allow' }]);
    expect(spec.capabilities.mcp_servers).toEqual(['research-tools@1.0.0']);
  });
});
