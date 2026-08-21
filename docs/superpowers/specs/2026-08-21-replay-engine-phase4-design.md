# Veridical — 回放引擎 + 时间旅行调试 + 运行比较（Phase 4）设计文档

- 日期：2026-08-21
- 状态：设计评审通过（Phase 4 范围）
- 前置：Phase 1 核心运行时 + Phase 2 Agent Spec 系统 + Phase 3 评测引擎已合并至 main

## 1. 背景与目标

Phase 1-3 让 agent 可跑（runtime）、可声明（spec）、可判定（eval）。Phase 4 让运行**可回放、可调试、可比较**：

- **ReplayEngine**：按可配置回放计划重执行一次 agent loop，LLM/tool 从已录事件喂回记录响应（不复调真实接口），重跑后可选断言 trace 逐事件一致——验证运行时回归（同一场景行为不变）。
- **TraceProjection**：时间旅行调试的只读状态投影 API——任意 seq 点的模型上下文/事件子集 + 游标步进。
- **RunComparator**：两 session 的事件级 diff + 摘要。

设计文档 §6 的"接口可回测三层"是回放策略的依据：`replay`（确定性回放）、`fixture`（动态回测）、非确定性接口由调用方标记并选择策略。`call_id` 铁律对应指纹键控回放。

### 决策依据（Phase 4 范围确认）

- **回放核心**：重执行验证（可配置 ReplayPlan），非纯读呈现。**回放什么由使用者决定**——每个 LLM provider / 工具声明策略。
- **回放粒度**：可配置回放计划（ReplayPlan），逐 provider/tool 声明 `replay`/`live`/`fixture`。
- **调试器**：库级状态投影 API（无 UI/CLI）。
- **比较**：事件级 diff（seq 对齐逐事件对比 + 摘要），不做语义对齐（Phase 3 评测负责语义）。
- **架构**：方案 A——单新包 `@veridical/replay`（ReplayEngine + TraceProjection + RunComparator）。

## 2. ReplayEngine（重执行回放）

### ReplayPlan

```ts
type ReplayStrategy = 'replay' | 'live' | 'fixture';

interface ReplayPlan {
  spec: { name: string; version?: string };      // 要重跑的 spec（从注册表 resolve）
  llm?: { [provider: string]: ReplayStrategy };  // 缺省 provider → 'replay'
  tools?: { [name: string]: ReplayStrategy };    // 缺省 tool → 'replay'
  fixtures?: {
    llm?: { provider: string; responses: { fingerprint: string; text: string; usage: LLMUsage }[] }[];
    tools?: { name: string; responses: unknown[] }[];   // 按调用顺序喂回
  };
  assert_trace_identical?: boolean;               // 重跑后断言与记录 trace 一致，默认 true
}
```

### Replay providers/tools（`replay` 策略）

- `ReplayLLMProvider`：载入 session 已录事件；`complete(req)` 按 `fingerprint(req)` 查已录 `llm.response` 的 `text`/`usage`；命中返回，未命中抛 `ReplayMissError`。与 Phase 2 `MockProvider` 同构，但数据源是事件日志。
- `ReplayToolProvider`：按**调用序列**从已录 `tool.result` 事件喂回 `result`——已录 `tool.called`/`tool.result` 的对应对按顺序排列，replay 策略下第 N 次同工具调用喂回第 N 条已录 result；序列耗尽抛 `ReplayMissError`。

### 重执行

用 ReplayPlan 构造 providers/tools → `runSpec(deps, spec, prompt)`（复用 Phase 2 装配）→ 重跑的 `RunResult`。`prompt` 从记录 trace 的 `spec/run/start` 事件 payload 的 `input` 字段提取（回放是复现原运行，输入同源）。`assert_trace_identical` 时逐事件对比（seq 对齐的 type/verb/payload/tokens/cost），不一致 → 抛 `TraceDivergenceError`（带首个分岔 seq + 差异条目）。

## 3. TraceProjection（状态投影 API）

```ts
interface ProjectionSnapshot {
  session_id: string;
  up_to_seq: number;
  messages: ModelMessage[];       // 到该 seq 为止的模型上下文
  events: TraceEvent[];           // 到该 seq 为止的事件子集（按 seq）
  last_event?: TraceEvent;
}

class TraceProjection {
  constructor(store: TraceStore);
  projectAt(session_id: string, seq: number): Promise<ProjectionSnapshot>;
  cursor(session_id: string): AsyncIterable<ProjectionSnapshot>;  // 逐 seq 步进
  count(session_id: string): Promise<number>;
}
```

- `projectAt` 取 `readBySession` 截断到 `<= seq`（seq 是逻辑时钟，重放精确）。
- `messages` 复用 `deriveMessages`——**`@veridical/runtime` 的 `deriveMessages` 加可选 `upToSeq?: number`**（向后兼容，不传则全量）。TraceProjection 传 `upToSeq`。
- `cursor` async generator，每次 yield 下一个 seq 快照（O(n) 遍历，不缓存）。
- **seq 越界**：`projectAt` 传 > count → 截到最后；传 0/负 → 空快照。不抛。

## 4. RunComparator（事件级 diff）

```ts
interface DiffEntry {
  seq: number;
  field: 'type' | 'verb' | 'payload' | 'tokens' | 'cost';
  left?: unknown;
  right?: unknown;
  kind: 'changed' | 'left_only' | 'right_only';
}

interface RunDiff {
  session_a: string;
  session_b: string;
  differences: DiffEntry[];
  summary: {
    events_a: number;
    events_b: number;
    first_divergence?: number;
    outcomes_equal: boolean;       // turn/end outcome 深比较
    identical: boolean;
  };
}

class RunComparator {
  constructor(store: TraceStore);
  compare(a: string, b: string): Promise<RunDiff>;
}
```

**对齐规则**：按 seq 对齐（每 session 独立逻辑时钟）。逐 seq：双方都有 → 逐字段（type/verb/payload/tokens/cost）比较，不同记 `changed`；只有一方 → `left_only`/`right_only`。`payload` 用 `JSON.stringify` 深比较。`first_divergence` = 首个差异 seq。

**取舍**：seq 对齐最直观（同一 spec 重跑 seq 序列应一致）；事件数不同仍逐位比对，多余标 only。不做语义对齐（Phase 3 评测负责）。

## 5. 错误处理

- `ReplayLLMProvider`/`ReplayToolProvider` 未命中 → 抛 `ReplayMissError`（显式失败）。
- `assert_trace_identical` 不一致 → 抛 `TraceDivergenceError`（首个分岔 seq + 差异）。
- ReplayPlan 引用的 spec 注册表未命中 → 抛 `ReplayError`。
- TraceProjection / RunComparator 纯只读，不抛（越界截断、空 session 返回空/identical）。

## 6. 测试策略

TDD，镜像 Phase 1-3 模式。

- **engine**：① replay 策略重跑产出 trace 与记录 trace 逐事件一致（identical）；② 改一个 mock 响应 → `TraceDivergenceError`；③ `fixture` 策略喂自定义响应 → 重放成功；④ replay miss → `ReplayMissError`；⑤ spec 未命中 → `ReplayError`。
- **projection**：`projectAt` 截止 seq 正确、越界截断、`cursor` 步进递增、`count`。
- **comparator**：两相同 session → identical；改 payload → changed + first_divergence；不同事件数 → only；outcome 一致/不一致。

## 7. 包结构

新包 `@veridical/replay`（依赖 spec/runtime/store/schema）：

```
packages/replay/
├── src/
│   ├── plan.ts          # ReplayPlan/ReplayStrategy 类型
│   ├── providers.ts     # ReplayLLMProvider + ReplayToolProvider + ReplayMissError
│   ├── engine.ts        # ReplayEngine + TraceDivergenceError + ReplayError
│   ├── projection.ts    # TraceProjection + ProjectionSnapshot
│   ├── comparator.ts    # RunComparator + RunDiff/DiffEntry
│   └── index.ts
└── test/
    ├── engine.test.ts
    ├── projection.test.ts
    └── comparator.test.ts
```

`@veridical/runtime` 改动：`deriveMessages(store, session_id, upToSeq?)`（可选参数，向后兼容）。

## 8. Demo 更新

`packages/demo` 增加回放驱动跑法：跑一个 spec（mock LLM + echo tool）→ 存 JSONL → 用 ReplayEngine 按记录 trace 回放重跑 → 断言 identical → TraceProjection 投影几个 seq 点 → RunComparator 对比原跑与回放。

## 9. 依赖链与后续

- Phase 4 依赖 Phase 1（runtime/store）、Phase 2（spec/runSpec）。
- Phase 7 发布/会读把"回放验证通过"作为发布关口之一；Phase 8 编译器消费 ReplayPlan 形状。
- 双工流式回放（交错流 chunk 级）依赖双工运行时（未交付）。
