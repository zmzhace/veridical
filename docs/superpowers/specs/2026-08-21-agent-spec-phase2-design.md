# Veridical — Agent Spec 系统（Phase 2）设计文档

- 日期：2026-08-21
- 状态：设计评审通过（Phase 2 范围）
- 前置：Phase 1 核心运行时（`@veridical/schema|store|runtime|tools|llm`）已合并至 main

## 1. 背景与目标

Phase 1 建立了 trace 中心的核心运行时：统一事件 schema、`TraceStore` 抽象、Session/Recorder（seq 时钟）、`deriveMessages` 投影、single-loop 流引擎、`ToolBroker` 五段管线、`LLMGateway` live/mock 双模式。

Phase 2 在它之上加一层：**Agent Spec 系统**——把 agent 的声明（指令、flow、LLM 路由、工具白名单）变成**可校验、可版本化、可运行**的第一公民。

- 声明式 YAML，一份 spec 定义 agent 是什么。
- 严格校验（zod），坏 spec 在运行前 fail fast。
- 版本化（semver + 注册表），同 name 多版本共存，为 Phase 7 发布/审计铺路。
- **可运行**：`SpecRunner` 读 spec 装配 Phase 1 组件并驱动 single-loop，spec 驱动真实 trace。

### 决策依据（Phase 2 范围确认）

- **范围**：声明层 + 执行器。spec 真正能跑，不是只被解析。
- **字段**：元数据 + 版本、指令 + flow、LLM 路由、工具白名单 + 审批策略。
- **版本化**：semver + 注册表（`InMemorySpecRegistry` + `JsonlSpecRegistry`，镜像 `TraceStore` 双实现模式）。
- **架构**：方案 A——`@veridical/spec` 包 = 声明层（schema + registry）+ `SpecRunner` 门面。

## 2. AgentSpec 声明层

### 2.1 YAML 形状

```yaml
name: claim-filing
description: 报案场景：收集槽位并出报告
version: 1.0.0
schema_version: 1

instruction:
  system: |
    You are a claim filing assistant. Collect slots: policy_no, date, location.

flow:
  mode: single-loop        # Phase 2 仅支持 single-loop；enum 预留后续模式
  max_steps: 8

llm:
  provider: mock           # 路由到 LLMGateway 的 provider key
  model: m
  fallback: []             # [{ provider, model }] 降级链

tools:
  - name: get_map
    access: allow          # allow | deny | ask
  - name: send_notice
    access: ask
    deterministic: false   # 非确定性接口标记，透传给 ToolDef
```

### 2.2 zod 校验（`parseSpecYaml`）

`parseSpecYaml(yaml: string): AgentSpec` — YAML → zod 校验，非法即抛，带字段级错误。

强制校验：
- `name` 非空
- `version` 是合法 semver
- `flow.mode` 在支持集合内（Phase 2: `single-loop`；enum 预留）
- `tools[].name` 唯一
- `llm.provider` 非空

### 2.3 与 Phase 1 类型对齐

| spec 字段 | Phase 1 类型 |
|---|---|
| `flow.max_steps` | `FlowContext.maxSteps` |
| `tools[].deterministic` | `ToolDef.deterministic` |
| `tools[].access` | `ApprovalDecision`（allow/deny/ask） |

## 3. SpecRegistry

```ts
interface SpecRegistry {
  register(spec: AgentSpec): Promise<void>;
  resolve(name: string, version?: string): Promise<AgentSpec | undefined>;
  list(): Promise<AgentSpec[]>;
}
```

- `InMemorySpecRegistry` — 测试/快速迭代。
- `JsonlSpecRegistry` — 本地持久化，`<dir>/<name>@<version>.jsonl`，每注册一条 JSON 行，load 时校验。

### 版本解析语义（`resolve`）

- 显式 `version` → 精确匹配（`1.0.0` ≠ `1.0.1`）。
- 省略 `version` → `latest`：同 `name` 下最高 semver。
- 同 `name` 多版本共存，互不覆盖（Phase 7 版本对比的前提）。
- `register` 重复 `(name, version)` → **拒绝重复注册（immutable）**。spec 是治理对象，静默覆盖会使"这个版本当时是什么样"失真，破坏确定性回放与审计。日常迭代 bump semver；真需强制覆盖时留待 Phase 7 显式 `replace` seam（当前不加，YAGNI）。

## 4. SpecRunner

薄装配门面，不重造运行时逻辑。

```ts
interface SpecRunnerDeps {
  store: TraceStore;
  providers: Map<string, LLMProvider>;      // 注入到 LLMGateway
  tools: ToolDef[];                          // 可用工具库（≥ spec 白名单）
  policy?: ApprovalPolicy;                   // 缺省从 spec.tools 生成
  session_id?: string;                       // 缺省自动生成
  tenant_id: string;
}

interface RunResult {
  session_id: string;
  spec_name: string;
  spec_version: string;
  outcome: unknown;                          // flow 最终 outcome
  events: TraceEvent[];                      // 本次运行全部事件
}
```

### 装配流程

1. `session = new Session({ session_id, tenant_id, spec_version })`
2. `recorder = new Recorder(store, session)`
3. `llm = new LLMGateway(providers)`（用 `spec.llm.provider`/`model` 构造请求）
4. `broker = new ToolBroker(库内工具, policy)`（白名单过滤 + 按 `access` 生成策略）
5. `ctx: FlowContext` 绑定 recorder/llm/broker，`maxSteps = spec.flow.max_steps`
6. `await runSingleLoop(ctx, prompt)`

### Spec-bound 事件

`spec/run/start`、`spec/run/end` 包在 flow 前后，记录 spec 身份 + 入参/结果。`Session.spec_version` 已落每个事件，trace 里"哪个 spec 版本跑了什么"可见。

### 审批策略绑定

spec 声明**白名单 + access**，不声明审批逻辑（`ApprovalPolicy` 是运行时注入实现，Phase 3 评测可换 mock）。默认 `SpecApprovalPolicy`：白名单外 → deny，`access: deny` → deny，`access: ask` → 调注入的 `onAsk`。

## 5. 工具绑定与 LLM 降级

### 工具绑定

`tools: ToolDef[]` 是运行时注入的可用库（≥ spec 白名单）。SpecRunner 按 `spec.tools[].name` **静默过滤**——库里有啥用啥，白名单外运行期由 `SpecApprovalPolicy` 返回 `deny`（进 trace 为显式 `denied` 事件，不静默）。spec 只管声明，工具是否存在由注入方负责。

### LLM fallback（最小实现）

SpecRunner 内 `tryProviders` 循环：主 provider 抛错 → 沿 `spec.llm.fallback` 依次试，每次尝试记 `llm.request`/`llm.response`（verb:error 标失败）。主 provider 全失败 → 记 verb:error、抛 `SpecRunError`。不碰 Phase 1 `LLMGateway`（保持单 provider 纯净）。

## 6. 错误处理与运行生命周期

### 装配期错误（抛异常，运行不开始）

- spec 解析/校验失败 → `parseSpecYaml` 抛（zod 字段级错误）。
- 重复注册 `(name, version)` → `register` 抛。
- `resolve` 未命中 → 返回 `undefined`（不抛）。
- 注入 `providers` 缺主 provider → 抛 `SpecRunError`（运行前 fail fast，避免孤儿事件）。fallback 链上不存在的 provider 跳过，不报错（降级语义）。

### 运行期错误（事件化，不吞）

- LLM 主 provider 抛错 → 沿 fallback 试；全失败 → 记 `llm.response` verb:error、抛 `SpecRunError`（Phase 1 已建立模式）。
- 工具执行抛错 → `ToolBroker` 已返回 `{ ok: false, reason: 'error' }`。
- verify 失败 → `tool.result` verb:error `blocked:true`。
- flow 达 `max_steps` → 正常结束，`turn/end` 带 outcome（非错误）。

### 运行生命周期事件

```
spec/run/start      { spec_name, spec_version, session_id, input }
spec/run/end        { outcome, steps }
```

装配失败在 `spec/run/start` 之前 → 只抛错误、无部分 trace（fail fast）。

## 7. 测试策略

TDD，镜像 Phase 1 每任务测。

- **schema**：`parseSpecYaml` 合法 YAML → 正确类型；非法（坏 semver、重复 tool name、未知 flow mode、缺 name）→ 抛。
- **registry**：register/resolve（精确版本、latest、未命中 undefined）、多版本共存、重复注册拒绝。
- **runner**：最小 single-loop spec（mock LLM + echo tool）→ 断言事件序列含 `spec/run/start`、`turn/start`、`llm.request`、`llm.response`、`tool.result`、`turn/end`、`spec/run/end`；白名单外 → denied 事件；fallback：主 provider 抛错 → fallback 成功；全失败 → 抛 `SpecRunError`；max_steps 到达 → 正常结束。

## 8. 包结构

新包 `@veridical/spec`（依赖 runtime/tools/llm/store/schema）：

```
packages/spec/
├── src/
│   ├── spec.ts          # AgentSpec zod schema + parseSpecYaml
│   ├── registry.ts      # SpecRegistry 接口
│   ├── in-memory.ts     # InMemorySpecRegistry
│   ├── jsonl.ts         # JsonlSpecRegistry
│   ├── runner.ts        # SpecRunner + SpecRunError + SpecApprovalPolicy
│   └── index.ts
└── test/
    ├── spec.test.ts
    ├── registry.test.ts
    └── runner.test.ts
```

## 9. Demo 更新

`packages/demo` 增加 spec 驱动的跑法——YAML 声明报案 agent（mock LLM + echo tool），经 `SpecRunner` 跑通，验证 trace 含 spec-bound 事件。Phase 1 的 `demo.ts` 硬编码装配保留，spec 跑法作为新增入口。

## 10. 依赖链与后续

- Phase 2 依赖 Phase 1（已并 main）。
- Phase 3 评测引擎消费 `RunResult`/事件；Phase 4 回放按 spec 版本重放；Phase 7 发布/审计按 `spec/run/start` + `Session.spec_version` 追溯。
