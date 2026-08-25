import type { TraceStore } from '@veridical/store';
import { evaluateRun, LLMJudge, type EvalConfig } from '@veridical/eval';
import { RunComparator } from '@veridical/replay';
import type { RunResult } from '@veridical/spec';

export interface RewardBreakdown { rule: number; replay: number; process: number; judge: number }
export interface RewardCtx { store: TraceStore; goldenSessionId?: string; judge?: LLMJudge; rubric?: string }

const DEFAULTS = { rule: 1, replay: 1, process: 0.5, judge: 0.5 };

export class RewardAggregator {
  constructor(private rules: EvalConfig['rules'], private weights: Partial<RewardBreakdown> = {}) {}

  async score(run: RunResult, ctx: RewardCtx): Promise<{ reward: number; breakdown: RewardBreakdown }> {
    const w = { ...DEFAULTS, ...this.weights };

    let rule = 0;
    if (this.rules && this.rules.length > 0) {
      const rep = await evaluateRun(run, { rules: this.rules });
      rule = rep.passed ? 1 : 0;
    }

    let replay = 0;
    if (ctx.goldenSessionId) {
      const cmp = new RunComparator(ctx.store);
      const diff = await cmp.compare(ctx.goldenSessionId, run.session_id);
      replay = diff.summary.identical ? 1 : -1;
    }

    let process = 0;
    const steps = run.events.filter((e) => e.type === 'step/end');
    if (steps.length > 0) {
      const errors = run.events.filter((e) => (e.type === 'tool.result' || e.type === 'llm.response') && e.verb === 'error').length;
      process = Math.max(0, 1 - errors / steps.length);
    }

    let judge = 0;
    if (ctx.judge) {
      const v = await ctx.judge.judge(run, ctx.rubric ?? 'follow the rules');
      judge = v.passed ? 1 : 0;
    }

    const effW = {
      rule: this.rules && this.rules.length > 0 ? w.rule : 0,
      replay: ctx.goldenSessionId ? w.replay : 0,
      process: run.events.some((e) => e.type === 'step/end') ? w.process : 0,
      judge: ctx.judge ? w.judge : 0,
    };
    const totalW = effW.rule + effW.replay + effW.process + effW.judge;
    const reward = totalW === 0 ? 0 : (rule * effW.rule + replay * effW.replay + process * effW.process + judge * effW.judge) / totalW;
    return { reward, breakdown: { rule, replay, process, judge } };
  }
}
