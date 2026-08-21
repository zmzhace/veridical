import { describe, it, expect } from 'vitest';
import { ToolBroker, type ToolDef, type ApprovalPolicy } from '../src/index';

function echoTool(): ToolDef {
  return { id: 'echo', name: 'echo', description: 'echo args', deterministic: true, execute: async (a) => a };
}

function allowAll(): ApprovalPolicy {
  return { decide: async () => 'allow' };
}

describe('ToolBroker', () => {
  it('executes an allowed tool', async () => {
    const broker = new ToolBroker([echoTool()], allowAll());
    const r = await broker.call('echo', { a: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toEqual({ a: 1 });
  });

  it('denies when policy denies', async () => {
    const deny: ApprovalPolicy = { decide: async () => 'deny' };
    const broker = new ToolBroker([echoTool()], deny);
    const r = await broker.call('echo', { a: 1 });
    expect(r).toEqual({ ok: false, reason: 'denied' });
  });

  it('returns not_found for unknown tool', async () => {
    const broker = new ToolBroker([echoTool()], allowAll());
    expect(await broker.call('nope', {})).toEqual({ ok: false, reason: 'not_found' });
  });

  it('propagates execution errors', async () => {
    const boom: ToolDef = { id: 'b', name: 'b', description: '', deterministic: true, execute: async () => { throw new Error('boom'); } };
    const broker = new ToolBroker([boom], allowAll());
    const r = await broker.call('b', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('error');
  });
});
