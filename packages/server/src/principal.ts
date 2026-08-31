import type { FastifyRequest } from 'fastify';

/** Local-mode principal. Production authentication is enforced by production/app.ts. */
export function tenantId(request: FastifyRequest): string {
  const value = request.headers['x-tenant-id'];
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : 'local';
}

export function actorId(request: FastifyRequest): string {
  const value = request.headers['x-actor-id'];
  return typeof value === 'string' && /^[A-Za-z0-9_.@:-]{1,128}$/.test(value) ? value : 'local-user';
}
