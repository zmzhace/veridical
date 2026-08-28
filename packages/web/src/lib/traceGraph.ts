import type { TraceEvent } from '@veridical/schema';

export interface TraceNode {
  id: string;
  parent?: string;
  path: string;
  actor: string;
  operation: string;
  status: string;
  start: TraceEvent;
  end?: TraceEvent;
  depth: number;
}

/** Pair only explicit invocation identities; never infer a tool result from global order. */
export function traceGraph(events: TraceEvent[]): TraceNode[] {
  const nodes = new Map<string, TraceNode>();
  const ends = new Map<string, TraceEvent>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const p = event.payload as any;
    const id = event.invocation_id ?? p?.invocation_id;
    if (!id) continue;
    if (event.type === 'invocation.end') ends.set(id, event);
    if (event.type === 'invocation.start')
      nodes.set(id, {
        id,
        parent: p?.parent_invocation_id ?? event.parent_invocation_id,
        path: p?.path ?? event.path ?? '',
        actor: p?.actor ?? 'loop',
        operation: p?.operation ?? event.type,
        status: 'started',
        start: event,
        depth: 0,
      });
  }
  for (const node of nodes.values()) {
    node.end = ends.get(node.id);
    node.status = (node.end?.payload as any)?.status ?? 'started';
    const seen = new Set([node.id]);
    let parent = node.parent;
    while (parent && nodes.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      node.depth++;
      parent = nodes.get(parent)?.parent;
    }
  }
  return [...nodes.values()].sort((a, b) => a.start.seq - b.start.seq);
}

export const statusLabel: Record<string, string> = {
  started: '未结束',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
  blocked: '已阻止',
};
export const actorLabel: Record<string, string> = {
  agent: 'Agent',
  llm: 'LLM',
  tool: '工具',
  memory: '记忆',
  loop: '流程',
  join: '汇合',
};
