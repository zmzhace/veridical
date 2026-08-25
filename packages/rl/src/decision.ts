import type { AgentSpec } from '@veridical/spec';

export function decisionStepFrom(chosen: string) {
  return async function step(ctx: { spec: AgentSpec; prompt: string }) {
    const trimmed = chosen.trim();
    if (!trimmed.startsWith('{')) return { text: trimmed };
    try {
      const obj = JSON.parse(trimmed);
      return { text: obj.text ?? trimmed, tool: obj.tool };
    } catch {
      return { text: trimmed };
    }
  };
}
