import type { Rule } from './rules';

export interface RuleReport {
  rules: { name: string; passed: boolean; detail?: string }[];
  passed: boolean;
}

export class RuleEngine {
  constructor(private rules: Rule[]) {}

  evaluate(events: Parameters<Rule['check']>[0]): RuleReport {
    const results = this.rules.map(r => ({ name: r.name, ...r.check(events) }));
    return { rules: results, passed: results.every(r => r.passed) };
  }
}
