import { useCapabilityDetail, type CapabilitySummary } from '../api/queries';

const kindLabel: Record<CapabilitySummary['kind'], string> = {
  tool: '工具',
  mcp: 'MCP',
  skill: 'Skill',
  memory: '记忆',
  knowledge: '知识',
};

const statusLabel: Record<CapabilitySummary['status'], string> = {
  approved: '可使用',
  draft: '待审批',
  deprecated: '将停用',
  revoked: '已撤销',
  unavailable: '不可用',
};

const riskLabel: Record<CapabilitySummary['risk'], string> = {
  none: '无副作用',
  read: '读取',
  write: '可修改',
  destructive: '高风险',
};

export function CapabilityRow({
  capability,
  selected,
  enabled,
  onSelect,
  onToggle,
}: {
  capability: CapabilitySummary;
  selected?: boolean;
  enabled?: boolean;
  onSelect: () => void;
  onToggle?: () => void;
}) {
  return (
    <article className={`capability-row${selected ? ' is-selected' : ''}`}>
      <button className="capability-row-main" type="button" onClick={onSelect}>
        <span className={`capability-kind is-${capability.kind}`}>
          {kindLabel[capability.kind]}
        </span>
        <span className="capability-row-copy">
          <strong>{capability.display_name}</strong>
          <small>{capability.summary || '暂无说明'}</small>
        </span>
        <span className="capability-row-facts">
          <small>
            {capability.source} · {capability.version}
          </small>
          <small>{riskLabel[capability.risk]}</small>
        </span>
        <span className={`capability-state is-${capability.status}`}>
          {statusLabel[capability.status]}
        </span>
      </button>
      {onToggle && (
        <button
          type="button"
          className={`capability-toggle${enabled ? ' is-on' : ''}`}
          role="switch"
          aria-checked={Boolean(enabled)}
          aria-label={`${enabled ? '停用' : '启用'} ${capability.display_name}`}
          disabled={capability.status !== 'approved'}
          onClick={onToggle}
        >
          <span />
        </button>
      )}
    </article>
  );
}

export function CapabilityDetail({
  capability,
  onClose,
}: {
  capability: CapabilitySummary;
  onClose: () => void;
}) {
  const detail = useCapabilityDetail(capability);
  const data = detail.data ?? {};
  return (
    <aside className="capability-detail" aria-label={`${capability.display_name} 详情`}>
      <header>
        <div>
          <span className={`capability-kind is-${capability.kind}`}>
            {kindLabel[capability.kind]}
          </span>
          <h2>{capability.display_name}</h2>
          <p>{capability.summary || '暂无说明'}</p>
        </div>
        <button className="detail-close" type="button" onClick={onClose} aria-label="关闭详情">
          ×
        </button>
      </header>
      <dl className="capability-detail-grid">
        <div>
          <dt>状态</dt>
          <dd>{statusLabel[capability.status]}</dd>
        </div>
        <div>
          <dt>权限</dt>
          <dd>{riskLabel[capability.risk]}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>{capability.source}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>{capability.version}</dd>
        </div>
        <div>
          <dt>使用 Agent</dt>
          <dd>{capability.used_by_count} 个</dd>
        </div>
        <div>
          <dt>健康</dt>
          <dd>
            {capability.health === 'offline'
              ? '离线'
              : capability.health === 'degraded'
                ? '需要处理'
                : '正常'}
          </dd>
        </div>
      </dl>
      {capability.tags.length > 0 && (
        <section>
          <h3>适用场景</h3>
          <div className="capability-tags">
            {capability.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        </section>
      )}
      {capability.kind === 'skill' && (
        <section>
          <h3>什么时候使用</h3>
          <p>{data.description || capability.summary}</p>
          <h3>加载方式</h3>
          <p>默认按任务相关性加载。Skill 只提供方法和资源，不会自动获得工具权限。</p>
          <h3>工具依赖</h3>
          <p>
            {(data.tool_dependencies ?? capability.tool_dependencies)?.length
              ? (data.tool_dependencies ?? capability.tool_dependencies).join('、')
              : '没有声明工具依赖'}
          </p>
          {data.content && (
            <details>
              <summary>查看 Skill 指令</summary>
              <pre className="capability-code-preview">{data.content}</pre>
            </details>
          )}
        </section>
      )}
      {capability.kind === 'mcp' && (
        <section>
          <h3>连接</h3>
          <p>
            {data.transport
              ? `${data.transport} · ${data.health === 'offline' ? '离线' : data.health === 'degraded' ? '需要处理' : '连接正常'}`
              : '正在读取连接信息'}
          </p>
          <h3>已发现能力</h3>
          <p>
            {data.discovered_tools?.length ?? capability.discovered_count ?? 0} 个工具。连接 MCP
            不会自动把全部工具授权给 Agent。
          </p>
          {data.discovered_tools?.length > 0 && (
            <div className="capability-child-list">
              {data.discovered_tools.slice(0, 12).map((tool: any) => (
                <span key={tool.id ?? tool.name}>{tool.name}</span>
              ))}
            </div>
          )}
        </section>
      )}
      {capability.kind === 'tool' && (
        <section>
          <h3>用途</h3>
          <p>{data.description || capability.summary}</p>
          <h3>输入与输出</h3>
          <p>输入参数会按当前版本 Schema 校验；完整 Schema 仅在测试和运行详情中展开。</p>
          <div className="capability-tags">
            <span>{riskLabel[capability.risk]}</span>
            <span>{data.timeout_ms ? `${data.timeout_ms}ms 超时` : '受运行预算限制'}</span>
          </div>
        </section>
      )}
      <section className="capability-advanced">
        <h3>版本标识</h3>
        <code>{capability.content_hash || '当前来源未提供内容 Hash'}</code>
      </section>
    </aside>
  );
}

export const capabilityKindLabel = kindLabel;
