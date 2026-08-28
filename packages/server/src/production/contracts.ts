import { z } from 'zod';
import { createHash } from 'node:crypto';

export const Key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/);
export const Roles = z.enum(['viewer', 'operator', 'developer', 'reviewer', 'publisher', 'admin']);
export type Role = z.infer<typeof Roles>;
export interface Principal {
  tenant: string;
  actor: string;
  roles: Role[];
  tokenHash: string;
}
export class Fault extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
export const requireRole = (p: Principal, ...roles: Role[]) => {
  if (!p.roles.includes('admin') && !roles.some((r) => p.roles.includes(r)))
    throw new Fault(403, 'forbidden');
};
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v ?? null)).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
export const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');
export const SuiteSchema = z
  .object({
    name: Key,
    cases: z
      .array(
        z
          .object({
            input: z.string().min(1).max(8000),
            contains: z.array(z.string().min(1).max(1000)).max(20).default([]),
            excludes: z.array(z.string().min(1).max(1000)).max(20).default([]),
            requiredTools: z.array(Key).max(10).default([]),
          })
          .strict()
          .refine(
            (c) => c.contains.length + c.requiredTools.length > 0,
            'each case needs a positive assertion',
          ),
      )
      .min(3)
      .max(30)
      .refine(
        (cases) => new Set(cases.map((c) => c.input)).size === cases.length,
        'case inputs must be distinct',
      ),
  })
  .strict();
export type Suite = z.infer<typeof SuiteSchema>;
export interface Artifact<T = any> {
  key: string;
  body: T;
  digest: string;
  author: string;
  status: string;
  meta: any;
  created: string;
}
export type JobKind = 'run' | 'evaluate' | 'improve' | 'replay';
export interface Job {
  id: string;
  tenant: string;
  actor: string;
  session: string;
  kind: JobKind;
  state: string;
  owner: string | null;
  deadline: number | null;
  lease_until: number | null;
  args: any;
  result: any;
  created: number;
}
