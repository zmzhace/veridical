import type { LLMProvider, LLMRequest, LLMResponse } from '@veridical/llm';
import type { RunnerStepCtx } from '@veridical/spec';

export interface Decision { text?: string; tool?: { name: string; args: unknown }; done?: boolean }

export function parseDecision(raw: string): Decision {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return { text: raw };
  try {
    const obj = JSON.parse(trimmed);
    return { text: obj.text, tool: obj.tool, done: obj.done };
  } catch {
    return { text: raw };
  }
}

export function makeDecisionRunStep(getProvider: () => LLMProvider) {
  return async function decisionRunStep({ spec, recorder, prompt }: RunnerStepCtx): Promise<{ text: string; tool?: { name: string; args: unknown } }> {
    const req: LLMRequest = { provider: spec.llm.provider, model: spec.llm.model, messages: [{ role: 'system', content: spec.instruction.system }, { role: 'user', content: prompt }] };
    const res: LLMResponse = await getProvider().complete(req);
    const d = parseDecision(res.text);
    return { text: d.text ?? res.text, tool: d.tool };
  };
}
