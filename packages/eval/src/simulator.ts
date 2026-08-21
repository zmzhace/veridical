import { Session, Recorder } from '@veridical/runtime';
import { runSpec, type RunResult, type SpecRunnerDeps } from '@veridical/spec';
import type { SpecRegistry } from '@veridical/spec';
import { evaluateRun, type EvalReport } from './evaluate';
import { ScenarioError, type Scenario } from './scenario';

export interface ScenarioReport {
  name: string;
  steps: { index: number; user: string; run: RunResult; report: EvalReport }[];
  passed: boolean;
}

export class Simulator {
  constructor(private deps: SpecRunnerDeps) {}

  async run(scenario: Scenario, registry: SpecRegistry): Promise<ScenarioReport> {
    const spec = await registry.resolve(scenario.spec.name, scenario.spec.version);
    if (!spec) throw new ScenarioError(`spec not found: ${scenario.spec.name}@${scenario.spec.version ?? 'latest'}`);

    const session = new Session({ session_id: 'eval_s1', tenant_id: this.deps.tenant_id, spec_version: spec.version });
    const recorder = new Recorder(this.deps.store, session);

    const steps: ScenarioReport['steps'] = [];
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      await recorder.record({ span_id: 'eval', parent_span_id: null, type: 'eval/run/start', verb: 'request', attempt: 1, duration_ms: 0, payload: { scenario: scenario.name, index: i, user: step.user } });
      const run = await runSpec(this.deps, spec, step.user);
      const rules = step.expect_rules ?? scenario.rules ?? [];
      const report = await evaluateRun(run, { rules });
      await recorder.record({ span_id: 'eval', parent_span_id: null, type: 'eval/step/end', verb: 'response', attempt: 1, duration_ms: 0, payload: { scenario: scenario.name, index: i, passed: report.passed } });
      steps.push({ index: i, user: step.user, run, report });
    }

    return { name: scenario.name, steps, passed: steps.every(s => s.report.passed) };
  }
}
