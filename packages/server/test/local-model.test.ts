import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalModel, localModelMetadata } from '../src/local-model';
import { buildApp } from '../src/app';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function configure() {
  vi.stubEnv('VERIDICAL_PROVIDER_KEY', 'test-secret-not-for-client');
  vi.stubEnv('VERIDICAL_LLM_BASE_URL', 'https://model.example/v1');
  vi.stubEnv('VERIDICAL_LLM_MODEL', 'configured-model');
  vi.stubEnv('VERIDICAL_LLM_ENABLE_THINKING', 'false');
  vi.stubEnv('VERIDICAL_LLM_MAX_OUTPUT_TOKENS', '256');
}
test('public metadata excludes credentials and endpoint', () => {
  configure();
  expect(localModelMetadata()).toEqual({
    configured: true,
    model: 'configured-model',
    provider: 'openai-compatible',
  });
  vi.stubEnv('VERIDICAL_PROVIDER_KEY', '');
  expect(localModelMetadata()).toEqual({ configured: false });
});
test('configured provider uses server URL, token limit and thinking settings', async () => {
  configure();
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"text":"ok","done":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 5 },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  const local = createLocalModel();
  await local.provider.complete({ provider: 'local', model: local.model, messages: [] });
  expect(fetch.mock.calls[0][0]).toBe('https://model.example/v1/chat/completions');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
    model: 'configured-model',
    max_tokens: 256,
    enable_thinking: false,
  });
});
test('live route needs no client key, records real model, and rejects foreign origins', async () => {
  configure();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"text":"ok","done":true}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 5 },
          }),
        ),
    ),
  );
  const directory = mkdtempSync(join(tmpdir(), 'veridical-model-'));
  const app = await buildApp(join(directory, 'traces'), join(directory, 'specs'));
  try {
    const metadata = await app.inject({ method: 'GET', url: '/api/model-profile' });
    expect(metadata.json().model).toBe('configured-model');
    expect(metadata.body).not.toContain('test-secret');
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/run',
      headers: { origin: 'https://untrusted.example' },
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);
    const response = await app.inject({
      method: 'POST',
      url: '/api/run',
      payload: {
        mode: 'live',
        prompt: 'hello',
        specYaml:
          'name: test\nversion: 1.0.0\nschema_version: 1\ninstruction: { system: test }\nflow: { max_steps: 1 }\nllm: { provider: mock, model: m }\ntools: []',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"done"');
    expect(response.body).toContain('configured-model');
    expect(response.body).not.toContain('test-secret');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('invalid local settings fail closed', () => {
  configure();
  vi.stubEnv('VERIDICAL_LLM_BASE_URL', 'http://model.example/v1');
  expect(() => createLocalModel()).toThrow('invalid_local_model_endpoint');
  expect(localModelMetadata().configured).toBe(false);
});

test('two live turns reuse pinned model, context and conversation without client credentials', async () => {
  configure();
  const calls: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  text: calls.length === 1 ? '记住了蓝色' : '你喜欢蓝色',
                  done: true,
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        }),
      );
    }),
  );
  const directory = mkdtempSync(join(tmpdir(), 'veridical-chat-model-'));
  const app = await buildApp(join(directory, 'traces'), join(directory, 'specs'));
  try {
    await app.inject({
      method: 'POST',
      url: '/api/specs',
      payload: {
        yaml: 'name: chat-test\nversion: 1.0.0\nschema_version: 1\ninstruction: { system: test }\nflow: { max_steps: 3 }\nllm: { provider: mock, model: m }\ntools: []',
      },
    });
    const first = await app.inject({
      method: 'POST',
      url: '/api/run/turn',
      payload: { specName: 'chat-test', mode: 'live', prompt: '我喜欢蓝色' },
    });
    const frames = first.body
      .split('\n\n')
      .filter((s) => s.startsWith('data: '))
      .map((s) => JSON.parse(s.slice(6)));
    const id = frames.find((f) => f.type === 'done')?.session_id;
    expect(id).toMatch(/^conv_/);
    const second = await app.inject({
      method: 'POST',
      url: '/api/run/turn',
      payload: {
        specName: 'chat-test',
        conversationId: id,
        mode: 'live',
        prompt: '我喜欢什么颜色？',
      },
    });
    expect(second.body).toContain('你喜欢蓝色');
    expect(calls).toHaveLength(2);
    expect(calls[1].messages).toEqual(
      expect.arrayContaining([
        { role: 'user', content: '我喜欢蓝色' },
        { role: 'assistant', content: '记住了蓝色' },
        { role: 'user', content: '我喜欢什么颜色？' },
      ]),
    );
    expect(calls[1].model).toBe('configured-model');
    const events = await app.store.readBySession(id);
    expect(events.filter((e) => e.type === 'turn/start')).toHaveLength(2);
    expect(new Set(events.filter((e) => e.type === 'llm.request').map((e) => e.path)).size).toBe(2);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/run/turn',
      payload: { specName: 'chat-test', conversationId: id, mode: 'mock', prompt: 'hi' },
    });
    expect(changed.statusCode).toBe(409);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
