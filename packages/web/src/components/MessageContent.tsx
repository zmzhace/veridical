import type { ReactNode } from 'react';

function inline(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith('`') && part.endsWith('`'))
        return <code key={index}>{part.slice(1, -1)}</code>;
      if (part.startsWith('**') && part.endsWith('**'))
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      return part;
    });
}

/** Small, dependency-free Markdown subset for model output. It never injects HTML. */
export function MessageContent({ text }: { text: string }) {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/(```[\s\S]*?```)/g)
    .filter(Boolean);
  return (
    <div className="message-markdown">
      {blocks.map((block, blockIndex) => {
        if (block.startsWith('```')) {
          const content = block.slice(3, -3);
          const newline = content.indexOf('\n');
          const language = newline > -1 ? content.slice(0, newline).trim() : '';
          const code = newline > -1 ? content.slice(newline + 1) : content;
          return (
            <div className="message-code" key={blockIndex}>
              {language && <span>{language}</span>}
              <pre>
                <code>{code.trimEnd()}</code>
              </pre>
            </div>
          );
        }
        const lines = block.split('\n');
        const nodes: ReactNode[] = [];
        let list: string[] = [];
        const flushList = () => {
          if (list.length) {
            nodes.push(
              <ul key={`list-${nodes.length}`}>
                {list.map((item, index) => (
                  <li key={index}>{inline(item)}</li>
                ))}
              </ul>,
            );
            list = [];
          }
        };
        lines.forEach((line, index) => {
          const bullet = line.match(/^\s*[-*]\s+(.+)/);
          if (bullet) {
            list.push(bullet[1]);
            return;
          }
          flushList();
          const heading = line.match(/^(#{1,3})\s+(.+)/);
          if (heading) {
            const Tag = `h${Math.min(3, heading[1].length + 1)}` as 'h2' | 'h3';
            nodes.push(<Tag key={index}>{inline(heading[2])}</Tag>);
          } else if (line.trim()) nodes.push(<p key={index}>{inline(line)}</p>);
        });
        flushList();
        return <div key={blockIndex}>{nodes}</div>;
      })}
    </div>
  );
}

/** Extracts the visible text from a streamed structured decision without flashing raw JSON. */
export function visibleStreamText(raw: string): string {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(trimmed) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    const marker = /"text"\s*:\s*"/.exec(trimmed);
    if (!marker) return '';
    const source = trimmed.slice(marker.index + marker[0].length);
    let output = '';
    let escaped = false;
    for (const character of source) {
      if (escaped) {
        output += character === 'n' ? '\n' : character === 't' ? '\t' : character;
        escaped = false;
      } else if (character === '\\') escaped = true;
      else if (character === '"') break;
      else output += character;
    }
    return output;
  }
}
