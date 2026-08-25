import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { SessionsPage } from './pages/SessionsPage';
import { SessionPage } from './pages/SessionPage';
import { RunPage } from './pages/RunPage';
import { ComparePage } from './pages/ComparePage';
import { AuditPage } from './pages/AuditPage';
import { SpecsPage } from './pages/SpecsPage';
import { RlPage } from './pages/RlPage';

const router = createBrowserRouter([
  { path: '/', element: <AppShell />, children: [
    { index: true, element: <SessionsPage /> },
    { path: 'sessions/:id', element: <SessionPage /> },
    { path: 'run', element: <RunPage /> },
    { path: 'compare', element: <ComparePage /> },
    { path: 'audit', element: <AuditPage /> },
    { path: 'specs', element: <SpecsPage /> },
    { path: 'rl', element: <RlPage /> },
    { path: '*', element: <Navigate to="/" replace /> },
  ] },
]);

export function App() { return <RouterProvider router={router} />; }
