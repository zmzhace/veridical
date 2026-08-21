# Veridical — 记忆系统（Phase 5）设计文档

- 日期：2026-08-21
- 状态：设计评审通过（Phase 5 范围）
- 前置：Phase 1-4 已合并至 main（runtime / spec / eval / replay）

## 1. 背景与目标

Phase 1-4 让 agent 可跑、可声明、可判定、可回放。Phase 5 加**记忆**：让 agent 在会话内（工作记忆）与会话间（长期语义记忆）记住东西，并提供程序性 skills 的载体（供 Phase 7 发布机制固化）。

- **工作记忆**：会话内 KV，随会话生命周期。
- **长期语义记忆**：跨会话，带 tags，按 tags/关键词召回。
- **程序性 skills**：跨会话的 `{ name, description, procedure }` 条目，本 Phase 提供载体。

**核心不变式**：记忆是**事件日志驱动**的。任何记忆读写都是 `memory.*` 事件，从事件日志可重建当前记忆状态（"model-visible means logged"），记忆因此可回放（Phase 4 引擎重放时 `ReplayLLMProvider` 按注入记忆后的实际请求 fingerprint 喂回）。

### 决策依据（Phase 5 范围确认）

- **范围**：三种全做——工作 + 长期语义 + 程序性 skills 载体。
- **存储**：事件日志驱动（无独立存储），`memory.*` 事件 + snapshot 投影。
- **上下文接入**：扩展 `runSpec`（可选 `memory` 字段，循环前召回注入 system message）。
- **召回机制**：标签精确匹配 + 关键词包含 + recency 排序（确定性、可回放，无外部向量库）。
- **架构**：方案 A——单新包 `@veridical/memory`（MemoryStore + Memory 门面 + 三种记忆 + runSpec 接入）。

## 2. MemoryStore（事件驱动存储）+ 记忆事件

### 事件类型（落 TraceStore）

```ts
type MemoryEventPayload =
  | { action: 'write'; key: string; value: unknown; scope: 'working' | 'semantic' | 'skill'; tags?: string[] }
  | { action: 'read'; key: string; scope: 'working' | 'semantic' | 'skill' }
  | { action: 'recall'; query: string; scope: 'semantic' | 'skill'; hits: { key: string }[] };

// TraceStore type 前缀 'memory.*'：
//   memory.write    (verb: request → 写入)
//   memory.read     (verb: request → 读取)
//   memory.recalled (verb: response → 召回结果)
```

### MemoryStore 抽象

```ts
interface MemoryStore {
  write(recorder: Recorder, entry: { key; value; scope; tags? }): Promise<void>;
  read(recorder: Recorder, key: string): Promise<unknown>;
  snapshot(store: TraceStore, session_id: string): Promise<MemorySnapshot>;
}
```

- `write`/`read` 经 recorder 落 `memory.*` 事件。
- `read` 内部 = `snapshot` 后取 key 的当前值（未知 key → `undefined`）。
- `snapshot` 是**纯投影**：读 `memory.write` 事件按 key 覆盖（后写覆盖先写），带 scope/tags——从事件日志重建当前记忆状态，与 `deriveMessages` 同构，任何事件序列都返回状态（不抛）。

### session 归属

- **工作记忆**绑当前 `session_id`。
- **长期记忆（semantic/skill）**跨会话——写入约定共享 session `_memory`。snapshot 工作记忆从当前 session 读，长期从 `_memory` 读。`_memory` 不存在 → 空。

## 3. 三种记忆 + Memory 门面

```ts
type MemoryScope = 'working' | 'semantic' | 'skill';
type MemoryEntry = { key: string; value: unknown; scope: MemoryScope; tags?: string[] };

class Memory {
  constructor(store: MemoryStore, session_id: string);
  // 工作记忆（本会话）
  remember(key: string, value: unknown): Promise<void>;
  workingGet(key: string): Promise<unknown>;
  // 长期语义记忆（跨会话，带 tags）
  rememberSemantic(key: string, value: unknown, tags?: string[]): Promise<void>;
  recall(query: string, opts?: { tags?: string[]; limit?: number }): Promise<MemoryEntry[]>;
  // 程序性 skills（跨会话）
  rememberSkill(name: string, procedure: unknown, tags?: string[]): Promise<void>;
  listSkills(): Promise<MemoryEntry[]>;
  // 遗忘
  forget(key: string, scope: MemoryScope): Promise<void>;
}
```

### 语义召回（确定性）

`recall(query, { tags, limit })` 从长期记忆条目：
1. `tags` 精确匹配（条目 tags 包含任一查询 tag）。
2. `content` 关键词包含——**query 分词规则**：按非字母数字边界切分（`/\W+/`），每个 token 若长度 ≥ 2 则作为关键词，条目 value 字符串化（`JSON.stringify`）后 `includes` 任一关键词即命中。
3. 按 **recency** 排序（写入 seq 越大越新）。
4. 返回 top-N（`limit`，默认 5）。

命中记 `memory.recalled` 事件（含 query、hits keys、scope）。

### 程序性 skills

`scope: 'skill'` 条目，`value` 为 `{ name, description, procedure }`。本 Phase 提供**载体**（读写/列出）；"skill 固化成工具/spec"是 Phase 7 发布机制消费它。

### memoryToSystemPrompt

```ts
function memoryToSystemPrompt(memories: MemoryEntry[]): string;
// 拼成追加块：
//   ## 记忆
//   - [semantic] key: value
//   - [skill] name: description
```

供 runSpec 注入。

## 4. runSpec 记忆接入

`@veridical/spec` 的 `SpecRunnerDeps` 加一个可选字段：

```ts
memory?: MemoryLike;   // 形状最小化，spec 不依赖 memory 包

interface MemoryLike {
  recall(query: string, opts?: { tags?: string[]; limit?: number }): Promise<{ key: string; value: unknown; scope: string; tags?: string[] }[]>;
  onStep?: (step: number, ctx: { prompt: string }) => Promise<void>;
}
```

**依赖方向**：spec 本地定义 `MemoryLike`（最小接口），`@veridical/memory` 的 `Memory` structural-typing 实现它。依赖仍 `@veridical/memory` → `@veridical/spec` 单向。

**runSpec 内部接入**：
- 提供 `memory` 时，`defaultRunStep` 构造 LLM 请求前：`recalled = await memory.recall(prompt)` → 有命中时 system message = `spec.instruction.system` + `memoryToSystemPrompt(recalled)`。
- 命中与否都落 `memory.recalled` 事件（Memory 内部记）。
- `onStep` 钩子每个循环步调用。

**`deriveMessages` 不变**：记忆进入**请求**（system 块）而非事件重建。`deriveMessages` 仍纯事件投影。回放时 `ReplayLLMProvider` 按注入记忆后的实际请求 fingerprint 喂回（fingerprint 基于实际请求，天然支持）。

## 5. 错误处理

- Memory 纯读写不抛（未知 key → `undefined`）。
- `forget` 不存在的 key → no-op。
- `snapshot` 任何事件序列返回状态（不抛）。
- runSpec 注入的 `memory.recall` 抛错 → **按"无记忆"处理**（跳过注入，不崩 loop）——记忆是增强不是依赖。
- 跨会话 `_memory` session 不存在 → snapshot 空。

## 6. 测试策略

TDD，镜像 Phase 1-4 模式。

- **MemoryStore**：write → snapshot 重建（覆盖、多 scope、tags）；read；事件类型正确落 store。
- **Memory 门面**：工作记忆读写；语义 rememberSemantic → recall（tags 匹配、关键词包含、recency 排序、limit）；skills 读写列出；forget。
- **runSpec 接入**：注入 memory（mock）→ recall 命中时 system message 含记忆块、未命中纯 system；`memory.recalled` 事件落 store；recall 抛错降级继续。
- **demo**：带记忆多轮运行——第一轮 rememberSemantic，第二轮 recall 命中注入。

## 7. 包结构

新包 `@veridical/memory`（依赖 spec/runtime/store/schema）：

```
packages/memory/
├── src/
│   ├── events.ts        # memory.* 事件 payload 类型
│   ├── store.ts         # MemoryStore + snapshot 重建
│   ├── memory.ts        # Memory 门面（working/semantic/skill + recall/forget）
│   ├── prompt.ts        # memoryToSystemPrompt
│   └── index.ts
└── test/
    ├── store.test.ts
    ├── memory.test.ts
    └── prompt.test.ts
```

`@veridical/spec` 改动：`SpecRunnerDeps` 加 `memory?: MemoryLike`（一个可选字段，spec 不依赖 memory 包）。

## 8. Demo 更新

`packages/demo` 增加带记忆跑法：多轮运行，第一轮 `rememberSemantic`，第二轮 recall 命中注入 system 块，验证 `memory.*` 事件落 trace。

## 9. 依赖链与后续

- Phase 5 依赖 Phase 1（runtime/store）、Phase 2（spec/runSpec）。
- Phase 7 发布/会读消费程序性 skills（固化成工具/spec）；Phase 4 回放对带记忆运行天然支持（fingerprint 基于实际请求）。
- 语义记忆的向量召回（外部嵌入）留后续；当前标签+关键词保证确定性回放。
