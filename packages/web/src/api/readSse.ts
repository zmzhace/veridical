export function readSseFrames(response: Response, onFrame: (frame: any) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const reader = response.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';
          for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed.startsWith('data:')) continue;
            try {
              onFrame(JSON.parse(trimmed.replace(/^data:\s*/, '')));
            } catch {
              // 跳过半行/非 JSON 帧
            }
          }
        }
        resolve();
      } catch (e) {
        reject(e);
      }
    })();
  });
}
