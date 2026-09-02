import { stringify } from 'yaml';
import type { WorkspaceGraph } from './model';
import type { AgentSpec } from '@veridical/spec/schema';

export function compileWorkspaceSpec(graph: WorkspaceGraph, version = '1.0.0'): string {
  const agent = graph.nodes.find((node) => node.type === 'agent');
  if (!agent) throw new Error('画布需要一个 Agent 节点');
  const nodeTools = graph.edges
    .filter((edge) => edge.kind === 'capability' && edge.target === agent.id)
    .map((edge) => graph.nodes.find((node) => node.id === edge.source))
    .filter(Boolean);
  const nodeSkills = graph.edges
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
  const bindings = Array.isArray(agent.config.capabilityBindings)
    ? (agent.config.capabilityBindings as Array<Record<string, unknown>>)
    : [];
  const boundTools = bindings.filter((binding) => binding.kind === 'tool');
  const boundSkills = bindings.filter((binding) => binding.kind === 'skill');
  const boundMcp = bindings.filter((binding) => binding.kind === 'mcp');
  const boundMemory = bindings.filter((binding) => binding.kind === 'memory');
  const boundKnowledge = bindings.filter((binding) => binding.kind === 'knowledge');
  const mcpServers = nodeTools
    .filter(
      (tool) =>
        tool!.title.includes('/') || tool!.title.includes('.') || tool!.config.source === 'mcp',
    )
    .map((tool) => String(tool!.config.serverRef ?? tool!.title.split('.')[0]))
    .filter(Boolean)
    .concat(boundMcp.map((binding) => String(binding.capability_id)));
  const toolEntries = [
    ...nodeTools.map((tool) => {
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
    ...boundTools.map((binding) => ({
      name: String(binding.capability_id),
      access: String(
        binding.access ??
          (binding.risk === 'write' || binding.risk === 'destructive' ? 'ask' : 'allow'),
      ),
    })),
    ...boundMcp.flatMap((binding) =>
      (Array.isArray(binding.selected_children) ? binding.selected_children : []).map((tool) => ({
        name: `${String(binding.capability_id)}/${String(tool)}`,
        access: String(binding.access ?? 'ask'),
      })),
    ),
  ].filter(
    (entry, index, all) => all.findIndex((candidate) => candidate.name === entry.name) === index,
  );
  const skillEntries = [
    ...nodeSkills.map((skill) => ({
      name: skill!.title,
      version: String(skill!.config.version ?? '1.0.0'),
      status: String(skill!.config.status ?? 'draft'),
      source: 'workspace',
      description: skill!.description,
      procedure: String(skill!.config.procedure ?? skill!.description),
      tags: [],
    })),
    ...boundSkills.map((binding) => ({
      name: String(binding.display_name ?? binding.capability_id).split('@')[0],
      version: String(binding.version ?? String(binding.capability_id).split('@')[1] ?? '1.0.0'),
      status: 'approved',
      source: 'capability-registry',
      description: String(binding.summary ?? '版本化工作方法'),
      tags: [],
      ...(binding.content_hash ? { content_hash: String(binding.content_hash) } : {}),
    })),
  ].filter(
    (entry, index, all) =>
      all.findIndex(
        (candidate) =>
          `${candidate.name}@${candidate.version}` === `${entry.name}@${entry.version}`,
      ) === index,
  );
  const strategy = String(agent.config.strategy ?? 'direct');
  let outputSchema = agent.config.outputSchema;
  if (typeof agent.config.outputSchemaText === 'string' && agent.config.outputSchemaText.trim()) {
    try {
      outputSchema = JSON.parse(agent.config.outputSchemaText);
    } catch {
      outputSchema = { type: 'object', properties: {} };
    }
  }
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
      ...(outputSchema ? { schema: outputSchema } : {}),
      ...(agent.config.outputProfile === 'report' ? { artifact_mime_type: 'text/markdown' } : {}),
    },
    capabilities: {
      mcp_servers: [...new Set(mcpServers)],
      knowledge_backends: [
        ...knowledge.map((node) => String(node!.config.backendId ?? node!.title)),
        ...boundKnowledge.map((binding) => String(binding.capability_id)),
      ].filter(Boolean),
      memory_scopes: Array.isArray(agent.config.memoryScopes)
        ? agent.config.memoryScopes.map(String)
        : memories.length || boundMemory.length
          ? ['turn', 'task', 'project']
          : ['turn', 'task'],
      tool_selection: agent.config.toolSelection === 'catalog' ? 'catalog' : 'bound',
      tool_creation: agent.config.toolCreation === 'draft' ? 'draft' : 'disabled',
      bindings: bindings.map((binding) => ({
        capability_id: String(binding.capability_id),
        kind: String(binding.kind),
        ...(binding.version ? { version: String(binding.version) } : {}),
        ...(binding.access ? { access: String(binding.access) } : {}),
        ...(binding.activation ? { activation: String(binding.activation) } : {}),
        ...(Array.isArray(binding.selected_children)
          ? { selected_children: binding.selected_children.map(String) }
          : {}),
      })),
    },
    tools: toolEntries,
    skills: skillEntries,
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
  const main = graph.nodes.find((node) => node.type === 'agent');
  if (
    main?.config.outputProfile === 'structured' &&
    typeof main.config.outputSchemaText === 'string'
  ) {
    try {
      JSON.parse(main.config.outputSchemaText);
    } catch {
      errors.push('结构化输出的 JSON Schema 格式不正确');
    }
  }
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
  const hasBindings = Boolean(spec.capabilities?.bindings?.length);
  const capabilityBindings = hasBindings
    ? spec.capabilities!.bindings.map((binding) => ({ ...binding }))
    : [
        ...spec.tools.map((tool) => ({
          capability_id: tool.name,
          kind: 'tool',
          access: tool.access,
        })),
        ...spec.skills.map((skill) => ({
          capability_id: `${skill.name}@${skill.version}`,
          kind: 'skill',
          version: skill.version,
          activation: 'auto',
          display_name: skill.name,
          summary: skill.description,
          content_hash: skill.content_hash,
        })),
        ...(spec.capabilities?.mcp_servers ?? []).map((server) => ({
          capability_id: server,
          kind: 'mcp',
          selected_children: [],
        })),
        ...(spec.capabilities?.knowledge_backends ?? []).map((source) => ({
          capability_id: source,
          kind: 'knowledge',
        })),
      ];
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
          toolSelection: spec.capabilities?.tool_selection ?? 'bound',
          toolCreation: spec.capabilities?.tool_creation ?? 'disabled',
          memoryScopes: spec.capabilities?.memory_scopes ?? ['turn', 'task'],
          capabilityBindings,
        },
      },
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
