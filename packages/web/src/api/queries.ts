import { useQuery, useMutation } from '@tanstack/react-query';
import { apiFetch, ApiError } from './client';
import { readSseFrames } from './readSse';
import type { TraceEvent } from '@veridical/schema';
import type { AgentSpec } from '@veridical/spec/schema';
import type {
  SessionSummary,
  SessionEvents,
  ReplayResponse,
  CompareResponse,
  EvalResponse,
  RunResponse,
  TurnFrame,
  TurnRequestBody,
  AgentSummary,
  AgentDraft,
  InvocationResponse,
} from './types';

const canUseResearchFallback = (error: unknown) =>
  error instanceof ApiError && (error.status === 404 || error.status === 405);

export const useAgents = () =>
  useQuery({
    queryKey: ['agents'],
    queryFn: async () => {
      try {
        return await apiFetch<AgentSummary[]>('/v1/agents');
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<AgentSummary[]>('/api/agents');
      }
    },
  });
export const useAgent = (id: string) =>
  useQuery({
    queryKey: ['agent', id],
    queryFn: async () => {
      try {
        return await apiFetch<AgentSummary>(`/v1/agents/${encodeURIComponent(id)}`);
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<AgentSummary>(`/api/agents/${id}`);
      }
    },
    enabled: !!id,
  });
export const useCreateAgent = () =>
  useMutation({
    mutationFn: (body: { name: string; description: string; model: string }) =>
      apiFetch<AgentSummary>('/api/agents', { method: 'POST', body: JSON.stringify(body) }),
  });
export const useAgentTasks = (id: string) =>
  useQuery({
    queryKey: ['agent-tasks', id],
    queryFn: async () => {
      try {
        return await apiFetch<SessionSummary[]>(`/v1/agents/${encodeURIComponent(id)}/tasks`);
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<SessionSummary[]>(`/api/agents/${id}/tasks`);
      }
    },
    enabled: !!id,
  });
export const useAgentDraft = (id: string) =>
  useQuery({
    queryKey: ['agent-draft', id],
    queryFn: () => apiFetch<AgentDraft>(`/api/agents/${id}/draft`),
    enabled: !!id,
    retry: false,
  });
export const useSaveAgentDraft = (id: string) =>
  useMutation({
    mutationFn: (body: { graph: unknown; yaml?: string }) =>
      apiFetch<AgentDraft>(`/api/agents/${id}/draft`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
  });
export const usePublishAgent = (id: string) =>
  useMutation({
    mutationFn: (body: { graph: unknown; yaml: string }) =>
      apiFetch<unknown>(`/api/agents/${id}/publish`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
export const useInvocations = (id: string) =>
  useQuery({
    queryKey: ['invocations', id],
    queryFn: () => apiFetch<InvocationResponse>(`/api/tasks/${id}/invocations`),
    enabled: !!id,
  });
export const useModelProfile = () =>
  useQuery({
    queryKey: ['model-profile'],
    queryFn: () =>
      apiFetch<{ configured: boolean; provider?: string; model?: string; base_url?: string }>(
        '/api/model-profile',
      ),
    staleTime: 60_000,
  });
export interface ModelSummary {
  id: string;
  provider: string;
  model: string;
  status: string;
}
const productionCapabilities = async () =>
  apiFetch<{
    models: Array<{ provider: string; model: string; version?: string; configured?: boolean }>;
    tools: Array<Record<string, any>>;
    skills: Array<Record<string, any>>;
    mcp_servers: Array<Record<string, any>>;
  }>('/v1/capabilities');
export const useModels = () =>
  useQuery({
    queryKey: ['models'],
    queryFn: async () => {
      try {
        const value = await productionCapabilities();
        return value.models.map((item) => ({
          id: `${item.provider}:${item.model}`,
          provider: item.provider,
          model: item.model,
          status: item.configured === false ? 'unavailable' : 'configured',
        }));
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<ModelSummary[]>('/api/models');
      }
    },
    staleTime: 60_000,
  });
export const useCredentialStatus = () =>
  useQuery({
    queryKey: ['credential-status'],
    queryFn: () =>
      apiFetch<{
        provider: { configured: boolean; provider?: string; model?: string; error?: string };
      }>('/api/credentials/status'),
    staleTime: 60_000,
  });
export const useDuplicateAgent = () =>
  useMutation({
    mutationFn: (id: string) =>
      apiFetch<AgentSummary>(`/api/agents/${id}/duplicate`, { method: 'POST' }),
  });
export const useArchiveAgent = () =>
  useMutation({
    mutationFn: (id: string) =>
      apiFetch<AgentSummary>(`/api/agents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'archived' }),
      }),
  });

export const useSessions = () =>
  useQuery({ queryKey: ['sessions'], queryFn: () => apiFetch<SessionSummary[]>('/api/sessions') });
export const useSession = (id: string) =>
  useQuery({
    queryKey: ['session', id],
    queryFn: () => apiFetch<SessionEvents>(`/api/sessions/${id}`),
    enabled: !!id,
  });
export const useCheckpoints = (id: string) =>
  useQuery({
    queryKey: ['checkpoints', id],
    queryFn: () => apiFetch<TraceEvent[]>(`/api/sessions/${id}/checkpoints`),
    enabled: !!id,
  });
export const useAddSpec = () =>
  useMutation({
    mutationFn: (yaml: string) =>
      apiFetch<unknown>('/api/specs', { method: 'POST', body: JSON.stringify({ yaml }) }),
  });
export const useReplay = (id: string, seq: number) =>
  useQuery({
    queryKey: ['replay', id, seq],
    queryFn: () =>
      apiFetch<ReplayResponse>(`/api/sessions/${id}/replay`, {
        method: 'POST',
        body: JSON.stringify({ targetSeq: seq }),
      }),
    enabled: !!id && seq > 0,
  });
export interface ReplayExecution {
  mode: 'strict' | 'fixture' | 'semantic';
  identical?: boolean;
  degraded?: boolean;
  passed?: boolean;
  differences?: unknown[];
  [key: string]: unknown;
}
export const useReplayExecution = () =>
  useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      apiFetch<ReplayExecution>(`/api/sessions/${id}/replay`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
export const useSpecs = () =>
  useQuery({ queryKey: ['specs'], queryFn: () => apiFetch<AgentSpec[]>('/api/specs'), retry: 1 });
export interface Organization {
  id: string;
  name: string;
  created_at: string;
}
export interface Project {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  created_at: string;
}
export const useOrganizations = () =>
  useQuery({
    queryKey: ['organizations'],
    queryFn: () => apiFetch<Organization[]>('/api/organizations'),
  });
export const useProjects = (organizationId: string) =>
  useQuery({
    queryKey: ['projects', organizationId],
    queryFn: () =>
      apiFetch<Project[]>(`/api/projects?organization_id=${encodeURIComponent(organizationId)}`),
    enabled: !!organizationId,
  });
export interface SkillCatalogItem {
  name: string;
  description: string;
  procedure: string;
  tags: string[];
  source: string;
  key: string;
}
export const useSkills = () =>
  useQuery({
    queryKey: ['skills'],
    queryFn: async () => {
      try {
        const value = await productionCapabilities();
        return value.skills.map((skill) => ({
          name: String(skill.name),
          description: String(skill.description ?? ''),
          procedure: '',
          tags: [],
          source: 'production-registry',
          key: String(skill.id ?? `${skill.name}@${skill.version}`),
        }));
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<SkillCatalogItem[]>('/api/skills');
      }
    },
    retry: 1,
    staleTime: 30_000,
    enabled: import.meta.env.MODE !== 'test',
  });
export interface ToolArtifactSummary {
  id: string;
  name: string;
  version: string;
  source: 'builtin' | 'mcp' | 'custom';
  description: string;
  side_effect: 'none' | 'read' | 'write' | 'destructive';
  status: 'draft' | 'approved' | 'deprecated' | 'revoked';
  implementation_hash: string;
}
export interface McpServerSummary {
  id: string;
  name: string;
  transport: 'streamable-http' | 'stdio';
  url?: string;
  command?: string;
  status: 'draft' | 'approved' | 'deprecated' | 'revoked';
  enabled: boolean;
  discovered_tools: ToolArtifactSummary[];
  discovered_resources: unknown[];
  discovered_prompts: unknown[];
  schema_hash?: string;
  last_error?: string;
  last_checked_at?: string;
}
export const useTools = () =>
  useQuery({
    queryKey: ['tools'],
    queryFn: async () => {
      try {
        const value = await productionCapabilities();
        return value.tools.map((tool) => ({
          id: String(tool.id ?? tool.name),
          name: String(tool.name),
          version: String(tool.version ?? 'unknown'),
          source: (tool.source ?? 'builtin') as ToolArtifactSummary['source'],
          description: String(tool.description ?? ''),
          side_effect: (tool.side_effect ?? 'none') as ToolArtifactSummary['side_effect'],
          status: tool.approved === false ? 'draft' : 'approved',
          implementation_hash: String(tool.implementation_hash ?? ''),
        }));
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<ToolArtifactSummary[]>('/api/tools');
      }
    },
  });
export const useMcpServers = () =>
  useQuery({
    queryKey: ['mcp-servers'],
    queryFn: async () => {
      try {
        const value = await productionCapabilities();
        return value.mcp_servers.map((server) => ({
          id: String(server.id),
          name: String(server.name),
          transport: server.transport as McpServerSummary['transport'],
          url: server.endpoint as string | undefined,
          command: server.command as string | undefined,
          status: 'approved' as const,
          enabled: true,
          discovered_tools: [],
          discovered_resources: [],
          discovered_prompts: [],
          schema_hash: server.schema_hash as string | undefined,
          last_error: undefined,
        }));
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<McpServerSummary[]>('/api/mcp/servers');
      }
    },
  });
export const useCreateMcpServer = () =>
  useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      try {
        return await apiFetch<McpServerSummary>('/v1/mcp/servers', {
          method: 'POST',
          body: JSON.stringify({
            name: body.name,
            version: body.version ?? '1.0.0',
            transport: body.transport,
            endpoint: body.url ?? body.endpoint,
            command: body.command,
            tool_names: body.tool_names ?? [],
          }),
        });
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<McpServerSummary>('/api/mcp/servers', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
    },
  });
export const useDiscoverMcpServer = () =>
  useMutation({
    mutationFn: async (id: string) => {
      try {
        return await apiFetch<McpServerSummary>(`/v1/mcp/servers/${id}/discover`, {
          method: 'POST',
        });
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<McpServerSummary>(`/api/mcp/servers/${id}/discover`, { method: 'POST' });
      }
    },
  });
export interface ApprovalRequest {
  id: string;
  approval_id: string;
  session_id: string;
  tool: string;
  args: unknown;
  side_effect: string;
  expires_at: string;
}
export const useApprovals = () =>
  useQuery({
    queryKey: ['approvals'],
    queryFn: () => apiFetch<ApprovalRequest[]>('/api/approvals'),
    refetchInterval: 1000,
  });
export const useDecideApproval = () =>
  useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'allow' | 'deny' }) =>
      apiFetch(`/api/approvals/${id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      }),
  });
export interface MemoryRecord {
  id: string;
  organization_id: string;
  project_id: string;
  user_id?: string;
  agent_id?: string;
  scope: 'task' | 'project' | 'user' | 'agent';
  kind: string;
  content: unknown;
  summary?: string;
  confidence: number;
  sensitivity: string;
  status: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
}
export const useMemories = (organizationId: string, projectId: string) =>
  useQuery({
    queryKey: ['memories', organizationId, projectId],
    queryFn: () =>
      apiFetch<MemoryRecord[]>(
        `/api/memories?organization_id=${encodeURIComponent(organizationId)}&project_id=${encodeURIComponent(projectId)}`,
      ),
    enabled: !!organizationId && !!projectId,
  });
export const useDecideMemory = () =>
  useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'rejected' }) =>
      apiFetch<MemoryRecord>(`/api/memories/${id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
  });
export const useDeleteMemory = () =>
  useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: boolean }>(`/api/memories/${id}`, { method: 'DELETE' }),
  });
export interface KnowledgeFile {
  id: string;
  organization_id: string;
  project_id: string;
  name: string;
  mime_type: string;
  size: number;
  content_hash: string;
  status: string;
  created_at: string;
}
export const useKnowledgeFiles = (organizationId: string, projectId: string) =>
  useQuery({
    queryKey: ['knowledge-files', organizationId, projectId],
    queryFn: () =>
      apiFetch<KnowledgeFile[]>(
        `/v1/knowledge/files?project_id=${encodeURIComponent(projectId)}`,
      ).catch((error) => {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<KnowledgeFile[]>(
          `/api/knowledge/files?organization_id=${encodeURIComponent(organizationId)}&project_id=${encodeURIComponent(projectId)}`,
        );
      }),
    enabled: !!organizationId && !!projectId,
  });
export interface KnowledgeBackendSummary {
  id: string;
  name: string;
  type: 'native' | 'gbrain' | 'hybrid';
  status: string;
  capabilities: string[];
}
export const useKnowledgeBackends = () =>
  useQuery({
    queryKey: ['knowledge-backends'],
    queryFn: () =>
      apiFetch<KnowledgeBackendSummary[]>('/v1/knowledge/backends').catch((error) => {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<KnowledgeBackendSummary[]>('/api/knowledge/backends');
      }),
    staleTime: 30_000,
  });
export const useRun = () =>
  useMutation({
    mutationFn: (body: unknown) =>
      apiFetch<RunResponse>('/api/run', { method: 'POST', body: JSON.stringify(body) }),
  });
export const useCompare = () =>
  useMutation({
    mutationFn: (body: { a: string; b: string }) =>
      apiFetch<CompareResponse>('/api/compare', { method: 'POST', body: JSON.stringify(body) }),
  });
export const useEvaluate = () =>
  useMutation({
    mutationFn: (body: { sessionId: string }) =>
      apiFetch<EvalResponse>('/api/evaluate', { method: 'POST', body: JSON.stringify(body) }),
  });

export const useStartTurn = () => {
  const run = async (body: TurnRequestBody, onFrame: (f: TurnFrame) => void) => {
    const requestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    } satisfies RequestInit;
    const legacy = await fetch('/api/run/turn', requestInit);
    if (legacy.ok) {
      await readSseFrames(legacy, onFrame);
      return;
    }
    if (![404, 405].includes(legacy.status)) {
      const err = await legacy.json().catch(() => ({}));
      throw new Error(err?.error?.message ?? legacy.statusText);
    }
    const productionPath = body.conversationId
      ? `/v1/tasks/${encodeURIComponent(body.conversationId)}/turns`
      : `/v1/agents/${encodeURIComponent(body.specName)}/tasks`;
    const productionBody = body.conversationId
      ? { prompt: body.prompt }
      : { prompt: body.prompt, project_id: (body as any).project_id };
    const created = await fetch(productionPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(productionBody),
    });
    if (!created.ok) {
      const err = await created.json().catch(() => ({}));
      throw new Error(err?.error?.message ?? created.statusText);
    }
    const job = (await created.json()) as { id: string; session?: string };
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const status = await apiFetch<{ state: string; session?: string; result?: unknown }>(
        `/v1/jobs/${encodeURIComponent(job.id)}`,
      );
      if (status.state === 'queued' || status.state === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const sessionId = status.session ?? job.session;
      if (!sessionId) throw new Error('生产任务未返回 session');
      const events = await apiFetch<TraceEvent[]>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      );
      for (const event of events) onFrame({ type: 'event', event });
      if (status.state !== 'completed') {
        onFrame({
          type: 'error',
          message: String((status.result as any)?.code ?? status.state),
          session_id: sessionId,
        });
      } else {
        onFrame({
          type: 'done',
          session_id: sessionId,
          event_count: events.length,
          outcome: status.result,
        });
      }
      return;
    }
    throw new Error('生产任务等待超时');
  };
  return { run };
};
