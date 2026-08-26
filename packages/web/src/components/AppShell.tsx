import { NavLink, Outlet } from 'react-router-dom';

const links: { to: string; label: string; icon: string; desc: string }[] = [
  { to: '/', label: '会话', icon: '⊞', desc: '查看所有运行记录' },
  { to: '/run', label: '运行', icon: '▶', desc: '运行一个 agent' },
  { to: '/rl', label: 'RL 训练', icon: '⌁', desc: '训练决策策略' },
  { to: '/compare', label: '对比', icon: '⧉', desc: '比对两次运行' },
  { to: '/audit', label: '审计', icon: '✓', desc: '评估合规性' },
  { to: '/specs', label: '规格', icon: '≡', desc: '已注册的规格' },
];

export function AppShell() {
  return (
    <div className="flex min-h-screen">
      <nav className="w-60 shrink-0 border-r border-[var(--line)] bg-[var(--surface)] flex flex-col sticky top-0 h-screen">
        <div className="px-5 pt-6 pb-5 border-b border-[var(--line)]">
          <h1 className="text-lg font-extrabold tracking-tight">Veridical</h1>
          <p className="text-xs text-[var(--muted)] mt-0.5">Agent 运行观察台</p>
        </div>
        <div className="flex-1 p-3 space-y-1 overflow-auto">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.to === '/'}
              className={({ isActive }) =>
                `group flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors ${
                  isActive ? 'bg-[var(--accent-soft)]' : 'hover:bg-[#f1efe9]'
                }`}>
              {({ isActive }) => (
                <>
                  <span className={`mt-0.5 w-6 text-center rounded-md py-0.5 text-xs font-bold ${isActive ? 'bg-[var(--accent)] text-white' : 'bg-[#f1efe9] text-[var(--muted)]'}`}>
                    {l.icon}
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-[13px] font-semibold ${isActive ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}>{l.label}</span>
                    <span className="block text-[11px] text-[var(--muted)] truncate">{l.desc}</span>
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </div>
        <div className="p-4 border-t border-[var(--line)] text-[11px] text-[var(--muted)]">
          trace · replay · rl · stage-gate
        </div>
      </nav>
      <main className="flex-1 overflow-auto p-8">
        <div className="max-w-6xl mx-auto"><Outlet /></div>
      </main>
    </div>
  );
}