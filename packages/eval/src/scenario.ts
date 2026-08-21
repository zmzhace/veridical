import { parse as parseYaml } from 'yaml';
import { ruleOutcomeEquals, ruleTextContains, ruleToolCalled, ruleToolNotDenied, ruleNoErrors, type Rule } from './rules';

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioError';
  }
}

export type RuleDecl =
  | { outcome_equals: unknown }
  | { text_contains: string; role?: 'assistant' | 'user' }
  | { tool_called: string }
  | { tool_not_denied: string }
  | { no_errors: true };

export function ruleFromDecl(decl: RuleDecl): Rule {
  if ('outcome_equals' in decl) return ruleOutcomeEquals(decl.outcome_equals);
  if ('text_contains' in decl) return ruleTextContains(decl.text_contains, decl.role);
  if ('tool_called' in decl) return ruleToolCalled(decl.tool_called);
  if ('tool_not_denied' in decl) return ruleToolNotDenied(decl.tool_not_denied);
  if ('no_errors' in decl) return ruleNoErrors();
  throw new ScenarioError(`unknown rule decl: ${JSON.stringify(decl)}`);
}

export function ruleDeclsToRules(decls: RuleDecl[]): Rule[] {
  return decls.map(ruleFromDecl);
}

export interface ScenarioStep {
  user: string;
  expect_rules?: Rule[];
}
export interface Scenario {
  name: string;
  description?: string;
  spec: { name: string; version?: string };
  rules?: Rule[];
  steps: ScenarioStep[];
}

export function parseScenarioYaml(yaml: string): Scenario {
  const raw = parseYaml(yaml) as any;
  if (!raw || typeof raw.name !== 'string' || !raw.spec?.name || !Array.isArray(raw.steps)) {
    throw new ScenarioError('scenario must have name, spec.name, and steps[]');
  }
  return {
    name: raw.name,
    description: raw.description,
    spec: { name: raw.spec.name, version: raw.spec.version },
    rules: raw.rules ? ruleDeclsToRules(raw.rules as RuleDecl[]) : undefined,
    steps: (raw.steps as any[]).map((s) => ({
      user: s.user,
      expect_rules: s.expect_rules ? ruleDeclsToRules(s.expect_rules as RuleDecl[]) : undefined,
    })),
  };
}
