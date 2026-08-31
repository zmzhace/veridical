import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageContent, visibleStreamText } from '../src/components/MessageContent';

test('does not flash structured decision JSON while streaming', () => {
  expect(visibleStreamText('{"te')).toBe('');
  expect(visibleStreamText('{"text":"你好\\n世界","done":')).toBe('你好\n世界');
  expect(visibleStreamText('{"text":"逐段输出"')).toBe('逐段输出');
  expect(visibleStreamText('{"text":"完成","done":true}')).toBe('完成');
  expect(visibleStreamText('普通文本')).toBe('普通文本');
});

test('renders model markdown as safe structured content', () => {
  render(<MessageContent text={'## 结果\n- 第一项\n- 第二项\n\n```ts\nconst ok = true;\n```'} />);
  expect(screen.getByRole('heading', { name: '结果' })).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByText('const ok = true;')).toBeInTheDocument();
});
