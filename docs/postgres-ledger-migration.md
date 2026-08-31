# PostgreSQL Ledger 迁移设计

## 现状与替换矩阵

| SQLite Ledger 职责 | 当前调用方 | PostgreSQL 目标 | 一致性要求 |
|---|---|---|---|
| sessions / sequence | app、runner、replay | `sessions` | tenant+id 唯一；事件追加锁行 |
| encrypted events / hash chain | runner、replay、trace UI | `events` | `SELECT ... FOR UPDATE`、prev/head 原子更新 |
| artifact / pointer | service、admin、API | `artifacts`、`pointers` | body 不可变；状态迁移审计化 |
| jobs / lease | service、worker | `jobs` | `FOR UPDATE SKIP LOCKED`、owner fencing |
| audit | app、service | `events` audit session | 与业务事务同事务提交 |
| rate limit | app | `rate_limits` | UPSERT 原子窗口计数 |
| backup / capacity | admin、readiness | pg backup/ops metrics | 不再暴露 SQLite 句柄 |

## 迁移顺序

1. 定义异步 `LedgerPort`，禁止业务层访问 `db.sql`。
2. 实现 `PostgresLedger` 的 session、事件链和 verify；先通过 trace/replay 集成测试。
3. 实现 artifact/pointer，所有状态迁移和 audit 使用同一个 client transaction。
4. 实现 job enqueue/claim/heartbeat/finish/cancel/recover；claim 使用行锁和租约条件。
5. 将 `ProductionService`、路由和 `TenantTraceStore` 改为 `await` 领域方法。
6. 生产启动按 `storage.database` 选择实现；Postgres 失败直接拒绝启动，禁止 fallback。
7. 运行 SQLite→Postgres 校验工具：逐租户比较 artifact digest、session head、event count 和 job terminal state。
8. 完成切换后移除生产代码对 `better-sqlite3` 和 `db.sql` 的依赖；SQLite 只保留开发/测试 profile。

## 加密与回放

Postgres 只保存密文、digest、prev、hash 和 seal，不改变事件 payload 格式。事件 hash 的 canonical 输入与 SQLite 保持一致，确保旧导出可以校验。Strict Replay 使用 `session head`、事件序号和 manifest 校验；迁移校验失败时禁止发布。

## 禁止事项

- 不允许 Postgres 写入失败后回写 SQLite。
- 不允许同步包装器阻塞异步连接池。
- 不允许业务代码拼接 SQL 绕过领域接口。
- 不允许迁移期间静默丢弃无法解密或校验失败的数据。
