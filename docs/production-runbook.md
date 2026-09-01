# Veridical 生产切换运行手册

本文描述当前仓库已经实现的生产运行边界。生产模式必须使用 PostgreSQL、Redis 和 S3；SQLite、本地对象存储和进程内队列只允许开发与测试。

## 依赖

- PostgreSQL 14+
- Redis 7+
- S3 兼容对象存储（MinIO、AWS S3 等）
- Vault/KMS 或环境变量中的 32 字节数据密钥与审计密钥
- 已注册且固定版本的模型 Provider

生产配置至少需要：

```json
{
  "storage": {
    "database": "postgres",
    "queue": "redis",
    "objectStore": "s3",
    "postgresUrl": "postgres://…",
    "redisUrl": "redis://…",
    "s3Endpoint": "https://…",
    "s3Bucket": "veridical"
  }
}
```

启动前会执行配置校验、PostgreSQL migration、数据库探针、Redis 探针、S3 健康检查和凭据解析；任一步失败都会拒绝启动。

密钥只能通过环境变量或 Vault 引用提供，不得写入配置正文、Spec、Release 或浏览器：

```bash
export VERIDICAL_CONFIG=/etc/veridical/production.json
export VERIDICAL_DATA_KEY=<64-hex>
export VERIDICAL_AUDIT_KEY=<64-hex>
export VERIDICAL_MODE=production
pnpm --filter @veridical/server build
pnpm --filter @veridical/server start:production
```

`/health/ready` 会同时检查 PostgreSQL、Redis、S3、Worker 和容量；Redis 只负责投递唤醒，Job、Trace、Artifact 和 Audit 的事实状态全部来自 PostgreSQL。

## SQLite 迁移

停止新写入后执行：

```bash
VERIDICAL_SQLITE_PATH=/path/source.db \
VERIDICAL_POSTGRES_URL=postgres://… \
VERIDICAL_DATA_KEY=<64-hex> \
VERIDICAL_AUDIT_KEY=<64-hex> \
VERIDICAL_MIGRATION_REPORT=/secure/migration-report.json \
pnpm db:migrate:postgres
```

迁移会复制 sessions、events、artifacts、pointers、jobs、token revocation 和 rate limits，并校验：

- 事件 hash chain
- 源库与目标库行数
- Artifact digest
- Release pointer
- Job terminal state
- 审计事件数量
- 迁移期间 SQLite 源库快照没有变化

任何校验失败都不会切换流量。仅当报告 `ok: true` 且完成只读比对后才允许 Canary。

迁移前应停止新写入并保留 SQLite 快照。脚本还会检测迁移期间源库是否发生变化；检测到并发写入会回滚导入。

## 回滚

迁移使用唯一 migration id，并且只允许回滚“导入前目标库为空”的 checkpoint：

```bash
VERIDICAL_MIGRATION_ID=<completed-migration-id> \
VERIDICAL_SQLITE_PATH=/path/source.db \
VERIDICAL_POSTGRES_URL=postgres://… \
VERIDICAL_DATA_KEY=<64-hex> \
VERIDICAL_AUDIT_KEY=<64-hex> \
pnpm db:migrate:postgres -- --rollback
```

回滚会锁定迁移、移除该迁移租户的数据并恢复事件不可变触发器。正常生产运行禁止删除事件。

## 发布门禁

```bash
pnpm typecheck
pnpm test
pnpm test:regression
pnpm test:infrastructure
pnpm test:production
```

生产 API 只接受已审批并部署的 Release。草稿、Mock 工具、动态能力、未审批 Skill/MCP 和 SQLite fallback 都会被拒绝。

任何 Spec、Skill、Tool、MCP、Model、Loop 或 Knowledge 版本变化都必须生成新 Release 并重新评测。gbrain Knowledge Backend 只能使用启动时注入的固定 MCP bindings，禁止运行时动态发现。

## 运行检查

- `/health/live`：进程存活
- `/health/ready`：数据库、队列、对象存储和容量检查
- `/v1/runs/:id/provenance`：Release/模型/能力来源
- `/v1/tasks/:id/invocations`：完整调用图
- `/v1/tasks/:id/trajectory/export`：JSONL/GRPO 轨迹归档

Strict Replay 是生产默认回放模式。Fixture 或 Semantic Replay 必须由调用方显式指定，并在结果中标记降级原因。

## 故障处理

- Redis 不可用：readiness 失败；queued Job 保留在 PostgreSQL，Worker 恢复后重新投递。
- Worker 崩溃：租约到期后回收，fencing 防止旧 Worker 写入。
- S3 暂时失败：Artifact 上传最多重试三次，不回落本地存储。
- Replay miss：Strict Replay 直接失败，不调用 live 外部服务。
- 事件链或 digest 校验失败：停止流量，保留快照，禁止强行切换。

生产控制台使用 `/v1/models`、`/v1/tools`、`/v1/capabilities`、`/v1/tasks/:id/invocations` 和 `/v1/tasks/:id/trajectory/export` 读取服务端真实能力，不要求浏览器填写凭据。轨迹导出只生成 GRPO/RL 数据，不在 Veridical 内训练。

## 关闭与回滚

1. 停止入口流量并等待 Worker drain。
2. 保留 PostgreSQL、S3、SQLite 快照和迁移报告。
3. 仅在事件链、Job fencing、Artifact digest 和 Strict Replay 检查通过后恢复旧 Release。

生产日志和导出文件不得包含 API Key；Trace 中的敏感字段必须保留 redaction 标记与 hash。
