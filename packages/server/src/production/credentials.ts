export type CredentialSource =
  | { kind: 'env'; name: string }
  | { kind: 'vault'; address: string; tokenEnv: string; path: string; field: string };

export async function resolveCredential(
  source: CredentialSource,
  timeoutMs = 1500,
): Promise<string> {
  if (source.kind === 'env') {
    const value = process.env[source.name];
    if (!value) throw new Error(`credential_missing:${source.name}`);
    return value;
  }
  const token = process.env[source.tokenEnv];
  if (!token) throw new Error(`vault_token_missing:${source.tokenEnv}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${source.address.replace(/\/$/, '')}/v1/${source.path.replace(/^\//, '')}`,
      {
        headers: { 'X-Vault-Token': token, accept: 'application/json' },
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`vault_http_${response.status}`);
    const body = (await response.json()) as {
      data?: { data?: Record<string, unknown>; [key: string]: unknown };
    };
    const value = body.data?.data?.[source.field] ?? body.data?.[source.field];
    if (typeof value !== 'string' || !value) throw new Error('vault_field_missing');
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('vault_')) throw error;
    throw new Error(
      error instanceof Error && error.name === 'AbortError' ? 'vault_timeout' : 'vault_unavailable',
    );
  } finally {
    clearTimeout(timer);
  }
}
