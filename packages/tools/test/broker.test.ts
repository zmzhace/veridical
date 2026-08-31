import { describe, it, expect } from 'vitest';
import { ToolBroker, type ToolDef, type ApprovalPolicy } from '../src/index';

function echoTool(): ToolDef {
  return { id: 'echo', name: 'echo', description: 'echo args', deterministic: true, execute: async (a) => a };
}

function allowAll(): ApprovalPolicy {
  return { decide: async () => 'allow' };
}

describe('ToolBroker', () => {
  it('exposes a structured observation without changing the legacy call contract', async () => {
    const broker = new ToolBroker([echoTool()], allowAll());
    const observed = await broker.callObserved('echo', { a: 1 });
    expect(observed).toMatchObject({ ok: true, observation: { status: 'success', metadata: { truncated: false } } });
    expect(await broker.call('echo', { a: 1 })).toEqual({ ok: true, result: { a: 1 } });
  });
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

  it('rejects when guard returns false', async () => {
    const guarded: ToolDef = { ...echoTool(), name: 'g', guard: async () => false };
    const broker = new ToolBroker([guarded], allowAll());
    const r = await broker.call('g', {});
    expect(r).toEqual({ ok: false, reason: 'denied' });
  });

  it('executes normally when guard allows', async () => {
    const guarded: ToolDef = { ...echoTool(), name: 'g2', guard: async () => true };
    const broker = new ToolBroker([guarded], allowAll());
    const r = await broker.call('g2', { a: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toEqual({ a: 1 });
  });

  it('returns verify_failed with result when verify blocks', async () => {
    const verified: ToolDef = { ...echoTool(), name: 'v', verify: async () => false };
    const broker = new ToolBroker([verified], allowAll());
    const r = await broker.call('v', { a: 1 });
    expect(r).toEqual({ ok: false, reason: 'verify_failed', result: { a: 1 } });
  });

  it('returns ok result when verify passes', async () => {
    const verified: ToolDef = { ...echoTool(), name: 'v2', verify: async () => true };
    const broker = new ToolBroker([verified], allowAll());
    const r = await broker.call('v2', { a: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toEqual({ a: 1 });
  });

  it('executes when ask and onAsk returns true', async () => {
    const ask: ApprovalPolicy = { decide: async () => 'ask', onAsk: async () => true };
    const broker = new ToolBroker([echoTool()], ask);
    const r = await broker.call('echo', { a: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toEqual({ a: 1 });
  });

  it('denies when ask and onAsk returns false', async () => {
    const ask: ApprovalPolicy = { decide: async () => 'ask', onAsk: async () => false };
    const broker = new ToolBroker([echoTool()], ask);
    const r = await broker.call('echo', { a: 1 });
    expect(r).toEqual({ ok: false, reason: 'denied' });
  });

  it('denies when ask and no onAsk', async () => {
    const ask: ApprovalPolicy = { decide: async () => 'ask' };
    const broker = new ToolBroker([echoTool()], ask);
    const r = await broker.call('echo', { a: 1 });
    expect(r).toEqual({ ok: false, reason: 'denied' });
  });
});
