import { useQuery, useMutation } from '@tanstack/react-query';
import { apiFetch } from './client';
import { readSseFrames } from './readSse';
import type { TraceEvent } from '@veridical/schema';
import type { SessionSummary, SessionEvents, ReplayResponse, CompareResponse, EvalResponse, RunResponse, TurnFrame, TurnRequestBody } from './types';

export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: () => apiFetch<SessionSummary[]>('/api/sessions') });
export const useSession = (id: string) => useQuery({ queryKey: ['session', id], queryFn: () => apiFetch<SessionEvents>(`/api/sessions/${id}`), enabled: !!id });
export const useCheckpoints = (id: string) => useQuery({ queryKey: ['checkpoints', id], queryFn: () => apiFetch<TraceEvent[]>(`/api/sessions/${id}/checkpoints`), enabled: !!id });
export const useAddSpec = () => useMutation({ mutationFn: (yaml: string) => apiFetch<unknown>('/api/specs', { method: 'POST', body: JSON.stringify({ yaml }) }) });
export const useReplay = (id: string, seq: number) => useQuery({ queryKey: ['replay', id, seq], queryFn: () => apiFetch<ReplayResponse>(`/api/sessions/${id}/replay`, { method: 'POST', body: JSON.stringify({ targetSeq: seq }) }), enabled: !!id && seq > 0 });
export const useSpecs = () => useQuery({ queryKey: ['specs'], queryFn: () => apiFetch<unknown[]>('/api/specs') });
export const useRun = () => useMutation({ mutationFn: (body: unknown) => apiFetch<RunResponse>('/api/run', { method: 'POST', body: JSON.stringify(body) }) });
export const useCompare = () => useMutation({ mutationFn: (body: { a: string; b: string }) => apiFetch<CompareResponse>('/api/compare', { method: 'POST', body: JSON.stringify(body) }) });
export const useEvaluate = () => useMutation({ mutationFn: (body: { sessionId: string }) => apiFetch<EvalResponse>('/api/evaluate', { method: 'POST', body: JSON.stringify(body) }) });

export const useStartTurn = () => {
  const run = async (body: TurnRequestBody, onFrame: (f: TurnFrame) => void) => {
    const res = await fetch('/api/run/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message ?? res.statusText);
    }
    await readSseFrames(res, onFrame);
  };
  return { run };
};
