import { test, expect, vi } from 'vitest';
import { readSseFrames } from '../src/api/readSse';

function sseResponse(frames: unknown[]): Response {
  const body = new ReadableStream({
    start(controller) {
      for (const f of frames) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

test('readSseFrames parses data: frames in order', async () => {
  const frames = [
    { type: 'token', session_id: 'conv_a', text: '你' },
    { type: 'token', session_id: 'conv_a', text: '好' },
    { type: 'done', session_id: 'conv_a', event_count: 3 },
  ];
  const seen: unknown[] = [];
  await readSseFrames(sseResponse(frames), (f) => seen.push(f));
  expect(seen).toEqual(frames);
});

test('readSseFrames tolerates a trailing partial chunk', async () => {
  const payload = `data: {"type":"token","text":"a"}\n\ndata: {"type":"token","t`;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  const seen: unknown[] = [];
  await readSseFrames(new Response(body), (f) => seen.push(f));
  expect(seen).toEqual([{ type: 'token', text: 'a' }]);
});
