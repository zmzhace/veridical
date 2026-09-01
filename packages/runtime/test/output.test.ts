import { describe, expect, it } from 'vitest';
import { OutputFormatError, finalizeOutput, outputSchemaHash, validateOutput } from '../src/output.js';

const schema = { type: 'object', required: ['summary', 'items'], additionalProperties: false, properties: { summary: { type: 'string', minLength: 1 }, items: { type: 'array', items: { type: 'string' } } } };

describe('OutputFinalizer', () => {
  it('keeps conversational output human-readable and separate from decisions', async () => {
    const result = await finalizeOutput({ content: '## 完成\n已通过。', profile: { id: 'chat', version: '1', kind: 'conversational' } });
    expect(result.message?.content).toContain('完成');
    expect(result.result).toBeUndefined();
  });

  it('parses and validates structured output with a stable schema hash', async () => {
    const result = await finalizeOutput({ content: JSON.stringify({ summary: 'ok', items: ['a'] }), profile: { id: 'report', version: '1', kind: 'structured', schema } });
    expect(result.result?.schema_hash).toBe(outputSchemaHash(schema));
    expect(result.validation?.valid).toBe(true);
  });

  it('allows one controlled repair and fails closed after it', async () => {
    const repaired = await finalizeOutput({ content: '{"summary":"ok"}', profile: { id: 'report', version: '1', kind: 'structured', schema }, repair: async () => ({ summary: 'ok', items: [] }) });
    expect(repaired.validation).toMatchObject({ valid: true, repaired: true });
    await expect(finalizeOutput({ content: '{}', profile: { id: 'report', version: '1', kind: 'structured', schema } })).rejects.toBeInstanceOf(OutputFormatError);
  });

  it('reports schema errors without throwing in non-strict mode', () => {
    expect(validateOutput({ summary: 1 }, schema).errors).toContain('$.summary: expected string, received number');
  });
});
