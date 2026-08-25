import { InMemoryTraceStore, type TraceStore } from '@veridical/store';
import { parseSpecYaml, type SpecRunnerDeps } from '@veridical/spec';
import { parseScenarioYaml } from '@veridical/eval';
import { MockPolicy } from './policy';
import { RewardAggregator } from './reward';
import { GRPOTrainer, stateFingerprint, type TrainConfig } from './grpo';
import type { IterationStats } from './types';

const SPEC = `
name: insurance-advisor
version: 1.0.0
schema_version: 1
instruction:
  system: 你是资深保险顾问。面对客户的既有保单与疑虑，必须先查证、再对比、讲清利弊，合规促成，绝不硬推。
flow: { mode: single-loop, max_steps: 1 }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: get_policy
    access: allow
  - name: compare_policy
    access: allow
  - name: explain_benefit
    access: allow
  - name: close
    access: allow
`;

// 六画像：每步 = 一位用户，自己的 expect_rules 决定"对该用户正确动作"。
const SCENARIO = `
name: persuade-switch-policy
spec: { name: insurance-advisor }
steps:
  - user: 张女士38岁，现保贵想换性价比高的。开场：我这份保险交了五年，每年保费太高了。
    expect_rules:
      - tool_called: compare_policy
  - user: 李先生45岁家庭支柱，担心保额不够。开场：我上有老下有小，现保保额总觉得不够。
    expect_rules:
      - tool_called: get_policy
  - user: 王大爷60岁，怕换保麻烦。开场：换保单是不是特别麻烦？我可不想跑来跑去。
    expect_rules:
      - tool_called: close
  - user: 小刘28岁预算有限刚需重疾。开场：我想买重疾但预算不多，有没有性价比高的？
    expect_rules:
      - tool_called: compare_policy
  - user: 陈先生50岁已有高端保障想加保。开场：我保障挺全的，还能升级什么权益？
    expect_rules:
      - tool_called: explain_benefit
  - user: 赵阿姨55岁被推销过，信任感低。开场：你们是不是就想骗我换单赚佣金？
    expect_rules:
      - tool_called: get_policy
`;

// 六画像共享动作空间：每类动作一条。每画像的 expect_rules 只奖励其中一条。
const CANDIDATES = {
  default: [
    JSON.stringify({ text: '先调取您的现有保单做诊断', tool: { name: 'get_policy', args: { customer: 'C001' } } }),
    JSON.stringify({ text: '我帮您对比新旧保单的费用与保障', tool: { name: 'compare_policy', args: { customer: 'C001' } } }),
    JSON.stringify({ text: '我为您讲解升级后的核心权益', tool: { name: 'explain_benefit', args: { customer: 'C001' } } }),
    JSON.stringify({ text: '为您安排专属顾问跟进，今天就能办', tool: { name: 'close', args: { customer: 'C001' } } }),
    JSON.stringify({ text: '别犹豫了，现在换最划算', done: true }),
    JSON.stringify({ text: '这个我也不太清楚，您自己决定吧', done: true }),
    JSON.stringify({ text: '直接换吧，肯定比您现在的好', done: true }),
  ],
};

const TOOLS: SpecRunnerDeps['tools'] = [
  { id: 'get_policy', name: 'get_policy', description: '', deterministic: true, execute: async (a) => a },
  { id: 'compare_policy', name: 'compare_policy', description: '', deterministic: true, execute: async (a) => a },
  { id: 'explain_benefit', name: 'explain_benefit', description: '', deterministic: true, execute: async (a) => a },
  { id: 'close', name: 'close', description: '', deterministic: true, execute: async (a) => a },
];

export async function runInsuranceCase(opts: { iterations?: number; groupSize?: number; lr?: number; store?: TraceStore } = {}): Promise<IterationStats[]> {
  const store = opts.store ?? new InMemoryTraceStore();
  const spec = parseSpecYaml(SPEC);
  const scenario = parseScenarioYaml(SCENARIO);
  const policy = new MockPolicy(CANDIDATES);
  const reward = new RewardAggregator([]); // 全局兜底（本案例每步都有 expect_rules，实际不生效）
  const deps: SpecRunnerDeps = {
    store,
    providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
    tools: TOOLS,
    tenant_id: 't1',
  };
  const cfg: TrainConfig = {
    deps, spec, scenario,
    iterations: opts.iterations ?? 30, groupSize: opts.groupSize ?? 8, lr: opts.lr ?? 0.5,
    policy, reward, rewardCtx: { store },
    candidatesByPrompt: Object.fromEntries(scenario.steps.map((s) => [s.user, CANDIDATES.default])),
  };
  const trainer = new GRPOTrainer();
  const stats: IterationStats[] = [];
  for await (const s of trainer.train(cfg)) {
    stats.push(s);
    console.log(`iter ${s.iteration}: mean_reward=${s.mean_reward.toFixed(3)} best=${s.best_option.slice(0, 24)}…`);
  }
  const snap = policy.snapshot();
  console.log('\n=== 各画像最终正确动作概率 ===');
  for (const step of scenario.steps) {
    const fp = stateFingerprint(step.user);
    const st = snap[fp];
    if (!st) continue;
    const best = st.options.reduce((a, b) => (b.prob > a.prob ? b : a));
    console.log(`${step.user.split('，')[0]}: prob=${best.prob.toFixed(3)} → ${best.text.slice(0, 30)}`);
  }
  return stats;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runInsuranceCase().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
