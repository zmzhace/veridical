import { describe, it, expect } from 'vitest';
import { runTransferRL } from '../src/case-transfer';
import { stateFingerprint } from '../src/grpo';

describe('transfer RL case', () => {
  it('trains stage-internal decisions end-to-end (mean_reward converges)', async () => {
    const stats = await runTransferRL({ iterations: 40, groupSize: 8, lr: 0.5 });
    const last = stats[stats.length - 1];
    expect(last.mean_reward).toBeGreaterThan(0.7);
    // 2 personas × 3 stages converge to the right tool per stage
    for (const user of ['张先生40岁有慢性病想转保', '李女士35岁旧保单交了很多年想转保']) {
      const fpHealth = stateFingerprint(`health_check:${user}`);
      const fpClose = stateFingerprint(`close:${user}`);
      expect(last.policy[fpHealth]?.options.find((o: any) => o.text.includes('"name":"verify_health"'))?.prob ?? 0).toBeGreaterThan(0.6);
      expect(last.policy[fpClose]?.options.find((o: any) => o.text.includes('"name":"submit_transfer"'))?.prob ?? 0).toBeGreaterThan(0.6);
    }
  });
});