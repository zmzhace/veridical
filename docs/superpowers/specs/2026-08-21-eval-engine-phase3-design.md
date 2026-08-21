# Veridical — 评测引擎（Phase 3）设计文档

- 日期：2026-08-21
- 状态：设计评审通过（Phase 3 范围）
- 前置：Phase 1 核心运行时 + Phase 2 Agent Spec 系统（`@veridical/spec`）已合并至 main

## 1. 背景与目标

Phase 1 建立了 trace 中心运行时；Phase 2 让 agent 变成"声明式 spec + 可运行"。Phase 3 在之上加**评测引擎**：跑完一个 agent 之后，用同一根尺子判定它做得怎么样。

- 规则/黄金答案（确定性判定）。
- LLM-judge（自然语言 rubric 评审 trace）。
- scenario simulator（多轮脚本驱动 + 逐轮判定）——模拟用户与 agent 的多轮交互并压测。

**核心原则：同一根尺子。** 运行时单步 verify 和离线评测共用同一个 `RuleEngine`。运行时用它在行动后判定"这一步结果是否可接受"，评测用它对全量 trace 判定"这次运行是否达标"——判定口径由同一实现保证，运行时与离线永远不背离。

### 决策依据（Phase 3 范围确认）

- **范围**：三项全做——评测核心（规则/黄金 + LLM-judge）+ 轮次脚本 simulator。
- **共用口径**：共享代码路径。同一 `RuleEngine` 用于运行时 verify 与离线 `evaluateRun`。
- **Simulator 形态**：轮次脚本模拟器（多轮 user 输入序列 + 每轮期望规则），符合当前 single-loop 轮次制底座。双工流式 chunk/barge-in 的运行时底座未交付，本 Phase 不做。
- **轮次模型**：每轮独立 `runSpec`（新 Session，无跨轮记忆）。跨轮状态依赖 Phase 5 记忆 + 单会话多轮，本 Phase 不做。
- **架构**：方案 A——单新包 `@veridical/eval`（规则核心 + 离线评测 + judge + simulator），spec 零改动（仅加一个 `verify` 钩子），依赖方向 eval → spec 单向。

## 2. Rule 模型与 RuleEngine

规则是对一次运行的事件序列的判定。

```ts
type Verdict = { passed: boolean; detail?: string };
type Rule = { name: string; check(events: TraceEvent[]): Verdict };
```

### 内置规则工厂（全部事件序列判定）

| 工厂 | 判定 |
|---|---|
| `ruleOutcomeEquals(value)` | `turn/end` 的 `outcome` 深比较 |
| `ruleTextContains(substring, role)` | 任一 `assistant.message`/`user.message` payload 文本含子串 |
| `ruleToolCalled(name)` | 任一 `tool.called` 的 name 匹配 |
| `ruleToolNotDenied(name)` | 该工具无 `denied`（tool.result payload 里 `reason==='denied'`） |
| `ruleNoErrors()` | 无 `llm.response`/`tool.result`/`spec/run/end` 的 `verb==='error'` |

### RuleEngine

```ts
class RuleEngine {
  constructor(rules: Rule[]);
  evaluate(events: TraceEvent[]): RuleReport;   // { rules: [{name, passed, detail}], passed: boolean }
}
```

规则判定是纯函数，不抛；对任何事件序列都返回 verdict。

### 共享代码路径

运行时 `verify`（行动后校验单步 `tool.result`，只有当前步事件可见）与离线 `evaluateRun`（运行后校验全量事件）共用 `RuleEngine`；区别只在传入的 `events` 是"当前步快照"还是"全量 trace"——同一套规则函数不变。

## 3. 离线评测 `evaluateRun` + LLMJudge

### evaluateRun

```ts
interface EvalConfig {
  rules?: Rule[];                  // 规则判定（确定性）
  golden?: unknown;                // 可选黄金答案 = ruleOutcomeEquals(golden) 糖
  judge?: LLMJudgeConfig;          // 可选 LLM 评审
  pass_requirement?: 'all' | 'any';// 规则聚合语义，默认 'all'
}

interface EvalReport {
  rules?: RuleReport;              // 规则判定结果
  judge?: { passed: boolean; reasoning: string; tokens: LLMUsage };
  passed: boolean;                 // 总判定
}
```

- 输入 `RunResult`（`@veridical/spec`），直接消费 `RunResult.events`。
- `golden` 是 `ruleOutcomeEquals` 的糖。
- `judge` 用 LLM：事件序列压成可读 transcript（user/assistant/tool 结构化摘要）→ 按 rubric 提示词 → 解析 `{ passed, reasoning }`。

### LLMJudge

```ts
class LLMJudge {
  constructor(llm: LLMGateway, provider: string, model: string, store: TraceStore);
  judge(run: RunResult, rubric: string): Promise<{ passed: boolean; reasoning: string; tokens: LLMUsage }>;
}
```

- rubric 是调用方提供的判定标准（自然语言）。
- 输出解析：要求 LLM 返回 JSON `{ passed: boolean, reasoning: string }`；解析失败 → 抛 `JudgeParseError`（显式失败，不静默 pass）。
- `store`：judge 构造自己的 `Session`/`Recorder` 覆盖该 store，其 LLM 调用落事件（"model-visible means logged" 不变式——judge 的 meta-LLM 调用也可审计）。

## 4. 运行时 verify 集成（verifyFromRules）

spec 包只加一个钩子，不依赖 eval：

```ts
// @veridical/spec 的 SpecRunnerDeps 增加
verify?: (events: TraceEvent[]) => boolean;   // 用当前全部事件判定下一步是否放行

// @veridical/eval 提供
function verifyFromRules(rules: Rule[]): (events: TraceEvent[]) => boolean {
  return (events) => new RuleEngine(rules).evaluate(events).passed;
}
```

`runSpec` 内部：
- 若提供 `verify`，`ctx.verifyToolResult` 不再 `() => true`：拿到 broker 调用后 recorder 刚写的 `tool.result` 事件（`readBySession` 取最新），连同当前全部事件喂 `verify`。
- 判 false → `tool.result` verb:error `blocked:true`（沿用 single-loop 既有失败路径，agent 可重试）。
- verify 抛异常 → 按"失败"处理（blocked + retry），不吞。

依赖方向：`@veridical/eval` → `@veridical/spec` 单向；spec 不 import eval（`verify` 类型是 `(events) => boolean`，由调用方构造传入）。

## 5. Scenario Simulator

### Scenario 数据模型

Rule 是 `(events) => Verdict` 函数，不可直接写进 YAML。Scenario 用**可序列化规则声明**表达规则，`parseScenarioYaml` 把它们映射成 Rule 函数：

```ts
// 规则声明（YAML 可序列化）→ Rule 函数 的映射
type RuleDecl =
  | { outcome_equals: unknown }
  | { text_contains: string; role?: 'assistant' | 'user' }
  | { tool_called: string }
  | { tool_not_denied: string }
  | { no_errors: true };
```

```yaml
# scenario YAML
name: claim-filing-multi-turn
description: 多轮报案，逐轮校验槽位收集
spec: { name: claim-filing, version: 1.0.0 }   # 引用注册表里的 spec
rules: [{ no_errors: true }]                    # 全局规则（每轮也跑）
steps:
  - user: "我要报案，保单号 P12345"
    expect_rules: [{ tool_called: lookup_policy }]
  - user: "出险时间是昨天下午 3 点"
    expect_rules: [{ text_contains: "收到" }]
  - user: "地点在建设路 88 号"
    expect_rules: [{ outcome_equals: "收集完成" }]
```

`expect_rules` 声明经 `ruleFromDecl(decl)` 映射为 Rule 函数（内置规则工厂的薄封装）。

```ts
// 序列化层
function ruleFromDecl(decl: RuleDecl): Rule;   // 声明 → Rule 函数
function ruleDeclsToRules(decls: RuleDecl[]): Rule[];

interface ScenarioStep {
  user: string;
  expect_rules?: Rule[];    // 该轮期望（已映射为 Rule），缺省用 scenario 全局 rules
}
interface Scenario {
  name: string;
  description?: string;
  spec: { name: string; version?: string };
  rules?: Rule[];           // 全局规则（每轮也跑，已映射）
  steps: ScenarioStep[];
}
function parseScenarioYaml(yaml: string): Scenario;   // YAML → RuleDecl 解析 → Rule 映射
```

### Simulator

```ts
class Simulator {
  constructor(deps: SpecRunnerDeps);            // 复用 runSpec 的 deps
  run(scenario: Scenario, registry: SpecRegistry): Promise<ScenarioReport>;
}

interface ScenarioReport {
  name: string;
  steps: { index: number; user: string; run: RunResult; report: EvalReport }[];
  passed: boolean;                              // 所有轮 passed
}
```

- 每轮：`registry.resolve(scenario.spec.name, scenario.spec.version)` → `runSpec(deps, spec, step.user)` → `evaluateRun(result, { rules: step.expect_rules + scenario.rules })`。
- **每轮独立运行**（新 Session，无跨轮记忆）。
- 模拟器事件化：每轮记录 `eval/run/start` + `eval/step/end`（用传入 recorder/store），评测本身可审计。

## 6. 错误处理

- 规则判定纯函数，不抛。
- `LLMJudge` 解析失败 → 抛 `JudgeParseError`。
- `Simulator.run`：registry 解析不到 spec → 抛 `ScenarioError`；某轮 `runSpec` 抛 `SpecRunError` → **整体抛**（受控压测下静默继续会掩盖 setup 问题；容错后续加 `continue_on_error`）。
- 运行时 verify 抛异常 → 按失败处理（blocked + retry）。

## 7. 测试策略

TDD，镜像 Phase 1/2 模式（每任务失败测试 → 实现 → 通过 → 提交）。

- **rules**：每个内置规则正反用例 + RuleEngine 聚合（all/any、空规则集）。
- **evaluateRun**：规则通过/失败、golden 糖、judge 调用（mock LLM 返回 JSON）、judge 解析失败抛错。
- **verify + runSpec**：注入 verify 规则 → 不满足时 `tool.result` verb:error `blocked:true` 且重试；满足则正常。
- **simulator**：两轮 scenario（mock LLM + echo tool）→ 每轮 RunResult + EvalReport、总 passed；registry 未命中抛 ScenarioError。

## 8. 包结构

新包 `@veridical/eval`（依赖 spec/runtime/store/schema/llm）：

```
packages/eval/
├── src/
│   ├── rules.ts         # Rule/Verdict 类型 + 内置规则工厂
│   ├── engine.ts        # RuleEngine
│   ├── verify.ts        # verifyFromRules
│   ├── evaluate.ts      # evaluateRun + EvalConfig/EvalReport
│   ├── judge.ts         # LLMJudge + JudgeParseError
│   ├── scenario.ts      # Scenario/ScenarioStep + parseScenarioYaml + ScenarioError
│   ├── simulator.ts     # Simulator + ScenarioReport
│   └── index.ts
└── test/
    ├── rules.test.ts
    ├── evaluate.test.ts
    ├── verify.test.ts
    ├── judge.test.ts
    └── simulator.test.ts
```

`@veridical/spec` 改动：`SpecRunnerDeps` 加 `verify?: (events: TraceEvent[]) => boolean`（一个字段，无其他改动，spec 不依赖 eval）。

## 9. Demo 更新

`packages/demo` 增加评测驱动跑法：跑一个 spec → `evaluateRun` 规则判定 + simulator 两轮 scenario，验证评测 trace 与报告。Phase 1/2 demo 保留。

## 10. 依赖链与后续

- Phase 3 依赖 Phase 1（runtime）+ Phase 2（spec）。
- Phase 4 回放引擎按 spec 版本 + 评测报告重放；Phase 7 发布/会读把评测报告与版本绑定。
- 跨轮状态（单会话多轮）依赖 Phase 5 记忆；双工流式 simulator 依赖双工运行时。
