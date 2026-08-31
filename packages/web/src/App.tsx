import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { SessionsPage } from './pages/SessionsPage';
import { SessionPage } from './pages/SessionPage';
import { ComparePage } from './pages/ComparePage';
import { AuditPage } from './pages/AuditPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { AgentsPage } from './pages/AgentsPage';
import { AgentPage } from './pages/AgentPage';
import { TaskTracePage } from './pages/TaskTracePage';
import { CapabilitiesPage } from './pages/CapabilitiesPage';
import { ContextPage } from './pages/ContextPage';

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
      { index: true, element: <Navigate to="/agents" replace /> },
      { path: 'agents', element: <AgentsPage /> },
      { path: 'capabilities', element: <CapabilitiesPage /> },
      { path: 'context', element: <ContextPage /> },
      { path: 'agents/:agentId', element: <AgentPage /> },
      { path: 'agents/:agentId/studio', element: <WorkspacePage /> },
      { path: 'tasks/:taskId/trace', element: <TaskTracePage /> },
      { path: 'sessions/:id', element: <SessionPage /> },
      { path: 'sessions', element: <SessionsPage /> },
      { path: 'run', element: <Navigate to="/agents" replace /> },
      { path: 'compare', element: <ComparePage /> },
      { path: 'audit', element: <AuditPage /> },
      { path: 'replay', element: <Navigate to="/agents" replace /> },
      { path: 'workspace', element: <Navigate to="/agents" replace /> },
      {
        path: 'specs',
        lazy: async () => {
          return { Component: () => <Navigate to="/agents" replace /> };
        },
      },
      { path: '*', element: <Navigate to="/agents" replace /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
