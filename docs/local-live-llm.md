# 本地真实 LLM 步骤验证

这是人工触发的本地交互开发检查，不启动 HTTP 服务、不创建生产部署、不自动审批，也不进入 CI。配置文件位于仓库根目录 `.env.local`，权限应为 `0600`。Git 与 Docker 构建上下文均忽略它。

## 重复运行

在仓库根目录执行：

```bash
pnpm test:llm:live
```

每次最多调用模型两次、执行一个本地只读 echo 工具，随后以记录的响应离线回放。运行会消耗真实模型额度；普通 `pnpm test` 不会触发真实调用。

脚本使用已有生产执行器、模型适配器、事件账本与回放代码，但仅在临时数据库中进行开发验证，不经过也不修改生产 API 的审批发布状态。它不代表真实业务工具、生产部署或完整治理流程的上线验收。

## 配置字段

| 环境变量 | 用途 |
|---|---|
| VERIDICAL_PROVIDER_KEY | 模型密钥；仅保存于 `.env.local`，不复制到文档或测试数据 |
| VERIDICAL_LLM_BASE_URL | HTTPS 的 OpenAI 兼容 API 基地址 |
| VERIDICAL_LLM_MODEL | 模型名称，本次为 qwen3.8-flash |
| VERIDICAL_LLM_MAX_OUTPUT_TOKENS | 每次模型调用的输出上限，本次为 1024 |
| VERIDICAL_LLM_ENABLE_THINKING | 可选 true/false；本次显式为 false，避免思考模式占满小额输出预算 |

Node 的 `--env-file` 加载配置；当前进程已存在的同名环境变量会优先于文件。研究服务的 `pnpm dev:server` 和 `pnpm -F @veridical/server start:research` 现在也加载根目录 `.env.local`；**生产服务仍不自动加载此文件**。

网页运行页通过 `GET /api/model-profile` 获取配置状态与模型名称，不获取密钥或服务地址。有配置时默认选中真实模型；只有点击「开始运行」才调用模型，不会在加载页面时消费额度。`POST /api/run` 的 live 模式可省略模型和密钥，由服务端绑定，并在轨迹中记录实际模型。当前连续对话入口仍为 mock；真实模型使用运行页。研究接口仅限本地使用，拒绝非本地网页 Origin，不替代生产鉴权。

Qwen 的 thinking 配置依据[官方兼容接口说明](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)。服务端 provider 配置新增可选 `enableThinking`；更改该参数属于环境变更，会使旧审批不再适用。未配置时不发送该参数。适配器现在也会明确拒绝截断或空白的最终输出。

## 记录与安全

每次运行创建独立 `.traces/live-<timestamp>-<uuid>/`：

- `summary.json`：结果、调用数、tokens、耗时及离线回放结果。
- `trace.json`：真实运行的模型请求/响应、工具调用与结果、执行事件。
- `spec.json`：本次测试的固定指令与工具白名单。
- `replay.json`：离线回放轨迹。失败时另有 `failed-trace.json`。

目录权限 0700，文件权限 0600，不提交 Git。轨迹导出是本地 JSON，包含测试提示词和模型文字，**不是加密导出**。测试只使用固定的合成输入，密钥只放在 HTTPS 认证头中，不放进提示词，导出还会移除意外出现的密钥文本。临时加密数据库在检查结束后清理。

不要把已出现在对话或日志中的长期密钥用于生产。换发后直接更新 `.env.local`，不要把新值再次贴到对话。Token Plan 的使用范围仍需遵守供应商规则；网页入口仅供人工触发的本地开发测试，不配置自动调用或生产部署。

## 本次真实运行记录：2026-08-28

| 验证 | 结果 |
|---|---|
| 最小连接探测 | HTTP 200，精确返回 VERIDICAL_LIVE_OK；796 ms，51 tokens |
| 真实 LLM → echo → LLM | 通过；2 次模型调用，1 次只读工具调用 |
| 双步执行用量 | 输入 384、输出 46，共 430 tokens；总耗时 2071 ms |
| 事件链完整性 | 通过 |
| 记录响应回放 | 语义匹配，0 次外部调用 |

总计本次手动验证进行了 3 次真实模型调用，返回的 usage 合计为 481 tokens；该数字不是费用金额。模型使用别名，未证明供应商底层版本固定，也没有测试高并发、长稳或业务任务准确率。

本次真实验证补充了 [此前的生产候选验收记录](production-verification.md)，并不追溯改变那次 mock 验收的性质。
