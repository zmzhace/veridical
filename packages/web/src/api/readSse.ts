export function readSseFrames(response: Response, onFrame: (frame: any) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!response.body) {
      reject(new Error('SSE response body is missing'));
      return;
    }
    const reader = response.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const consume = (chunk: string, flush = false) => {
      buf += chunk;
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.split(/\r?\n/).find((entry) => entry.trimStart().startsWith('data:'));
        if (!line) continue;
        try {
          onFrame(JSON.parse(line.replace(/^\s*data:\s*/, '')));
        } catch {
          // Ignore malformed or incomplete frames; the server may emit comments.
        }
      }
      if (flush && buf.trim()) {
        const line = buf.split(/\r?\n/).find((entry) => entry.trimStart().startsWith('data:'));
        if (line) {
          try {
            onFrame(JSON.parse(line.replace(/^\s*data:\s*/, '')));
            buf = '';
          } catch {
            // A genuinely partial trailing frame is intentionally ignored.
          }
        }
      }
    };
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          consume(dec.decode(value, { stream: true }));
        }
        consume(dec.decode(), true);
        resolve();
      } catch (e) {
        reject(e);
      }
    })();
  });
}
