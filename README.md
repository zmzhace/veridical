# Veridical

面向生产的可回溯 Agent 运行系统：记录完整调用轨迹，支持多 Agent、工具调用、严格回放、行为评测和 GRPO 数据导出。

## 核心能力

- **完整轨迹**：主 Agent、子 Agent、LLM、工具、记忆和 checkpoint 都写入不可变事件流。
- **多轮对话**：同一会话持续保留上下文，每一轮都可追溯。
- **调用图**：用 `path` 和 `invocation_id` 还原真实调用顺序，例如 `root/delegate:researcher/tool:search#1`。
- **三种回放**：Strict 严格重建、Fixture 固定依赖、Semantic 行为验证。
- **可评测与可对比**：按规则、Golden、工具序列、成本、步骤和延迟验证运行质量。
- **训练数据导出**：输出包含 prompt、state、action、tool input/output、next state、reward 的 JSONL/GRPO 数据；训练不在本系统内执行。
- **生产隔离**：研究控制台使用 `/api`，生产 API 使用 `/v1`，生产只执行已批准的版本和依赖。

## 快速开始

要求 Node.js `>=22.14.0` 和 pnpm。

```bash
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5177`。产品默认进入 Agent 列表：

- Agent App：像任务助手一样进行多轮工作，产物和运行摘要随任务保留。
- Agent Studio：在同一画布中构建、真实运行、严格回放和发布。
- 运行详情：按调用树查看 Agent、子 Agent、LLM 与 Tool 的完整脱敏输入输出。

服务端 LLM 配置放在仓库根目录的 `.env.local`（该文件不应提交）：

```dotenv
VERIDICAL_LLM_BASE_URL=https://your-provider.example/v1
VERIDICAL_PROVIDER_KEY=your-secret
VERIDICAL_LLM_MODEL=your-model
```

前端不会要求重复填写密钥，密钥只由服务端读取。

## 常用命令

```bash
pnpm test              # 全 workspace 测试
pnpm build             # 全 workspace 构建
pnpm test:regression   # 测试、构建、生产 smoke check
pnpm test:llm:live     # 小规模真实模型检查，然后离线回放
```

## 回放与轨迹

在 Agent Studio 的“回放”模式选择历史任务；普通任务中的“运行详情”用于查看调用树、比较差异和导出数据。旧 `/run`、`/replay`、`/specs` 页面会重定向到 Agent 产品入口。

研究数据可通过接口导出：

```text
GET  /api/sessions/:id/trajectory
POST /api/sessions/:id/trajectory/export   # json / jsonl / grpo
GET  /api/sessions/:id/invocations
POST /api/sessions/:id/replay
GET  /api/agents
GET  /api/agents/:id/tasks
GET  /api/tasks/:id/invocations
```

## 目录结构

```text
packages/schema   事件和调用记录模型
packages/store    追加式 trace 存储
packages/runtime  Agent Loop、上下文和 recorder
packages/spec     Spec、Artifact 和版本注册
packages/tools    ToolBroker 与权限控制
packages/llm      LLM gateway、mock/live provider
packages/replay   Replay Cursor、回放和 trajectory 投影
packages/eval     规则、Golden、模拟器评测
packages/server   研究 API、生产 API 和服务启动
packages/web      Agent App、Agent Studio、运行详情与治理界面
packages/demo     端到端示例
```

## 边界说明

Veridical 负责运行、记录、回放、评测和训练数据导出，不负责在系统内训练模型。生产环境默认 Strict Replay，不允许未声明的 live fallback 或未审批 Artifact。
## Production configuration

Production mode requires an explicit `VERIDICAL_CONFIG` file and 32-byte keys. The
configuration now declares the storage profile so a local SQLite setup cannot be
mistaken for an enterprise deployment:

```json
{
  "database": "/var/lib/veridical/ledger.db",
  "storage": {
    "database": "sqlite",
    "objectStore": "local",
    "queue": "in_process"
  },
  "releaseId": "release-2026-01",
  "dataKeyEnv": "VERIDICAL_DATA_KEY",
  "auditKeyEnv": "VERIDICAL_AUDIT_KEY"
}
```

For a managed deployment set `database` to `postgres`, `objectStore` to `s3`, or
`queue` to `redis` only after providing the corresponding `postgresUrl`,
`s3Endpoint`, or `redisUrl`. Configuration validation fails closed when a URL is
missing. The current single-host runtime uses the SQLite/in-process/local profile;
PostgreSQL, Redis, S3-compatible storage and Vault/KMS require their production
adapters and integration tests before switching those values.

Provider credentials may be an environment variable name (for example
`QWEN_API_KEY`) or a Vault reference such as
`vault:secret/data/veridical/qwen#api_key`. Set `VERIDICAL_VAULT_ADDR` and
`VERIDICAL_VAULT_TOKEN` (or `VERIDICAL_VAULT_TOKEN_ENV`) for Vault references;
startup fails closed when the secret cannot be resolved.

The research API exposes model and credential metadata without returning secrets:

```text
GET /api/models
GET /api/credentials/status
```

To run local integration dependencies for future PostgreSQL/Redis/S3 adapters:

```bash
pnpm infra:up
pnpm infra:status
pnpm infra:down
```

The compose credentials are development-only. Starting these containers does not
enable managed storage in the application; the production server continues to
fail closed until the corresponding adapter is installed and tested.

The PostgreSQL baseline schema is versioned at
`packages/server/src/production/migrations/001_initial_postgres.sql`. It mirrors
the encrypted Ledger tables and includes immutable-event triggers and active-job
fencing indexes; it is intentionally not applied automatically while the
PostgreSQL Ledger adapter is under development.
