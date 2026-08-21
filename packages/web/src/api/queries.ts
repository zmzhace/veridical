import { useQuery, useMutation } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { SessionSummary, SessionEvents, ReplayResponse, CompareResponse, EvalResponse, RunResponse } from './types';

export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: () => apiFetch<SessionSummary[]>('/api/sessions') });
export const useSession = (id: string) => useQuery({ queryKey: ['session', id], queryFn: () => apiFetch<SessionEvents>(`/api/sessions/${id}`) });
export const useReplay = (id: string, seq: number) => useQuery({ queryKey: ['replay', id, seq], queryFn: () => apiFetch<ReplayResponse>(`/api/sessions/${id}/replay`, { method: 'POST', body: JSON.stringify({ targetSeq: seq }) }), enabled: seq > 0 });
export const useSpecs = () => useQuery({ queryKey: ['specs'], queryFn: () => apiFetch<unknown[]>('/api/specs') });
export const useRun = () => useMutation({ mutationFn: (body: unknown) => apiFetch<RunResponse>('/api/run', { method: 'POST', body: JSON.stringify(body) }) });
export const useCompare = () => useMutation({ mutationFn: (body: { a: string; b: string }) => apiFetch<CompareResponse>('/api/compare', { method: 'POST', body: JSON.stringify(body) }) });
export const useEvaluate = () => useMutation({ mutationFn: (body: { sessionId: string }) => apiFetch<EvalResponse>('/api/evaluate', { method: 'POST', body: JSON.stringify(body) }) });
