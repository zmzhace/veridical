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
    mutationFn: async (body: { name: string; description: string; model: string }) => {
      try {
        return await apiFetch<AgentSummary>('/v1/agents', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<AgentSummary>('/api/agents', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
    },
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
export const useAgentManifest = (id: string) =>
  useQuery({
    queryKey: ['agent-manifest', id],
    queryFn: async () => {
      try {
        return await apiFetch<Record<string, unknown>>(
          `/v1/agents/${encodeURIComponent(id)}/manifest`,
        );
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        throw error;
      }
    },
    enabled: !!id,
    retry: false,
  });
export const useAgentDraft = (id: string) =>
  useQuery({
    queryKey: ['agent-draft', id],
    queryFn: async () => {
      try {
        return await apiFetch<AgentDraft>(`/v1/agents/${encodeURIComponent(id)}/draft`);
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<AgentDraft>(`/api/agents/${id}/draft`);
      }
    },
    enabled: !!id,
    retry: false,
  });
export const useSaveAgentDraft = (id: string) =>
  useMutation({
    mutationFn: (body: { graph: unknown; yaml?: string }) =>
      apiFetch<AgentDraft>(`/v1/agents/${encodeURIComponent(id)}/draft`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }).catch((error) => {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<AgentDraft>(`/api/agents/${id}/draft`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      }),
  });
export const usePublishAgent = (id: string) =>
  useMutation({
    mutationFn: (body: { graph: unknown; yaml: string }) =>
      apiFetch<unknown>(`/v1/agents/${encodeURIComponent(id)}/publish`, {
        method: 'POST',
        body: JSON.stringify(body),
      }).catch((error) => {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<unknown>(`/api/agents/${id}/publish`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }),
  });
export const useInvocations = (id: string) =>
  useQuery({
    queryKey: ['invocations', id],
    queryFn: async () => {
      try {
        return await apiFetch<InvocationResponse>(
          `/v1/tasks/${encodeURIComponent(id)}/invocations`,
        );
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<InvocationResponse>(`/api/tasks/${id}/invocations`);
      }
    },
    enabled: !!id,
  });
export const useModelProfile = () =>
  useQuery({
    queryKey: ['model-profile'],
    queryFn: async () => {
      try {
        return await apiFetch<{
          configured: boolean;
          provider?: string;
          model?: string;
          base_url?: string;
        }>('/v1/model-profile');
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<{
          configured: boolean;
          provider?: string;
          model?: string;
          base_url?: string;
        }>('/api/model-profile');
      }
    },
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
    queryFn: async () => {
      try {
        return await apiFetch<{
          provider: { configured: boolean; provider?: string; model?: string; error?: string };
        }>('/v1/credentials/status');
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<{
          provider: { configured: boolean; provider?: string; model?: string; error?: string };
        }>('/api/credentials/status');
      }
    },
    staleTime: 60_000,
  });
export const useDuplicateAgent = () =>
  useMutation({
    mutationFn: async (id: string) => {
      try {
        return await apiFetch<AgentSummary>(`/v1/agents/${encodeURIComponent(id)}/duplicate`, {
          method: 'POST',
        });
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<AgentSummary>(`/api/agents/${id}/duplicate`, { method: 'POST' });
      }
    },
  });
export const useArchiveAgent = () =>
  useMutation({
    mutationFn: async (id: string) => {
      try {
        return await apiFetch<AgentSummary>(`/v1/agents/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'archived' }),
        });
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<AgentSummary>(`/api/agents/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'archived' }),
        });
      }
    },
  });

export const useSessions = () =>
  useQuery({
    queryKey: ['sessions'],
    queryFn: async () => {
      try {
        const sessions =
          await apiFetch<Array<{ id: string; ref?: string; seq?: number; created?: string }>>(
            '/v1/sessions',
          );
        // Keep compatibility with research mocks and older gateways that already
        // return the UI summary shape from the production path.
        if (sessions.some((session) => !(session as any).id && (session as any).session_id))
          return sessions as unknown as SessionSummary[];
        return sessions.map<SessionSummary>((session) => ({
          session_id: session.id,
          spec_name: session.ref?.split('@')[0],
          spec_version: session.ref?.split('@')[1] ?? '',
          event_count: session.seq ?? 0,
          total_duration_ms: 0,
          first_seq: session.seq ? 1 : 0,
          last_seq: session.seq ?? 0,
        }));
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<SessionSummary[]>('/api/sessions');
      }
    },
  });
export const useSession = (id: string) =>
  useQuery({
    queryKey: ['session', id],
    queryFn: async () => {
      try {
        return await apiFetch<SessionEvents>(`/v1/tasks/${encodeURIComponent(id)}/events`);
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<SessionEvents>(`/api/sessions/${id}`);
      }
    },
    enabled: !!id,
  });
export const useCheckpoints = (id: string) =>
  useQuery({
    queryKey: ['checkpoints', id],
    queryFn: async () => {
      try {
        const events = await apiFetch<TraceEvent[]>(`/v1/tasks/${encodeURIComponent(id)}/events`);
        return events.filter((event) => event.type === 'checkpoint');
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<TraceEvent[]>(`/api/sessions/${id}/checkpoints`);
      }
    },
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
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) => {
      try {
        const created = await apiFetch<{ id: string; state: string; result?: unknown }>(
          '/v1/replay',
          {
            method: 'POST',
            headers: { 'idempotency-key': `replay-${crypto.randomUUID()}` },
            body: JSON.stringify({ session: id, ...body, mode: body.mode ?? 'strict' }),
          },
        );
        for (let attempt = 0; attempt < 600; attempt += 1) {
          const job = await apiFetch<{ state: string; result?: unknown }>(
            `/v1/jobs/${encodeURIComponent(created.id)}`,
          );
          if (job.state === 'queued' || job.state === 'running') {
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          if (job.state !== 'completed')
            throw new Error(String((job.result as any)?.code ?? job.state));
          return (job.result ?? { mode: body.mode ?? 'strict' }) as ReplayExecution;
        }
        throw new Error('回放等待超时');
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<ReplayExecution>(`/api/sessions/${id}/replay`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
    },
  });
export const useSpecs = () =>
  useQuery({
    queryKey: ['specs'],
    queryFn: async () => {
      try {
        const artifacts = await apiFetch<Array<{ body?: AgentSpec }>>('/v1/specs');
        return artifacts.map((artifact) => artifact.body ?? (artifact as unknown as AgentSpec));
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<AgentSpec[]>('/api/specs');
      }
    },
    retry: 1,
  });
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
  id?: string;
  name: string;
  description: string;
  procedure: string;
  tags: string[];
  source: string;
  key: string;
  version?: string;
  status?: 'draft' | 'approved' | 'deprecated';
  content_hash?: string;
  tool_dependencies?: string[];
}
export const useSkills = () =>
  useQuery({
    queryKey: ['skills'],
    queryFn: async () => {
      try {
        const value = await apiFetch<Array<Record<string, any>>>('/v1/skills');
        return value.map((skill) => ({
          id: String(skill.id ?? `${skill.name}@${skill.version}`),
          name: String(skill.name),
          description: String(skill.description ?? ''),
          procedure: String(skill.content ?? skill.procedure ?? ''),
          tags: Array.isArray(skill.tags) ? skill.tags.map(String) : [],
          source: String(skill.source ?? 'production-registry'),
          key: String(skill.id ?? `${skill.name}@${skill.version}`),
          version: String(skill.version ?? 'unknown'),
          status: (skill.status ?? 'draft') as SkillCatalogItem['status'],
          content_hash: String(skill.content_hash ?? ''),
          tool_dependencies: Array.isArray(skill.tool_dependencies)
            ? skill.tool_dependencies.map(String)
            : [],
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
  display_name?: string;
  tags?: string[];
  input_schema?: unknown;
  output_schema?: unknown;
  network_scope?: string[];
  used_by_count?: number;
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
  version?: string;
  artifact_hash?: string;
  health?: 'healthy' | 'degraded' | 'offline';
}
export const useTools = () =>
  useQuery({
    queryKey: ['tools'],
    queryFn: async () => {
      try {
        const value = await apiFetch<Array<Record<string, any>>>('/v1/tools');
        return value.map((tool) => ({
          id: String(tool.id ?? tool.name),
          name: String(tool.name),
          version: String(tool.version ?? 'unknown'),
          source: (tool.source ?? 'builtin') as ToolArtifactSummary['source'],
          description: String(tool.description ?? ''),
          side_effect: (tool.side_effect ?? 'none') as ToolArtifactSummary['side_effect'],
          status: (tool.status ??
            (tool.approved === false ? 'draft' : 'approved')) as ToolArtifactSummary['status'],
          implementation_hash: String(tool.implementation_hash ?? ''),
          display_name: String(tool.display_name ?? tool.name),
          tags: Array.isArray(tool.tags) ? tool.tags.map(String) : [],
          input_schema: tool.input_schema,
          output_schema: tool.output_schema,
          network_scope: Array.isArray(tool.network_scope) ? tool.network_scope.map(String) : [],
          used_by_count: Number(tool.used_by_count ?? 0),
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
        const value = await apiFetch<Array<Record<string, any>>>('/v1/mcp/servers');
        return value.map((server) => ({
          id: String(server.id),
          name: String(server.name),
          transport: server.transport as McpServerSummary['transport'],
          url: (server.endpoint ?? server.url) as string | undefined,
          command: server.command as string | undefined,
          status: (server.status ?? 'draft') as McpServerSummary['status'],
          enabled: server.enabled !== false,
          discovered_tools: Array.isArray(server.discovered_tools) ? server.discovered_tools : [],
          discovered_resources: Array.isArray(server.discovered_resources)
            ? server.discovered_resources
            : [],
          discovered_prompts: Array.isArray(server.discovered_prompts)
            ? server.discovered_prompts
            : [],
          schema_hash: server.schema_hash as string | undefined,
          last_error: server.last_error as string | undefined,
          last_checked_at: server.last_checked_at as string | undefined,
          version: server.version as string | undefined,
          artifact_hash: server.artifact_hash as string | undefined,
          health: (server.health ??
            (server.last_error ? 'degraded' : 'healthy')) as McpServerSummary['health'],
        }));
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<McpServerSummary[]>('/api/mcp/servers');
      }
    },
  });
export interface CapabilitySummary {
  id: string;
  kind: 'tool' | 'mcp' | 'skill' | 'memory' | 'knowledge';
  display_name: string;
  summary: string;
  source: string;
  version: string;
  status: 'draft' | 'approved' | 'deprecated' | 'revoked' | 'unavailable';
  risk: 'none' | 'read' | 'write' | 'destructive';
  health?: 'healthy' | 'degraded' | 'offline';
  tags: string[];
  used_by_count: number;
  updated_at: string;
  content_hash?: string;
  tool_dependencies?: string[];
  discovered_count?: number;
  selected_children?: string[];
}
export interface CapabilityCatalogResponse {
  items: CapabilitySummary[];
  next_cursor?: string;
  total: number;
}
export const useCapabilityCatalog = (
  filters: {
    kind?: CapabilitySummary['kind'];
    query?: string;
    status?: CapabilitySummary['status'];
    risk?: CapabilitySummary['risk'];
    limit?: number;
  } = {},
) =>
  useQuery({
    queryKey: ['capability-catalog', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.kind) params.set('kind', filters.kind);
      if (filters.query) params.set('query', filters.query);
      if (filters.status) params.set('status', filters.status);
      if (filters.risk) params.set('risk', filters.risk);
      params.set('limit', String(filters.limit ?? 100));
      try {
        return await apiFetch<CapabilityCatalogResponse>(`/v1/capability-catalog?${params}`);
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        const [tools, skills, mcp] = await Promise.all([
          apiFetch<ToolArtifactSummary[]>('/api/tools'),
          apiFetch<SkillCatalogItem[]>('/api/skills'),
          apiFetch<McpServerSummary[]>('/api/mcp/servers'),
        ]);
        const items: CapabilitySummary[] = [
          ...tools.map((tool) => ({
            id: tool.id,
            kind: 'tool' as const,
            display_name: tool.display_name ?? tool.name,
            summary: tool.description,
            source: tool.source,
            version: tool.version,
            status: tool.status,
            risk: tool.side_effect,
            health: tool.status === 'revoked' ? ('offline' as const) : ('healthy' as const),
            tags: tool.tags ?? [],
            used_by_count: tool.used_by_count ?? 0,
            updated_at: '',
            content_hash: tool.implementation_hash,
          })),
          ...skills.map((skill) => ({
            id: skill.key,
            kind: 'skill' as const,
            display_name: skill.name,
            summary: skill.description,
            source: skill.source,
            version: skill.version ?? 'unknown',
            status: (skill.status ?? 'draft') as CapabilitySummary['status'],
            risk: 'none' as const,
            health: 'healthy' as const,
            tags: skill.tags,
            used_by_count: 0,
            updated_at: '',
            content_hash: skill.content_hash,
            tool_dependencies: skill.tool_dependencies ?? [],
          })),
          ...mcp.map((server) => ({
            id: server.id,
            kind: 'mcp' as const,
            display_name: server.name,
            summary: `${server.discovered_tools.length} 个已发现工具`,
            source: server.transport,
            version: server.version ?? 'unknown',
            status: server.status,
            risk: 'read' as const,
            health: server.health ?? 'healthy',
            tags: ['MCP'],
            used_by_count: 0,
            updated_at: server.last_checked_at ?? '',
            content_hash: server.artifact_hash,
            discovered_count: server.discovered_tools.length,
            selected_children: server.discovered_tools.map((tool) => tool.name),
          })),
        ]
          .filter((item) => !filters.kind || item.kind === filters.kind)
          .filter((item) => !filters.status || item.status === filters.status)
          .filter((item) => !filters.risk || item.risk === filters.risk)
          .filter(
            (item) =>
              !filters.query ||
              `${item.display_name} ${item.summary} ${item.tags.join(' ')}`
                .toLocaleLowerCase()
                .includes(filters.query.toLocaleLowerCase()),
          );
        return { items, total: items.length };
      }
    },
  });
export const useCapabilityDetail = (capability?: CapabilitySummary | null) =>
  useQuery({
    queryKey: ['capability-detail', capability?.kind, capability?.id],
    queryFn: async () => {
      if (!capability) return undefined;
      const id = encodeURIComponent(capability.id);
      if (capability.kind === 'tool') return apiFetch<Record<string, any>>(`/v1/tools/${id}`);
      if (capability.kind === 'skill') return apiFetch<Record<string, any>>(`/v1/skills/${id}`);
      if (capability.kind === 'mcp') return apiFetch<Record<string, any>>(`/v1/mcp/servers/${id}`);
      return undefined;
    },
    enabled: Boolean(capability && ['tool', 'skill', 'mcp'].includes(capability.kind)),
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
export const useCreateToolDraft = () =>
  useMutation({
    mutationFn: async (body: {
      name: string;
      display_name?: string;
      description: string;
      side_effect: ToolArtifactSummary['side_effect'];
    }) => {
      try {
        return await apiFetch<ToolArtifactSummary>('/v1/tools/drafts', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<ToolArtifactSummary>('/api/tools', {
          method: 'POST',
          body: JSON.stringify({ ...body, status: 'draft', source: 'custom' }),
        });
      }
    },
  });
export const useCreateSkillDraft = () =>
  useMutation({
    mutationFn: async (body: {
      name: string;
      version: string;
      description: string;
      content: string;
      tool_dependencies: string[];
    }) => {
      try {
        return await apiFetch<SkillCatalogItem>('/v1/skills', {
          method: 'POST',
          body: JSON.stringify({ ...body, source: 'studio' }),
        });
      } catch (error) {
        if (!canUseResearchFallback(error)) throw error;
        return apiFetch<SkillCatalogItem>('/api/skills', {
          method: 'POST',
          body: JSON.stringify({
            ...body,
            procedure: body.content,
            source: 'studio',
            status: 'draft',
          }),
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
    queryFn: async () => {
      const response = await apiFetch<KnowledgeBackendSummary[]>('/v1/knowledge/backends').catch(
        (error) => {
          if (!canUseResearchFallback(error)) throw error;
          return apiFetch<KnowledgeBackendSummary[]>('/api/knowledge/backends');
        },
      );
      // Older native backends do not expose capabilities; keep the UI total
      // and avoid turning a missing optional field into a route-level crash.
      return response.map((backend) => ({
        ...backend,
        capabilities: Array.isArray(backend.capabilities) ? backend.capabilities : [],
      }));
    },
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
