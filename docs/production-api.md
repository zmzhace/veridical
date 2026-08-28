# 生产 API 工作流

所有 `/v1` 请求携带 `Authorization: Bearer <token>`。POST JSON 需 `Content-Type: application/json`。不要把 tenant、模型密钥或自选 provider 放到业务请求中；身份从凭据推导，模型来自已审批配置。

| API | 最低角色 | 用途 |
|---|---|---|
| GET /v1/me | 有效凭据 | 查看当前身份 |
| POST /v1/specs | developer | 注册不可覆盖的 YAML 版本 |
| GET /v1/specs | viewer / developer / reviewer / publisher | 分页读取版本 |
| POST /v1/suites/:name | reviewer | 创建并启用不可变评测套件 |
| POST /v1/evaluations | developer / reviewer | 异步评测 |
| POST /v1/approvals | reviewer，且非作者 | 审批当前通过的评测证据 |
| POST /v1/deployments/:name | publisher | production/canary 发布或回滚 |
| POST /v1/revocations | reviewer | 撤回版本 |
| POST /v1/runs | operator | 执行/续接已发布版本 |
| POST /v1/improvements | developer | 生成候选并自动排队评测 |
| POST /v1/replays | operator / reviewer | 零外部调用回放 |
| GET /v1/jobs/:id | viewer / operator / developer / reviewer | 查询终态与结果 |
| POST /v1/jobs/:id/cancel | run/replay: operator；其他: developer/reviewer | 取消任务 |
| GET /v1/sessions | viewer / operator | 仅列出业务运行会话 |
| GET /v1/sessions/:id/events | viewer / operator；评测等非业务会话仅 reviewer | 读取事件 |
| GET/POST /v1/sessions/:id/integrity | 同会话访问权限 | 获取检查点/用已有检查点校验 |
| GET /v1/audit | reviewer | 独立治理审计流 |
| POST /v1/tokens/revoke | admin | 持久化撤销本租户令牌 |
| GET /v1/metrics | admin | 状态和容量指标 |

admin 可执行本租户全部角色操作，但不能绕过非作者审批。异步 POST（evaluations/runs/improvements/replays）必须有 `Idempotency-Key`，8–120 个字母、数字、下划线、点或横杠。返回 202 的 `{id,session,kind,state,created,result}`；轮询 jobs 直到 completed/failed/cancelled/interrupted。

以下是请求体示例，不包含可用密钥，也不会自行调用收费模型。

## 1. 创建候选

先将模型名改成配置中登记的实际 model，以下以 `model-release` 示意其位置：

```yaml
name: support
version: 1.0.0
schema_version: 1
instruction:
  system: Answer the question concisely. If uncertain, say you do not know.
flow: {mode: single-loop, max_steps: 4}
llm: {provider: primary, model: model-release}
tools:
  - {name: echo, access: allow}
  - {name: finish, access: allow}
```

`POST /v1/specs`：`{"yaml":"完整 YAML 字符串"}`。未知字段、未登记工具/模型、ask 权限、过大步数、supervisor 等均拒绝。

## 2. reviewer 管理测试集

`POST /v1/suites/support`：

```json
{
  "name": "support-acceptance",
  "cases": [
    {"input": "Reply with the word READY.", "contains": ["READY"], "excludes": ["password"]},
    {"input": "Reply with the word CONFIRMED.", "contains": ["CONFIRMED"]},
    {"input": "Reply with the word UNKNOWN.", "contains": ["UNKNOWN"]}
  ]
}
```

这只是接口示例，不是生产业务的有效验收集。每例检查运行完成、无错误、助手消息包含 contains、不含 excludes，以及成功执行 requiredTools 中的工具。断言匹配全部助手文字，不是语义质量评分。至少三个不同输入且每例至少一个正向断言。更新套件会使旧审批失效。

## 3. 评测 → 审批 → 发布

```text
POST /v1/evaluations
Idempotency-Key: evaluate-support-1
{"ref":"support@1.0.0"}

GET /v1/jobs/<returned-id>

POST /v1/approvals
{"ref":"support@1.0.0","reason":"已核对独立测试集与运行证据"}

POST /v1/deployments/support
{"ref":"support@1.0.0","channel":"production","reason":"批准首批只读业务流量"}
```

仅当 evaluation job completed 且 result.passed 为 true 才能审批。reviewer 需与版本 author 不同；publisher 显式发布。审批本身不会切换流量。

## 4. 运行、续接、检查和回放

```text
POST /v1/runs
Idempotency-Key: support-request-001
{"name":"support","prompt":"请帮助回答我的问题"}

POST /v1/runs
Idempotency-Key: support-request-002
{"name":"support","prompt":"继续追问","session":"<returned-session>"}

GET /v1/sessions/<session>/events?after=0&limit=100
GET /v1/sessions/<session>/integrity

POST /v1/replays
Idempotency-Key: support-replay-001
{"session":"<completed-session>"}
```

events 以 seq 游标分页，limit 1–500；其余列表为 limit 1–100、offset；audit 的 offset 是起始 seq。回放结果 matched=true 表示业务语义事件相同（忽略新事件 ID、时间、耗时、任务元数据），不代表重新询问真实模型会给相同答案。运行环境不同或轨迹不完整时明确失败，绝不回退到真实模型。

## 5. 受控自动改进

```text
POST /v1/improvements
Idempotency-Key: improve-support-001
{"name":"support","version":"1.1.0","feedback":"请在不确定时更明确表达局限"}
```

后台读取当前 production 基线及最多五个近期匹配业务会话，生成新的 system instruction。它保留模型、工具与权限，记录基线摘要、样本来源和生成 job。候选评测自动排队，查询 result.evaluation_job 获取结果。

**候选即使全部通过，也只能停在 evaluated。** 人工审核新版本及生成来源，再走审批和发布。没有内置定时调度，触发此 API 即启动生成与评测流程；不是模型权重训练或持续后台自主发布。

## 6. 紧急处理

```text
POST /v1/jobs/<id>/cancel

POST /v1/revocations
{"ref":"support@1.1.0","reason":"线上观察发现不符合验收要求"}

POST /v1/deployments/support
{"ref":"support@1.0.0","channel":"production","reason":"回滚到当前环境仍然批准的版本"}
```

撤回后不能再执行该版本，但审计和历史不删除。回滚不能复活已撤回版本。令牌撤回需提供 config 中的 hash 与原因；补发令牌采用新随机值、新哈希和配置重启，不要重新启用旧泄漏凭据。
