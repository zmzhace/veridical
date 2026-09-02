import { stringify } from 'yaml';
import type { WorkspaceGraph } from './model';
import type { AgentSpec } from '@veridical/spec/schema';

export function compileWorkspaceSpec(graph: WorkspaceGraph, version = '1.0.0'): string {
  const agent = graph.nodes.find((node) => node.type === 'agent');
  if (!agent) throw new Error('画布需要一个 Agent 节点');
  const tools = graph.edges
    .filter((edge) => edge.kind === 'capability' && edge.target === agent.id)
    .map((edge) => graph.nodes.find((node) => node.id === edge.source))
    .filter(Boolean);
  const skills = graph.edges
    .filter((edge) => edge.kind === 'instruction' && edge.target === agent.id)
    .map((edge) => graph.nodes.find((node) => node.id === edge.source))
    .filter(Boolean);
  const delegates = graph.edges
    .filter((edge) => edge.kind === 'delegate' && edge.source === agent.id)
    .map((edge) => graph.nodes.find((node) => node.id === edge.target))
    .filter(Boolean);
  const memories = graph.nodes.filter((node) => node.type === 'memory');
  const knowledge = graph.nodes.filter(
    (node) => node.type === 'condition' && String(node.config.kind ?? '') === 'knowledge',
  );
  const mcpServers = tools
    .filter(
      (tool) =>
        tool!.title.includes('/') || tool!.title.includes('.') || tool!.config.source === 'mcp',
    )
    .map((tool) => String(tool!.config.serverRef ?? tool!.title.split('.')[0]))
    .filter(Boolean);
  const strategy = String(agent.config.strategy ?? 'direct');
  const mode =
    strategy === 'supervisor'
      ? 'supervisor'
      : strategy === 'stage-gate'
        ? 'stage-gate'
        : 'single-loop';
  return stringify({
    name: graph.id,
    version,
    schema_version: 1,
    description: graph.name,
    instruction: { system: String(agent.config.instruction ?? agent.description) },
    flow: {
      mode,
      max_steps: Number(agent.config.maxSteps ?? 8),
      loop: { engine: 'orchestrator', strategy },
      ...(mode === 'stage-gate' ? { stages: [{ id: 'main' }] } : {}),
    },
    llm: { provider: 'local', model: String(agent.config.model ?? 'configured'), fallback: [] },
    output: {
      profile: String(agent.config.outputProfile ?? 'conversational'),
      message_format: String(agent.config.messageFormat ?? 'markdown'),
      strict: agent.config.outputStrict !== false,
      repair_attempts: Number(agent.config.outputRepairAttempts ?? 1),
      ...(agent.config.outputSchema ? { schema: agent.config.outputSchema } : {}),
    },
    capabilities: {
      mcp_servers: [...new Set(mcpServers)],
      knowledge_backends: knowledge
        .map((node) => String(node!.config.backendId ?? node!.title))
        .filter(Boolean),
      memory_scopes: memories.length ? ['turn', 'task', 'project'] : ['turn', 'task'],
      tool_selection: agent.config.toolSelection === 'catalog' ? 'catalog' : 'bound',
      tool_creation: agent.config.toolCreation === 'draft' ? 'draft' : 'disabled',
    },
    tools: tools.map((tool) => {
      const configuredName = String(tool!.config.name ?? tool!.title).trim();
      const slug = configuredName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const name =
        tool!.config.source === 'mcp' || configuredName.includes('/')
          ? configuredName
          : slug || tool!.id;
      return { name, access: String(tool!.config.access ?? 'ask') };
    }),
    skills: skills.map((skill) => ({
      name: skill!.title,
      version: String(skill!.config.version ?? '1.0.0'),
      status: String(skill!.config.status ?? 'draft'),
      source: 'workspace',
      description: skill!.description,
      procedure: String(skill!.config.procedure ?? skill!.description),
      tags: [],
    })),
    agents: delegates.map((delegate) => ({
      name: delegate!.title,
      spec_ref: String(delegate!.config.specRef ?? delegate!.id),
    })),
  });
}

export function validateWorkspace(graph: WorkspaceGraph): string[] {
  const errors: string[] = [];
  const agents = graph.nodes.filter((node) => node.type === 'agent');
  if (agents.length !== 1) errors.push('基础工作区需要且只能有一个主 Agent');
  if (!graph.nodes.some((node) => node.type === 'input')) errors.push('缺少输入节点');
  if (!graph.nodes.some((node) => node.type === 'output')) errors.push('缺少输出节点');
  for (const edge of graph.edges) {
    if (
      !graph.nodes.some((node) => node.id === edge.source) ||
      !graph.nodes.some((node) => node.id === edge.target)
    )
      errors.push(`连线 ${edge.id} 引用了不存在的节点`);
  }
  return errors;
}

export function workspaceFromSpec(spec: AgentSpec): WorkspaceGraph {
  const graph: WorkspaceGraph = {
    id: spec.name,
    name: spec.description || spec.name,
    status: 'draft',
    nodes: [
      {
        id: 'input',
        type: 'input',
        label: 'Chat Input',
        title: '用户输入',
        description: '会话消息和任务入口',
        position: { x: 12, y: 34 },
        config: {},
      },
      {
        id: 'agent',
        type: 'agent',
        label: 'Agent',
        title: spec.name,
        description: spec.instruction.system,
        position: { x: 44, y: 34 },
        config: {
          model: spec.llm.model,
          provider: spec.llm.provider,
          instruction: spec.instruction.system,
          maxSteps: spec.flow.max_steps,
          outputProfile: spec.output.profile,
          messageFormat: spec.output.message_format,
          outputStrict: spec.output.strict,
          outputRepairAttempts: spec.output.repair_attempts,
          outputSchema: spec.output.schema,
        },
      },
      ...spec.tools.map((tool, index) => ({
        id: `tool-${index}`,
        type: 'tool' as const,
        label: 'Tool',
        title: tool.name,
        description: `权限：${tool.access}`,
        position: { x: 38 + index * 12, y: 68 },
        config: {
          name: tool.name,
          access: tool.access,
          ...(tool.name.includes('/') ? { source: 'mcp', serverRef: tool.name.split('/')[0] } : {}),
        },
      })),
      ...spec.skills.map((skill, index) => ({
        id: `skill-${index}`,
        type: 'skill' as const,
        label: 'Skill',
        title: skill.name,
        description: skill.description ?? skill.procedure ?? '版本化行为指令',
        position: { x: 30 + index * 14, y: 84 },
        config: {
          version: skill.version,
          status: skill.status,
          skillKey: `${skill.name}@${skill.version}`,
          procedure: skill.procedure,
        },
      })),
      ...(spec.capabilities?.memory_scopes?.length
        ? [
            {
              id: 'memory',
              type: 'memory' as const,
              label: 'Memory',
              title: 'Memory',
              description: '按策略读取和保存上下文',
              position: { x: 20, y: 68 },
              config: { scopes: spec.capabilities.memory_scopes },
            },
          ]
        : []),
      ...(spec.capabilities?.knowledge_backends ?? []).map((backend, index) => ({
        id: `knowledge-${index}`,
        type: 'condition' as const,
        label: 'Knowledge',
        title: backend,
        description: '授权知识检索后端',
        position: { x: 22 + index * 14, y: 52 },
        config: { kind: 'knowledge', backendId: backend },
      })),
      ...spec.agents.map((delegate, index) => ({
        id: `child-agent-${index}`,
        type: 'child-agent' as const,
        label: 'Child Agent',
        title: delegate.name,
        description: '由主 Agent 委派任务',
        position: { x: 58 + index * 14, y: 84 },
        config: { specRef: delegate.spec_ref },
      })),
      {
        id: 'output',
        type: 'output',
        label: 'Chat Output',
        title: '助手输出',
        description: '返回最终结果',
        position: { x: 78, y: 34 },
        config: {},
      },
    ],
    edges: [],
  };
  graph.edges = [
    { id: 'input-agent', source: 'input', target: 'agent', kind: 'message' },
    ...spec.tools.map((_, index) => ({
      id: `tool-${index}-agent`,
      source: `tool-${index}`,
      target: 'agent',
      kind: 'capability' as const,
    })),
    ...spec.skills.map((_, index) => ({
      id: `skill-${index}-agent`,
      source: `skill-${index}`,
      target: 'agent',
      kind: 'instruction' as const,
    })),
    ...(spec.capabilities?.memory_scopes?.length
      ? [{ id: 'memory-agent', source: 'memory', target: 'agent', kind: 'memory' as const }]
      : []),
    ...(spec.capabilities?.knowledge_backends ?? []).map((_, index) => ({
      id: `knowledge-${index}-agent`,
      source: `knowledge-${index}`,
      target: 'agent',
      kind: 'control' as const,
    })),
    ...spec.agents.map((_, index) => ({
      id: `child-agent-${index}-agent`,
      source: 'agent',
      target: `child-agent-${index}`,
      kind: 'delegate' as const,
    })),
    { id: 'agent-output', source: 'agent', target: 'output', kind: 'message' },
  ];
  return graph;
}
