import { stringify } from 'yaml';
import type { WorkspaceGraph } from './model';

export function compileWorkspaceSpec(graph: WorkspaceGraph): string {
  const agent = graph.nodes.find((node) => node.type === 'agent');
  if (!agent) throw new Error('画布需要一个 Agent 节点');
  const tools = graph.edges.filter((edge) => edge.kind === 'capability' && edge.target === agent.id).map((edge) => graph.nodes.find((node) => node.id === edge.source)).filter(Boolean);
  return stringify({
    name: graph.id, version: '1.0.0', schema_version: 1,
    instruction: { system: String(agent.config.instruction ?? agent.description) },
    flow: { mode: 'single-loop', max_steps: Number(agent.config.maxSteps ?? 8), loop: { engine: 'orchestrator', strategy: 'direct' } },
    llm: { provider: 'local', model: String(agent.config.model ?? 'configured'), fallback: [] },
    tools: tools.map((tool) => ({ name: tool!.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || tool!.id, access: String(tool!.config.access ?? 'ask') })),
    skills: [], agents: [],
  });
}
