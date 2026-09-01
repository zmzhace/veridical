import { createHash } from 'node:crypto';

export type OutputProfileKind = 'conversational' | 'structured' | 'report' | 'artifact';

export interface OutputProfile {
  id: string;
  version: string;
  kind: OutputProfileKind;
  message_format?: 'markdown' | 'text';
  schema?: unknown;
  schema_hash?: string;
  strict?: boolean;
  repair_attempts?: number;
  artifact_mime_type?: string;
}

export interface AgentOutput {
  message?: { format: 'markdown' | 'text'; content: string };
  result?: { format: 'json'; schema_hash: string; data: unknown };
  artifacts?: Array<{ id: string; name: string; mime_type: string }>;
  validation?: { valid: boolean; errors: string[]; repaired: boolean };
}

export interface OutputValidation {
  valid: boolean;
  errors: string[];
}

export class OutputFormatError extends Error {
  readonly code = 'OUTPUT_SCHEMA_MISMATCH';
  constructor(message: string, readonly validation: OutputValidation) { super(message); }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validate(value: unknown, schema: any, path: string, errors: string[]): void {
  if (!schema || typeof schema !== 'object') return;
  if (schema.enum && !schema.enum.some((candidate: unknown) => JSON.stringify(candidate) === JSON.stringify(value))) errors.push(`${path}: must be one of enum values`);
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path}: must equal const`);
  const expectedTypes: string[] = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (expectedTypes.length && !expectedTypes.includes(typeOf(value))) errors.push(`${path}: expected ${expectedTypes.join('|')}, received ${typeOf(value)}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: maxLength ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern mismatch`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: maximum ${schema.maximum}`);
    if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${path}: expected integer`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: maxItems ${schema.maxItems}`);
    if (schema.items) value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) if (!(required in value)) errors.push(`${path}.${required}: required`);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (properties[key]) validate(item, properties[key], `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional property`);
    }
  }
}

export function validateOutput(value: unknown, schema: unknown): OutputValidation {
  const errors: string[] = [];
  validate(value, schema, '$', errors);
  return { valid: errors.length === 0, errors };
}

export function outputSchemaHash(schema: unknown): string {
  return createHash('sha256').update(JSON.stringify(schema, Object.keys(schema as any ?? {}).sort())).digest('hex');
}

export async function finalizeOutput(input: {
  content: unknown;
  profile: OutputProfile;
  repair?: (content: unknown, validation: OutputValidation) => Promise<unknown>;
  artifacts?: AgentOutput['artifacts'];
}): Promise<AgentOutput> {
  const { content, profile } = input;
  if (profile.kind === 'conversational' || profile.kind === 'report') {
    return { message: { format: profile.message_format ?? 'markdown', content: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }, artifacts: input.artifacts, validation: { valid: true, errors: [], repaired: false } };
  }
  let data = content;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); }
    catch { data = undefined; }
  }
  const schema_hash = profile.schema_hash ?? outputSchemaHash(profile.schema ?? {});
  let validation = validateOutput(data, profile.schema ?? {});
  let repaired = false;
  if (!validation.valid && input.repair && (profile.repair_attempts ?? 1) > 0) {
    data = await input.repair(content, validation);
    validation = validateOutput(data, profile.schema ?? {});
    repaired = true;
  }
  if (!validation.valid && profile.strict !== false) throw new OutputFormatError('Final output did not satisfy the approved schema', validation);
  return { result: { format: 'json', schema_hash, data }, artifacts: input.artifacts, validation: { ...validation, repaired } };
}
