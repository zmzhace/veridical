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

打开 `http://127.0.0.1:5177`，可使用会话、运行、Spec、回放和审计页面。

服务端 LLM 配置放在仓库根目录的 `.env.local`（该文件不应提交）：

```dotenv
VERIDICAL_LLM_BASE_URL=https://your-provider.example/v1
VERIDICAL_LLM_API_KEY=your-secret
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

进入 `/replay` 选择一次运行，然后选择回放方式并执行。时间线用于查看事实；回放工作台用于重建、比较差异和查看降级原因。

研究数据可通过接口导出：

```text
GET  /api/sessions/:id/trajectory
POST /api/sessions/:id/trajectory/export   # json / jsonl / grpo
GET  /api/sessions/:id/invocations
POST /api/sessions/:id/replay
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
packages/web      运行观察台和回放工作台
packages/demo     端到端示例
```

## 边界说明

Veridical 负责运行、记录、回放、评测和训练数据导出，不负责在系统内训练模型。生产环境默认 Strict Replay，不允许未声明的 live fallback 或未审批 Artifact。
