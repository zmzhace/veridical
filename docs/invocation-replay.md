# 调用轨迹、回放和训练数据

## 系统边界：提供数据，不执行训练

Veridical 负责运行、完整调用轨迹、回放、评测及奖励标注数据导出；外部训练系统负责候选分组、tokenization、策略优化、权重更新和训练任务调度。
内置 `@veridical/rl` 示例训练器、`/api/rl/train` 和控制台训练页已移除。旧训练 API 返回 404，旧 `/rl` 页面地址回到会话列表。
现有 JSON/JSONL 轨迹与 GRPO 导出接口保留；不伪造缺失的 reward、token IDs 或 logprobs，不将导出成功视为可直接完成任意 RL 算法训练。
历史 trace、Spec 和 Skill 数据不删除；外部训练结果仍需独立评测、审批和发布，不能直接覆盖生产配置。

## 已接通的链路

运行时以 `invocation.start / invocation.end` 配对记录完整输入输出；普通事件仍保留 `seq`，并携带调用身份。记录器使用显式作用域，不使用并发不安全的“当前 Agent”全局变量。

```text
root
  decision#1 / llm#1
  delegate:agent1
    decision#1 / llm#1
    tool:tool1#1
    decision#2 / llm#1
    tool:tool2#1
  delegate:agent2
    decision#1 / llm#1
    tool:tool3#1
    decision#2 / llm#1
    tool:tool2#1
  checkpoint#1
  tool:finish#1
```

LLM 在 decision 内调用，因此真实路径例如 `root/delegate:agent1/decision#1/llm#1`。重复委派使用 `delegate:agent1#2`；重试保留路径、增加 attempt；同一会话后续轮使用 `root/turn#2`。子 Agent 使用自己的模型、Spec、工具白名单和历史，不再强制执行第一个工具。注入的租户策略只能进一步限制权限。

完整性包括请求消息、模型参数、响应、usage、工具原始参数/结果、错误、Memory 查询/命中、checkpoint、委派结果。工具记录副作用状态；超时只能声明状态未知，不能声称撤销外部副作用。生产工具仍限只读。敏感键和已知凭据形式统一脱敏，保留 `redacted/hash/policy`；可通过 `redaction.keys/values` 添加业务规则。生产超大工具结果拒绝时记录未保留标记、字节数和 hash。

## 三种回放

- Strict：默认。固定 Spec/Skill/工具实现与 schema/Loop 实现/模型配置 manifest，按 path、attempt、ordinal、fingerprint 消费。缺失、参数变化、未消费调用、未完成调用都失败。比较每条路径内的完整事件结构，忽略 transport ID 和耗时，不忽略业务输出中的同名 ID。并行完成的物理顺序不要求相同，分支及 join 必须相同。
- Fixture：必须显式选择并填写降级原因；每个 fixture 绑定 path、operation、fingerprint、来源、版本和 hash。不能用全局工具名队列代替，不能回退到 live。结果始终 `identical:false`。替代输出导致后续模型请求变化时，还需为变化后的请求提供准确 fixture，不能沿用不匹配响应。
- Semantic：必须显式配置行为不变量。支持最终结果、必需/禁止工具、完成的子 Agent/阶段、步骤/token/成本/记录的服务耗时预算及精确 Golden 结果。没有不变量不会返回通过。缺失成本数据不能通过成本门禁。允许新策略，但新增外部调用仍需显式 fixture；不自动联网。

Strict 对未注入的自定义 runStep 会回放已记录 decision 及其 LLM 子树，再实际驱动父/子 Loop 和工具边界；它不是重新推理。传入相同的 runStep 时可以重新执行该决策适配器，所有受管理的 LLM/工具调用仍离线。自定义 Loop/回调必须通过上下文记录外部调用；不能把绕过上下文的任意 JavaScript 副作用当作已审计行为。旧 trace 可投影读取，但没有 invocation graph 的旧 trace 不会被标为严格 identical。

## API

研究进程提供：

```text
GET  /api/sessions/:id/invocations
GET  /api/sessions/:id/trajectory?path=root/delegate:agent1&scope=tree
POST /api/sessions/:id/replay
POST /api/sessions/:id/trajectory/export
```

回放请求 `{"mode":"strict"}`。Spec 必须存在于研究 Registry；缺失的子 Agent 不从 trace 自动注册。旧的 `{"targetSeq":10}` 请求继续做状态投影，不冒充执行回放。

导出请求示例：

```json
{
  "format": "grpo",
  "group_id": "question-001",
  "path": "root/delegate:agent1",
  "rewards": {"root/delegate:agent1/decision#1@1": 0.75}
}
```

`format` 还支持 json/jsonl。奖励只按 invocation ID 或 `path@attempt` 显式绑定，不自动给每个子 Agent 广播最终奖励。无奖励时为 null；缺少 release 绑定时为 null，不伪造生产来源。保留完整 state/action/observation/next_state、工具输入输出、原始事件引用与 seq 范围。同一原始运行及相同导出选项得到相同 JSONL。

这是 GRPO **轨迹准备与导出**，不是训练器。训练侧仍须准备同一 prompt 的候选分组、可靠 reward、tokenization，以及算法所需的策略 logprob。不能把一次成功运行当作已完成 GRPO 训练。脱敏、legacy、未完成轨迹默认拒绝 GRPO 导出，需先显式整理数据。

生产进程保留独立 Ledger、审批、鉴权和发布门禁，新增：

```text
POST /v1/replay                 # session + mode: strict；兼容 /v1/replays
GET  /v1/runs/:id/provenance     # id 为运行 session ID；租户隔离、读取审计
```

生产新运行也写 invocation graph，严格回放使用路径 cursor，校验原始环境与带签名的 trace checkpoint。生产 API 不接受 fixture/semantic/live 参数。当前生产执行器仍只开放已批准的 Direct/StageGate 和只读工具，仍拒绝 Supervisor/实验 Loop；不会因为研究内核支持子 Agent 就自动扩大生产审批边界。生产事故中的失败/中断 trace 可以审计，但生产执行回放目前仍要求完整成功会话。研究 ReplayEngine 则覆盖已记录的取消、失败和超时路径。

## 回归门禁与边界

`pnpm test:regression` 执行全部 workspace 测试、全量构建和生产 smoke；CI 调用此入口，并保留格式、安全审计和独立打包 smoke。新增测试包含真实子 Agent LLM、同名工具隔离、并行 join、三类回放、版本/参数拒绝、stream、多轮、Memory、取消、超时、导出及 API。

这不是分布式执行系统：研究同一 store/session 的并发运行会拒绝，生产仍由现有单机 Ledger/fencing 保护。可恢复 checkpoint 状态不等于任意外部副作用可回滚；也不宣称所有模型、版本、旧 trace 都能逐事件相同。生产开放复杂 Agent 图、外部训练数据适配，以及实际线上延迟/成本标定需要独立验收。
