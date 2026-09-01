import { describe, expect, it } from 'vitest';
import { compileWorkspaceSpec, validateWorkspace, workspaceFromSpec } from '../src/workspace/graph/compiler';
import { simpleAgentGraph } from '../src/workspace/graph/model';
import { parse } from 'yaml';

describe('workspace graph', () => {
  it('compiles the simple agent capability graph into a runnable spec', () => {
    expect(validateWorkspace(simpleAgentGraph)).toEqual([]);
    const spec = parse(compileWorkspaceSpec(simpleAgentGraph));
    expect(spec.flow.loop).toEqual({ engine: 'orchestrator', strategy: 'direct' });
    expect(spec.tools).toEqual([{ name: 'search', access: 'allow' }]);
  });

  it('reconstructs input, agent, tools and output from a spec', () => {
    const spec = parse(compileWorkspaceSpec(simpleAgentGraph));
    const graph = workspaceFromSpec(spec);
    expect(graph.nodes.map((node) => node.type)).toEqual(['input', 'agent', 'tool', 'output']);
    expect(graph.edges.map((edge) => edge.kind)).toEqual(['message', 'capability', 'message']);
  });

  it('compiles capability bindings and output policy into the spec', () => {
    const graph = structuredClone(simpleAgentGraph);
    graph.nodes.find((node) => node.type === 'agent')!.config.outputProfile = 'structured';
    graph.nodes.push({ id: 'kb', type: 'condition', label: 'Knowledge', title: 'project-kb', description: '', position: { x: 30, y: 80 }, config: { kind: 'knowledge', backendId: 'native' } });
    const spec = parse(compileWorkspaceSpec(graph));
    expect(spec.output.profile).toBe('structured');
    expect(spec.capabilities.knowledge_backends).toEqual(['native']);
  });
});
