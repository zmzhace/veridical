import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { SessionsPage } from './pages/SessionsPage';
import { SessionPage } from './pages/SessionPage';
import { RunPage } from './pages/RunPage';
import { ComparePage } from './pages/ComparePage';
import { AuditPage } from './pages/AuditPage';
import { ReplayPage } from './pages/ReplayPage';
import { WorkspacePage } from './pages/WorkspacePage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    hydrateFallbackElement: (
      <p role="status" className="p-8">
        正在加载工作区…
      </p>
    ),
    children: [
      { index: true, element: <SessionsPage /> },
      { path: 'sessions/:id', element: <SessionPage /> },
      { path: 'run', element: <RunPage /> },
      { path: 'compare', element: <ComparePage /> },
      { path: 'audit', element: <AuditPage /> },
      { path: 'replay', element: <ReplayPage /> },
      { path: 'workspace', element: <WorkspacePage /> },
      {
        path: 'specs',
        lazy: async () => {
          const { SpecsPage } = await import('./pages/SpecsPage');
          return { Component: SpecsPage };
        },
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
