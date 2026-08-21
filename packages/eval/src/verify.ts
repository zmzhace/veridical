import type { TraceEvent } from '@veridical/schema';
import { RuleEngine } from './engine';
import type { Rule } from './rules';

export function verifyFromRules(rules: Rule[]): (events: TraceEvent[]) => boolean {
  const engine = new RuleEngine(rules);
  return (events) => engine.evaluate(events).passed;
}
