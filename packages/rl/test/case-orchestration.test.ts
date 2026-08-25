import { describe, it, expect } from 'vitest';
import { runOrchestrationRL } from '../src/case-orchestration';
import { stateFingerprint } from '../src/grpo';

const CORRECT: [string, string][] = [
  ['张女士想对比新旧保单', 'compare-agent'],
  ['李先生想查理赔记录', 'claims-agent'],
];

describe('orchestration RL case', () => {
  it('supervisor converges to dispatch the right expert per persona', async () => {
    const stats = await runOrchestrationRL({ iterations: 30, groupSize: 8, lr: 0.5 });
    const last = stats[stats.length - 1];
    for (const [user, tool] of CORRECT) {
      const fp = stateFingerprint(user);
      const st = last.policy[fp];
      expect(st, `no policy state for ${user}`).toBeTruthy();
      const correct = st.options.find((o: any) => o.text.includes(tool));
      expect(correct, `${user} should converge to ${tool}`).toBeTruthy();
      expect(correct!.prob).toBeGreaterThan(0.8);
    }
  });
});
