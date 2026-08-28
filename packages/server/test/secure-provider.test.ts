import { afterEach, expect, test, vi } from 'vitest';
import { SecureProvider, abortable } from '../src/production/runner';
import { ProductionConfigSchema } from '../src/production/config';
const req = {
  provider: 'p',
  model: 'pinned',
  messages: [{ role: 'user', content: 'hello' }],
  maxOutputTokens: 123,
};
const provider = new SecureProvider('https://provider.invalid/v1', 'test-credential', 'pinned');
afterEach(() => vi.unstubAllGlobals());
test('provider uses fixed model, refuses redirects and bounds generated tokens', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'OK' } }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  expect((await provider.complete(req)).text).toBe('OK');
  const [url, options] = fetch.mock.calls[0] as any;
  expect(url).toBe('https://provider.invalid/v1/chat/completions');
  expect(options.redirect).toBe('error');
  expect(JSON.parse(options.body)).toMatchObject({ model: 'pinned', max_tokens: 123 });
  await expect(provider.complete({ ...req, model: 'unapproved' })).rejects.toThrow(
    'model configuration mismatch',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('upstream HTTP errors do not disclose their sensitive response body', async () => {
  vi.stubGlobal('fetch', async () => new Response('credential-leak', { status: 401 }));
  await expect(provider.complete(req)).rejects.toThrow('provider_http_401');
});
test.each([
  [{ choices: [{ message: { content: 'OK' } }] }, 'missing_provider_usage'],
  [
    { choices: [{ message: { content: 42 } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    'invalid_provider_response',
  ],
  [
    {
      choices: [{ message: { content: 'X'.repeat(32001) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    'invalid_provider_response',
  ],
])('provider rejects malformed or unaccounted responses %#', async (data, error) => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(data)));
  await expect(provider.complete(req)).rejects.toThrow(error);
});
test('provider limits bytes before parsing an oversized payload', async () => {
  vi.stubGlobal('fetch', async () => new Response('X'.repeat(262145)));
  await expect(provider.complete(req)).rejects.toThrow('provider_response_too_large');
});
test('abortable handles already-aborted and non-cooperative work', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await expect(
    abortable(Promise.reject(new Error('late failure')), controller.signal),
  ).rejects.toThrow('stop');
  const second = new AbortController();
  const pending = abortable(new Promise(() => {}), second.signal);
  second.abort(new Error('cancel'));
  await expect(pending).rejects.toThrow('cancel');
});
test('configuration fails closed without credentials and database settings', () => {
  expect(() => ProductionConfigSchema.parse({})).toThrow();
});
