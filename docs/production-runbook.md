# Veridical 生产运行手册

本文是生产环境的最短可执行路径。生产 profile 只允许 PostgreSQL、Redis 和 S3；SQLite、本地对象存储、进程内队列和 mock provider 仅用于开发与测试。

## 1. 启动前检查

准备配置文件（不要写入密钥正文）：

```json
{
  "database": "/var/lib/veridical/unused-in-production.db",
  "releaseId": "release-2026-09-01",
  "storage": {
    "database": "postgres",
    "queue": "redis",
    "objectStore": "s3",
    "postgresUrl": "postgres://...",
    "redisUrl": "redis://...",
    "s3Endpoint": "https://s3.example.com",
    "s3Bucket": "veridical-artifacts",
    "s3AccessKeyEnv": "VERIDICAL_S3_ACCESS",
    "s3SecretKeyEnv": "VERIDICAL_S3_SECRET"
  }
}
```

密钥通过环境变量或 Vault 引用提供：

```bash
export VERIDICAL_CONFIG=/etc/veridical/production.json
export VERIDICAL_DATA_KEY=<64 hex characters>
export VERIDICAL_AUDIT_KEY=<64 hex characters>
export VERIDICAL_S3_ACCESS=<access key>
export VERIDICAL_S3_SECRET=<secret key>
export VERIDICAL_MODE=production
```

启动会自动执行 PostgreSQL migration，并在缺少任一托管依赖时 fail-closed。

## 2. 运行与健康检查

```bash
pnpm --filter @veridical/server build
pnpm --filter @veridical/server start:production
curl http://127.0.0.1:8787/health/live
curl -H "Authorization: Bearer $OPERATOR_TOKEN" http://127.0.0.1:8787/health/ready
```

`ready` 同时验证 PostgreSQL、Redis、S3 bucket、Worker 状态和存储容量。Redis 只负责投递唤醒，Job、Trace、Artifact 和 Audit 的事实状态全部来自 PostgreSQL。

## 3. SQLite 迁移

迁移前停止新写入并备份 SQLite 文件。迁移工具会校验事件 hash chain、Artifact digest、Release pointer、Job 终态和 Invocation Graph 投影：

```bash
export VERIDICAL_SQLITE_PATH=/var/backups/veridical.sqlite
export VERIDICAL_POSTGRES_URL='postgres://...'
export VERIDICAL_DATA_KEY=<source data key>
export VERIDICAL_AUDIT_KEY=<source audit key>
export VERIDICAL_MIGRATION_REPORT=/var/backups/migration.json
pnpm --filter @veridical/server db:migrate:postgres
```

只有报告中的 `ok: true` 且所有计数、租户和 hash 校验通过后才能切换流量。回滚只能针对迁移前为空的 PostgreSQL 目标：

```bash
pnpm --filter @veridical/server db:migrate:postgres -- --rollback
```

## 4. 发布门禁

发布前必须执行：

```bash
pnpm typecheck
pnpm format:check
pnpm test:regression
pnpm test:infrastructure
pnpm test:production:postgres
pnpm test:production:migration
pnpm build
```

生产只接受已审批的 Release Artifact。任何 Spec、Skill、Tool、MCP、Model、Loop 或 Knowledge 版本变化都必须生成新 Release 并重新评测。

## 5. 故障处理

- Redis 短暂不可用：readiness 失败；PostgreSQL 中的 queued Job 会在 Worker 重启时重新投递。
- Worker 崩溃：Redis lease 到期后回收，PostgreSQL fencing 防止旧 Worker 写入；新 Worker 接管过期 Job。
- S3 短暂失败：Artifact 上传最多重试三次；最终失败返回明确错误，不回落本地存储。
- Replay miss：生产 Strict Replay 直接失败，不得自动调用 live 外部服务。
- 数据链校验失败：停止流量，保留快照，禁止强行切换。

## 6. 能力、轨迹与发布核验

生产控制台使用以下只读接口读取服务端真实能力，不要求浏览器填写凭据：

```bash
curl -H "Authorization: Bearer $OPERATOR_TOKEN" \
  http://127.0.0.1:8787/v1/capabilities
curl -H "Authorization: Bearer $OPERATOR_TOKEN" \
  http://127.0.0.1:8787/v1/releases/probe@1.0.0/manifest
curl -H "Authorization: Bearer $OPERATOR_TOKEN" \
  http://127.0.0.1:8787/v1/sessions/$SESSION/trajectory
curl -H "Authorization: Bearer $REVIEWER_TOKEN" \
  -X POST -H 'content-type: application/json' \
  -d '{"format":"grpo","group_id":"research-v1"}' \
  http://127.0.0.1:8787/v1/sessions/$SESSION/trajectory/export
```

`capabilities` 只返回已注册能力；`manifest` 是发布时的不可变版本快照；轨迹导出只生成训练数据，不在 Veridical 内执行训练。

## 7. 关闭与回滚

1. 停止入口流量。
2. 等待 `/health/ready` 变为不可用并 drain Worker。
3. 保留 PostgreSQL、S3、SQLite 快照和迁移报告。
4. 仅在事件链、Job fencing、Artifact digest 和 Strict Replay 检查通过后恢复旧 Release。

生产日志和导出文件不得包含 API Key；Trace 中的敏感字段必须保留 redaction 标记与 hash。
