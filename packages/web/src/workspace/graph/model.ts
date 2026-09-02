export type WorkspaceNodeType =
  | 'input'
  | 'agent'
  | 'tool'
  | 'skill'
  | 'memory'
  | 'condition'
  | 'child-agent'
  | 'output';

export interface WorkspaceNode {
  id: string;
  type: WorkspaceNodeType;
  label: string;
  title: string;
  description: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

export interface WorkspaceEdge {
  id: string;
  source: string;
  target: string;
  kind: 'message' | 'capability' | 'instruction' | 'memory' | 'delegate' | 'control';
}

export interface WorkspaceGraph {
  id: string;
  name: string;
  status: 'draft' | 'tested' | 'published';
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
}

export const simpleAgentGraph: WorkspaceGraph = {
  id: 'research-agent',
  name: '研究助手',
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
      title: '研究助手',
      description: '负责理解任务并组织步骤',
      position: { x: 44, y: 34 },
      config: {
        model: 'server-default',
        instruction: '帮助用户完成研究任务，引用可靠证据并说明不确定性。',
        maxSteps: 8,
        capabilityBindings: [],
      },
    },
    {
      id: 'output',
      type: 'output',
      label: 'Chat Output',
      title: '助手输出',
      description: '返回最终回答和结构化结果',
      position: { x: 78, y: 34 },
      config: {},
    },
  ],
  edges: [
    { id: 'input-agent', source: 'input', target: 'agent', kind: 'message' },
    { id: 'agent-output', source: 'agent', target: 'output', kind: 'message' },
  ],
};
