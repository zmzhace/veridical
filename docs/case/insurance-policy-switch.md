# 用 Agentic RL 训练「保单换购顾问」：完整案例

> 目标：让一个保险顾问 agent 学会对**不同画像的用户**用不同的合规打法吸引其换保，
> 并把监管合规编码成奖励规则。本文档是方法与流程说明；可运行演示见下文。

## 1. 业务背景

保险顾问的核心工作不是"推销"，而是帮客户评估**是否值得换保**（费用、保障缺口、权益升级）。
真实场景有两个难点：客户画像差异大（价格敏感/保额不足/怕麻烦/预算有限/已有保障/信任感低），
以及**合规红线**（不能硬推、不能无依据推荐、要讲清利弊与犹豫期）。

本案例用 veridical 的 agentic RL 骨架训练 agent：对不同画像选不同正确动作，且所有动作都合规。

## 2. 吸引换保的六步转化漏斗

1. **破冰/信任建立** — 确认客户诉求，不急于推销
2. **现状摸底** `get_policy` — 读取现有保单，找出缺口（保额/费率/缺失保障）
3. **需求挖掘** — 家庭/收入/风险敞口，个性化
4. **缺口放大 + 对比** `compare_policy` — 新旧方案对照（费用与保障）
5. **利益量化** — 每年省 ¥X / 保额 +¥Y / 权益升级
6. **促成** `close` — 处理异议 → 预约顾问/行动

全程合规：先查证再开口、讲清利弊、不硬推、留痕。

## 3. 用户画像库（六种用户）

| 画像 | 特征 | 顾虑/触发点 | 正确动作（该画像奖励规则） |
|---|---|---|---|
| 张女士 38 价格敏感 | 现保偏贵、重性价比 | 换保每年能省多少 | `compare_policy` |
| 李先生 45 家庭支柱 | 保额不足 | 缺口多大 | `get_policy` |
| 王大爷 60 怕麻烦 | 犹豫、怕手续 | 换保麻烦吗 | `close` |
| 小刘 28 预算有限 | 刚需重疾 | 保额/保费比 | `compare_policy` |
| 陈先生 50 已有保障 | 高端加保 | 权益升级 | `explain_benefit` |
| 赵阿姨 55 信任感低 | 被推销过 | 是否套路 | `get_policy`（先查证建立信任） |

## 4. Agentic RL 流程

**规格（Spec）**：`insurance-advisor`，单轮决策（max_steps 1），工具
`get_policy/compare_policy/explain_benefit/close`。

**场景（Scenario）**：六步，每步 = 一位画像（背景 + 开场），各带自己的 `expect_rules`。
`GRPOTrainer` 按 `[...(step.expect_rules), ...(scenario.rules)]` 打分（与 eval `Simulator` 一致），
所以每个画像独立学自己的正确动作。

**动作空间（Candidates）**：六画像共享一组 JSON decision 动作——
四个合规动作（调 get_policy/compare_policy/explain_benefit/close）+ 三个不合规动作
（逼单/敷衍/无依据推荐）。GRPO 学的是"对哪个画像选哪个动作"。

**训练**：GRPO grouped sampling（每画像一个 fingerprint 状态，独立收敛）；
advantage `(r-mean)/std`；policy-weighted 采样使 mean_reward 随策略集中而上升。

**评估/蒸馏/上线（生产化路线）**：
- 回放比对 `ReplayEngine` 对 golden trace 验发散；
- LLM judge 对 transcript 给连续分；
- 训练结束把每画像 best action 蒸馏成 skill 进 long-term memory，运行时 recall 复用；
- 上线：把学到的"画像→动作"策略接进真实对话（当前骨架以 MockPolicy 演示，换真 LLM 只换 policy 实现）。

## 5. 可运行演示

```bash
# 独立跑 GRPO 训练（六画像）
./packages/server/node_modules/.bin/tsx packages/rl/src/case-insurance.ts
# 或 web：pnpm dev:server + pnpm dev:web → http://localhost:5173/rl → 选"换保单案例" → Train
```

预期：mean_reward 上升；六画像各自收敛——张女士/小刘→compare_policy，
李先生/赵阿姨→get_policy，王大爷→close，陈先生→explain_benefit，prob>0.9。

## 6. 奖励塑形与诚实标注的局限

- 当前 reward 以规则 AND 为主；画像级区分靠每步 `expect_rules`，每条只奖励一个正确动作。
- 多工具多动作同时正确（`pass_requirement: any`）、per-turn process reward、
  LLM judge、多轮对话 credit assignment 是生产化方向，本次未实现。
- 骨架用 MockPolicy 模拟策略；真 LLM 需要 logprob 支持（生产化路线）。

## 7. 合规说明

奖励规则本身即合规检查器：`tool_called: get_policy` 先查证、`close` 才促成、
不合规动作 reward=0。这保证 agent 学到的"吸引换保"始终在合规边界内。
