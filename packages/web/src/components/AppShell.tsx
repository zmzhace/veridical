import { NavLink, Outlet, useLocation } from 'react-router-dom';
import '../spec/spec-editor.css';
import '../workspace.css';

const links = [
  { to: '/', label: '会话', icon: 'M4 4h16v12H8l-4 4V4Z M8 8h8 M8 12h5' },
  { to: '/workspace', label: '工作区', icon: 'M4 5h6v6H4z M14 5h6v6h-6z M4 15h6v4H4z M14 15h6v4h-6z' },
  { to: '/compare', label: '对比', icon: 'M4 4h6v16H4z M14 4h6v16h-6z' },
  { to: '/audit', label: '审计', icon: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z m-4 9 3 3 5-6' },
];

export function AppShell() {
  const { pathname } = useLocation();
  const current = links.find((l) => l.to === pathname)?.label ?? '会话详情';
  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#workspace-main">
        跳转到主要内容
      </a>
      <aside className="workspace-sidebar">
        <NavLink to="/" className="workspace-brand" aria-label="Veridical 首页">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M4 6h7l5 12 5-12h7L16 28 4 6Z" fill="currentColor" />
          </svg>
          <span>
            Veridical<small>Agent 运行观察台</small>
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
          每一次决策，都有迹可循。<p>运行、回放与评测，在同一条轨迹中连接。</p>
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
