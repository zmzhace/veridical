import type { TraceStore } from '@rt/store';
import type { TraceEvent } from '@rt/schema';

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
  tool_calls?: { name: string; args: unknown }[];
}

export async function deriveMessages(store: TraceStore, session_id: string): Promise<ModelMessage[]> {
  const events = await store.readBySession(session_id);
  const out: ModelMessage[] = [];
  for (const evt of events) {
    if (evt.type === 'user.message') {
      out.push({ role: 'user', content: (evt.payload as any).text ?? '' });
    } else if (evt.type === 'assistant.message') {
      out.push({ role: 'assistant', content: (evt.payload as any).text ?? '' });
    } else if (evt.type === 'tool.called') {
      const p = evt.payload as any;
      out.push({ role: 'assistant', content: '', tool_calls: [{ name: p.name, args: p.args }] });
    } else if (evt.type === 'tool.result') {
      const p = evt.payload as any;
      out.push({ role: 'assistant', content: `tool ${p.name} result: ${JSON.stringify(p.result)}` });
    }
  }
  return out;
}
