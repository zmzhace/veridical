export type MemoryScope = 'working' | 'semantic' | 'skill';

export type MemoryEventPayload =
  | { action: 'write'; key: string; value: unknown; scope: MemoryScope; tags?: string[] }
  | { action: 'read'; key: string; scope: MemoryScope }
  | { action: 'recall'; query: string; scope: 'semantic' | 'skill'; hits: { key: string }[] };
