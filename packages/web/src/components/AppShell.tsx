import { NavLink, Outlet, useLocation } from 'react-router-dom';
import '../spec/spec-editor.css';
import '../workspace.css';

const links = [
  { to: '/agents', label: 'Agents', icon: 'M5 6.5h14v11H5z M8 10h8 M8 14h5' },
  { to: '/capabilities', label: '能力', icon: 'M8 4h8v4h4v8h-4v4H8v-4H4V8h4z' },
  { to: '/context', label: '记忆与知识', icon: 'M5 5h14v14H5z M8 9h8 M8 13h6' },
  { to: '/sessions', label: '运行记录', icon: 'M4 12a8 8 0 1 0 3-6.2 M4 4v5h5 M12 8v5l3 2' },
  { to: '/compare', label: '对比', icon: 'M4 4h6v16H4z M14 4h6v16h-6z' },
  { to: '/audit', label: '审计', icon: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z m-4 9 3 3 5-6' },
];

export function AppShell() {
  const { pathname } = useLocation();
  const focused = /^\/agents\/[^/]+/.test(pathname) || pathname.startsWith('/tasks/');
  const current = pathname.includes('/studio')
    ? 'Agent Studio'
    : pathname.includes('/trace')
      ? '运行详情'
      : pathname.startsWith('/agents/')
        ? 'Agent'
        : (links.find((l) => l.to === pathname)?.label ?? 'Veridical');
  return (
    <div className={`workspace-shell${focused ? ' is-focused' : ''}`}>
      <a className="skip-link" href="#workspace-main">
        跳转到主要内容
      </a>
      <aside className="workspace-sidebar">
        <NavLink to="/" className="workspace-brand" aria-label="Veridical 首页">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M4 6h7l5 12 5-12h7L16 28 4 6Z" fill="currentColor" />
          </svg>
          <span>
            Veridical<small>Agent workspace</small>
          </span>
        </NavLink>
        <div className="workspace-identity">
          <span>V</span>
          <div>
            本地工作区<small>Local workspace</small>
          </div>
        </div>
        <nav className="workspace-nav" aria-label="主导航">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === '/'}
              className={({ isActive }) => `workspace-nav-item${isActive ? ' is-active' : ''}`}
            >
              <svg
                width="19"
                height="19"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={l.icon} />
              </svg>
              <span>{l.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="workspace-sidebar-note">
          构建可以被理解、回放和治理的 Agent。<p>日常任务保持简单，运行细节按需展开。</p>
        </div>
        <footer className="workspace-sidebar-footer">
          研究环境<span className="mono">/api</span>
        </footer>
      </aside>
      <div className="workspace-body">
        <header className="workspace-topbar">
          <div>
            工作区<span aria-hidden="true">/</span>
            <strong>{current}</strong>
          </div>
          <span className="workspace-environment">本地研究 · 非生产</span>
        </header>
        <main id="workspace-main" className="workspace-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
