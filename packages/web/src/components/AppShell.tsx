import { NavLink, Outlet } from 'react-router-dom';
const links = [
  ['/', 'Sessions'], ['/run', 'Run'], ['/compare', 'Compare'], ['/audit', 'Audit'], ['/specs', 'Specs'],
];
export function AppShell() {
  return (
    <div className="flex h-screen">
      <nav className="w-48 border-r p-4 space-y-2">
        <h1 className="font-bold mb-4">Veridical</h1>
        {links.map(([to, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => `block px-2 py-1 rounded ${isActive ? 'bg-black text-white' : 'hover:bg-gray-100'}`}>{label}</NavLink>
        ))}
      </nav>
      <main className="flex-1 overflow-auto p-6"><Outlet /></main>
    </div>
  );
}
