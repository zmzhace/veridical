import { describe, it, expect } from 'vitest';
import { runInsuranceCase } from '../src/case-insurance';
import { stateFingerprint } from '../src/grpo';

const CORRECT = [
  ['张女士38岁，现保贵想换性价比高的。开场：我这份保险交了五年，每年保费太高了。', 'compare_policy'],
  ['李先生45岁家庭支柱，担心保额不够。开场：我上有老下有小，现保保额总觉得不够。', 'get_policy'],
  ['王大爷60岁，怕换保麻烦。开场：换保单是不是特别麻烦？我可不想跑来跑去。', 'close'],
  ['小刘28岁预算有限刚需重疾。开场：我想买重疾但预算不多，有没有性价比高的？', 'compare_policy'],
  ['陈先生50岁已有高端保障想加保。开场：我保障挺全的，还能升级什么权益？', 'explain_benefit'],
  ['赵阿姨55岁被推销过，信任感低。开场：你们是不是就想骗我换单赚佣金？', 'get_policy'],
] as const;

describe('insurance-switch case', () => {
  it('each persona converges to its own correct action', async () => {
    const stats = await runInsuranceCase({ iterations: 30, groupSize: 8, lr: 0.5 });
    const last = stats[stats.length - 1];
    for (const [user, tool] of CORRECT) {
      const fp = stateFingerprint(user);
      const st = last.policy[fp];
      expect(st, `no policy state for persona: ${user.slice(0, 8)}`).toBeTruthy();
      const correct = st.options.find((o: any) => o.text.includes(tool));
      expect(correct, `persona ${user.slice(0, 8)} should converge to ${tool}`).toBeTruthy();
      expect(correct!.prob).toBeGreaterThan(0.8);
    }
  });
});
