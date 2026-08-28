import { ruleOutcomeEquals, type Rule } from './rules';
import { RuleEngine, type RuleReport } from './engine';
import type { RunResult } from '@veridical/spec';
import type { LLMUsage } from '@veridical/llm';
import type { LLMJudge } from './judge';

export interface LLMJudgeConfig { provider: string; model: string; rubric: string }
export interface EvalConfig {
  rules?: Rule[];
  golden?: unknown;
  judge?: LLMJudgeConfig;
  pass_requirement?: 'all' | 'any';
}
export interface EvalReport {
  reason?: 'no_checks' | 'judge_unavailable';
  rules?: RuleReport;
  judge?: { passed: boolean; reasoning: string; tokens: LLMUsage };
  passed: boolean;
}

export async function evaluateRun(result: RunResult, config: EvalConfig, judge?: LLMJudge): Promise<EvalReport> {
  const rules = [...(config.rules ?? []), ...(config.golden !== undefined ? [ruleOutcomeEquals(config.golden)] : [])];
  if (config.judge && !judge) return { passed: false, reason: 'judge_unavailable' };
  if (rules.length === 0 && !config.judge) return { passed: false, reason: 'no_checks' };
  const rulesReport = rules.length > 0 ? new RuleEngine(rules).evaluate(result.events) : undefined;

  let judgeReport: EvalReport['judge'];
  if (config.judge && judge) {
    const v = await judge.judge(result, config.judge.rubric);
    judgeReport = { passed: v.passed, reasoning: v.reasoning, tokens: v.tokens };
  }

  const rulePassed = rulesReport ? (config.pass_requirement === 'any' ? rulesReport.rules.some(r => r.passed) : rulesReport.passed) : true;
  const passed = rulePassed && (judgeReport ? judgeReport.passed : true);

  return { rules: rulesReport, judge: judgeReport, passed };
}
