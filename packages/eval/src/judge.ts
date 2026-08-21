import type { TraceEvent } from '@veridical/schema';
import type { LLMGateway, LLMUsage } from '@veridical/llm';
import type { RunResult } from '@veridical/spec';
import { InMemoryTraceStore, type TraceStore } from '@veridical/store';
import { Session, Recorder } from '@veridical/runtime';

export class JudgeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeParseError';
  }
}

function transcriptOf(events: TraceEvent[]): string {
  return events
    .filter(e => ['user.message', 'assistant.message', 'tool.called', 'tool.result'].includes(e.type))
    .map(e => {
      const p = e.payload as any;
      switch (e.type) {
        case 'user.message': return `user: ${p.text}`;
        case 'assistant.message': return `assistant: ${p.text}`;
        case 'tool.called': return `tool_called: ${p.name}(${JSON.stringify(p.args)})`;
        default: return `tool_result: ${JSON.stringify(p.result)}`;
      }
    })
    .join('\n');
}

export class LLMJudge {
  constructor(
    private llm: LLMGateway,
    private provider: string,
    private model: string,
    private store: TraceStore = new InMemoryTraceStore(),
  ) {}

  async judge(run: RunResult, rubric: string): Promise<{ passed: boolean; reasoning: string; tokens: LLMUsage }> {
    const tenantId = run.events[0]?.tenant_id ?? 'unknown';
    const session = new Session({ session_id: run.session_id, tenant_id: tenantId, spec_version: run.spec_version });
    const recorder = new Recorder(this.store, session);
    const req = {
      provider: this.provider,
      model: this.model,
      messages: [
        { role: 'system', content: 'You are a rigorous evaluator. Judge the agent run against the rubric. Respond with JSON only: {"passed": boolean, "reasoning": string}.' },
        { role: 'user', content: `Rubric:\n${rubric}\n\nTranscript:\n${transcriptOf(run.events)}` },
      ],
    };
    const res = await this.llm.complete(req, recorder);
    const parsed = this.parseVerdict(res.text);
    return { ...parsed, tokens: res.usage };
  }

  private parseVerdict(text: string): { passed: boolean; reasoning: string } {
    try {
      const obj = JSON.parse(text);
      if (typeof obj.passed !== 'boolean' || typeof obj.reasoning !== 'string') {
        throw new Error('missing passed or reasoning');
      }
      return { passed: obj.passed, reasoning: obj.reasoning };
    } catch (err) {
      throw new JudgeParseError(`could not parse judge verdict: ${text}`);
    }
  }
}
