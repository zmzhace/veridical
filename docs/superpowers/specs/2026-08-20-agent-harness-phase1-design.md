# 企业级 Agent Harness — Phase 1 设计文档

- 日期：2026-08-20
- 状态：设计评审通过（Phase 1 范围）

## 1. 背景与目标

构建一套企业级 agent harness。除了让 agent 能跑起来，重点是让 agent **可评测、可评估、可回放、可比较**，并能把需求变成**可执行的 agent spec**，同时推动**工具协议、记忆方案、评测口径、发布与会读机制**。

本阶段（Phase 1）只做**核心运行时 + trace 模型 + 工具协议 + LLM 网关 + 存储层**，是后续一切（spec 系统、评测引擎、回放引擎、记忆、多租户平台、发布/回读）的地基。

### 决策依据（已调研）

深度调研了三个开源 harness：DeepSeek Harness（dsh，MIT，全 TS）、anomalyco/opencode（MIT，全 TS）、OpenAI Codex（Apache-2.0，Rust 内核）。结论：

- **不选任何一家做底座**，而是**自研一个轻量核心运行时**，把三家最精华的模式逐条落入：
  - **dsh**：session-log 唯一真相源、"model-visible means logged" 不变式、`deriveMessages()` 派生上下文、五段工具执行管线、事件三域
  - **opencode**：契约优先 HTTP API + 双 SDK codegen、durable event log + SSE 回放流、上下文源（Context Source）代数、权限规则集
  - **codex**：JSONL 权威 + SQLite 索引双存储、`ThreadStore` 存储抽象、三层执行安全、配置分层优先级 + 企业强制层、语义记忆两阶段管线
- **三家共同空白 = 本项目的差异化价值**：评测引擎/评测口径、发布评审 + 数据回读、多租户平台、统一成本/token 分析（三家全无）；语义记忆只有 codex 成熟。

### 关键选型

- 语言：全 TypeScript（monorepo）
- 架构路线：**Trace 中心的分层单体**（路线 A），模块边界=未来服务边界
- 工具协议底座：**MCP**（模型上下文协议，行业标准），之上叠加企业层（鉴权/限流/审计/录制）
- 记忆：三种都要（工作 / 长期语义 / 程序性 skills）——但 Phase 1 只搭载体，语义记忆在 Phase 5
- 评测判定：规则/黄金答案 + LLM 评审 + 用户反馈沉淀（Phase 3）
- 回放：时间旅行调试器（Phase 4）
- 部署：多租户平台（Phase 6）

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────┐
│                    平台层 (Phase 6)                        │
│   多租户 API · 认证 · 审计 · 命名空间隔离                   │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│           企业能力层 (Phase 3/4/5/7)                       │
│   评测引擎 · 时间旅行回放 · 比较 · 记忆 · 发布/会读         │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│             运行时核心 (Phase 1，本节)                     │
│   组合式控制流引擎 · 上下文工程 · verify 闭环              │
│   工具协议(MCP+企业层) · LLM 网关 · trace 模型             │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│            存储层 (Phase 1，第三节)                        │
│   事件日志(权威) + 索引(SQLite/Postgres) + 对象存储冷归档  │
└──────────────────────────────────────────────────────────┘
```

## 3. Trace 模型（第一节）

### 3.1 原则

- **事件溯源**：会话是 span 树，事件是原子记录；append-only、不可变。
- **无日志的交互不存在**：任何跨边界交互必须产生事件。
- **确定性**：运行时内部步骤完全确定，唯一不确定来源（LLM、工具）被完整记录 → 同一 trace 可确定性重放。
- **seq 逻辑时钟**：排序用单调 seq，不用墙钟，保证回放与线上步骤顺序一致。

### 3.2 会话 = span 树

```
Session (agent spec vX, tenant, 运行配置)
└─ span: agent-loop
   ├─ event: llm_requested     {request_id, provider, model, fingerprint}
   ├─ event: llm_responded     {request_id, output, tokens, cost, latency_ms}
   ├─ event: tool_called       {tool_id, args, fingerprint}
   ├─ event: tool_result       {tool_id, result|error, duration_ms}
   ├─ span: nested_agent       {sub-spec, 嵌套调用树}
   ├─ event: memory_read/written
   ├─ event: state/context_snapshot   ← 每轮结构化状态快照
   └─ event: session_ended     {final_state, result, outcome}
```

### 3.3 统一事件模板（所有子系统同一 schema，禁止自造格式）

```
{ id, tenant_id, session_id, span_id, parent_span_id,
  seq,                    // 单调递增，逻辑时钟
  type,                   // llm.request / tool.result / api.ingress / state.snapshot ...
  verb,                   // request | response | error | stream_chunk
  attempt,                // 第几次重试（重试也是事件）
  duration_ms,            // 所有事件必带，全链路可加总
  tokens: {input, output, cached, total},   // 凡可计 token 必带
  cost,                   // 凡可计价
  payload,                // 结构化入参/出参（Phase 1 全量原样，不脱敏）
  call_id,                // 外部接口调用标识（可回测的关键）
  spec_version }
```

### 3.4 接口四层（全部落事件）

```
① 平台 API 入口      HTTP 请求/响应、认证、租户解析、限流命中
② 运行时核心        spec 解析、路由决策、策略判定（重试/降级/权限）
③ 对外交互          LLM 网关（流式/重试/降级/路由命中）
                    工具调用（鉴权结果、权限拒绝、限流）
                    ASR 转录 / TTS / 外部接口（地图、保单抄录等）
                    记忆系统（读/写/召回）
                    嵌套 agent（子 span）
④ 调度/队列         等待、重试次数、背压、超时
```

### 3.5 清晰性规则

1. **verb 分离请求/响应/错误**：request 无配对 response 即未完成，可视化红标。
2. **命名统一**：`layer.verb` 命名空间（`llm.stream_chunk`、`tool.authorize_denied`）。
3. **时间与 token 全链路可加总**：任意窗口（session/span/工具/模型）可 SQL 聚合耗时与消耗。

### 3.6 双工流式会话（场景补丁，一等公民）

报案/通话场景是**实时双向并发**，不是串行 turn。补进模型：

- **流式 chunk 级事件**：音频 chunk、partial transcript、TTS chunk 都落事件（借鉴 dsh `assistant/chunk`）。
- **交错流可回放**：`seq` 全序 + `parent_span` 因果链同时保留，回放忠实重现交错的流，不重放成串行对话。
- **barge-in（插话打断）**：打断 agent 说话是显式事件类型；打断后 agent 必须停口。
- 双工会话是运行时的一等公民，不是特例。

### 3.7 状态快照（场景补丁）

要评测"槽位是否收集完整"，需能在 trace 读到每轮**结构化对话状态**（已填/待确认/缺失槽位）。每轮写 `state/context_snapshot` 事件（借鉴 dsh `request/context`、opencode `context_epoch`），评测和回放都读它。

## 4. 运行时执行模型（第二节）

### 4.1 组合式控制流引擎（非单一 ReAct 循环）

抛弃单一循环。运行时是"控制流模式引擎"，spec 声明用哪种模式及组合：

```
可组合模式（每个都是可插拔策略，trace 模型统一）：
  single-loop     单 agent 工具循环（gather→act→verify）
  router          路由分发到专用子流程
  orchestrator    编排者拆任务→子 agent 并行→汇总
  evaluator-loop  生成→评审→迭代优化
  chain           固定步骤链 + 程序化门禁
  voting          多路生成聚合（置信度/一致性）
```

spec 里 `flow` 字段声明模式及组合。span 树天然承载任意控制流。

### 4.2 上下文工程（范式核心）

- **工作区（workspace）**：agent 拥有文件系统/工作区，用 agentic 搜索（grep/bash）自主捞上下文。
- **子 agent**：并行化 + 上下文隔离（子 agent 只回传摘要）。
- **compaction**：长跑自动摘要历史，防上下文爆炸；压缩动作本身也是 trace 事件（dsh `surfaceOp` 思路：replace + sourceEventSeqs 保持可回放）。

### 4.3 内建验证闭环（verify loop）

- 每次行动后强制验证：规则校验（schema/lint/断言）→ 工具反馈 → 可选 LLM 评审。
- 验证结果进入下一轮上下文（agent 能自我修正）。
- 与 Phase 3 评测引擎共用同一套"判定口径"——运行时 verify 和离线评测是同一根尺子。

### 4.4 工具协议

- **MCP 底座**：原生支持 MCP server 接入，企业工具生态直接可用。
- **五段执行管线**（借鉴 dsh）：

```
tools/pre-execute   → 审批（allow/deny/ask）
tools/guard         → 单调守卫（只能拒绝）
tools/execute       → 执行（超时/重试/度量）
tools/post-execute  → 校验（accept/替换/block+反馈）
tools/result        → 冻结权威结果
```

- 工具定义 schema 与 MCP 对齐（`input_schema` 同款 JSON Schema），企业层叠加 `access: {scopes, roles}`、`rate_limit`、`cost_budget`、`deterministic: bool`。
- 每次调用经 Tool Broker：鉴权 → 限流 → 执行 → 记录，五步全有事件；权限拒绝、限流命中是显式事件，不静默。

### 4.5 LLM 网关

- 多供应商 adapter（OpenAI / Anthropic / OpenAI 兼容 vLLM）。
- **路由**：按 spec 路由策略（模型、降级顺序、供应商），路由命中记事件。
- **双模式**：`live`（真实调用，全量记录以便回放）和 `mock`（回放时按 fingerprint 匹配已录响应）。
- 流式 chunk 级记录，保证回放 fidelity。
- 重试/退避/限流统一网关层，全部事件化。

## 5. 存储层（第三节）

### 5.1 双存储 + 对象存储冷归档

```
┌─ 权威事实源（append-only，不可变）──────────────┐
│  事件日志（session event log）                  │
│  · dev/单机：JSONL 文件（每 session 一个）      │
│  · 生产多租户：对象存储（S3 兼容）或 Postgres   │
│  · 全量事件：含原始 assistant/chunk、大 payload │
└────────────────────────────────────────────────┘
         ↓ 事件流（写入时同步/异步投影）
┌─ 可查询索引（SQLite / Postgres）────────────────┐
│  · session 元数据 + 元数据投影                  │
│  · span 树（父子关系）                          │
│  · 事件序列索引（seq → 存储指针）               │
│  · FTS 全文搜索                                 │
│  · 成本/token 聚合（增量更新）                  │
└────────────────────────────────────────────────┘
         ↓ 冷数据
┌─ 对象存储：大 payload（音频、图片、文件）────────┐
│  事件里只存指针 + 摘要                          │
└────────────────────────────────────────────────┘
```

### 5.2 核心决策

1. **`TraceStore` 存储抽象**（借鉴 codex `ThreadStore`）：JSONL 本地实现、Postgres 多租户实现、内存实现（测试）可替换；评测/回放引擎可挂替身实现，不动运行时核心。
2. **单写入者 + seq 全序**（借鉴 opencode）：每 session 事件写入串行化，seq 单调连续；事件重放=按 seq 顺序读。
3. **投影从事件派生**（借鉴 dsh `deriveMessages`）：模型上下文、UI、评测输入都从事件流重派生，不另存；**"模型可见必须可重建"** 是运行时不变式，运行时断言强制。
4. **schema 版本化**：事件类型带 schema_version；旧事件可读；未知必需事件拒绝加载（防静默数据损坏）。
5. **多租户**：生产 Postgres 按 `tenant_id` 分区；dev SQLite 用 `tenant_id` 列；租户数据物理隔离是产品承诺。
6. **保留策略**：按租户配置 TTL（热事件 / 索引可查询期 / 冷归档 / 可清理）。

## 6. 接口可回测（场景补丁，三层）

按验证目标分三层，避免"接口返回能否回测"混为一谈：

1. **确定性回放（复现某次真实返回）**：线上调用把接口返回录进 `tool_result`；回放时 mock 掉接口，喂回录制的 payload。适合复盘线上 bug、验证同一场景行为不变。
2. **动态回测（同逻辑跑不同输入）**：把外部接口替换成 fixture 驱动的 mock（借鉴 opencode `http-recorder` / codex rollout 规约），喂一批测试 fixture（不同保单、异常返回），验证各分支。适合回归、边界、上线前基准集。
3. **非确定性接口（只验行为，不断言结果）**：下单/发通知/实时风控等状态会变，标记 `deterministic: false`；评测时要么 mock、要么只验证"调没调、参数对不对"，不做结果断言。

### 6.1 铁律

> 每个外部接口调用必须记录 `call_id`，且接口返回值可被 `call_id`（或入参 fingerprint）**唯一定位重放**。

## 7. 场景验证（报案场景）

以"报案场景"（槽位收集 + ASR 转录 + 双工 + 外部接口如地图/保单抄录）验证设计覆盖：

| 场景要素 | 设计覆盖 |
|---|---|
| 槽位收集 | 槽位 = 结构化状态，`state/context_snapshot` 每轮快照；评测用规则/黄金答案查槽位完整性 |
| ASR 转录 | 外部接口（接口③层），作为工具事件记录；回放 mock ASR 输出可确定性重现 |
| 双工（实时双向） | 一等公民：chunk 级事件、交错流回放、barge-in 显式事件 |
| 外部接口（地图/保单抄录） | 工具协议五段管线 + 鉴权/审计/录制；按"接口可回测"三层处理 |
| 长会话（20 分钟通话） | compaction + 对象存储冷归档（音频大 payload 存对象存储，事件放指针+摘要） |
| 转人工 | approval seam + 转人工事件 → 发布/会读里的人工介入审计 |
| 端到端评测 | **scenario simulator**（Phase 3 组件）：模拟报案人说话/应答/提供槽位/插话，驱动双工压测；模拟器每个输入也是事件，保证评测可回放 |

## 8. Phase 1 追加项（相对原始设计）

- 双工流式会话模型（chunk 级事件、交错流、barge-in、因果+全序）
- `state/context_snapshot` 每轮状态快照事件
- 接口可回测三层机制 + `call_id` 铁律

Phase 3 追加：scenario simulator（用户模拟器，支持插话/双工行为模拟）。

## 9. 子系统清单（全生命周期路线图）

```
Phase 1  核心运行时 + trace 模型 + 工具协议 + LLM 网关 + 存储   ← 本设计
Phase 2  Agent spec 系统（声明式 YAML + 校验 + 版本化）
Phase 3  评测引擎（规则/黄金答案 + LLM-judge + scenario simulator）
Phase 4  回放引擎 + 时间旅行调试器 + 运行比较
Phase 5  记忆系统（工作/长期语义/程序性）
Phase 6  多租户平台（API/认证/审计/命名空间）
Phase 7  发布 + 评审关口 + 数据回读闭环
Phase 8  自然语言→spec 编译器（后置）
```

依赖链：1 → 2 → 3 → 4 → 5 → 6 → 7，8 最后。

## 10. Phase 1 验收标准

1. 一个最小 agent 能跑完一个任务，全接口事件落盘。
2. 事件日志可完整重派生模型上下文（"模型可见必须可重建"不变式成立）。
3. fork/resume 能复现同一执行路径。
4. token/耗时可聚合统计。
5. 双工流式会话（chunk 级交错 + barge-in）可落事件并可确定性回放。
6. 外部接口调用可被 `call_id` 唯一定位重放。
