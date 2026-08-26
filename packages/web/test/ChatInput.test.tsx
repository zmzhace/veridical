import { test, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatInput } from '../src/components/ChatInput';

test('sends message on Enter', () => {
  let sent = '';
  render(<ChatInput onSend={(m) => (sent = m)} />);
  const ta = screen.getByPlaceholderText('输入消息…');
  fireEvent.change(ta, { target: { value: '你好' } });
  fireEvent.keyDown(ta, { key: 'Enter' });
  expect(sent).toBe('你好');
});

test('does not send on Shift+Enter', () => {
  let sent = '';
  render(<ChatInput onSend={(m) => (sent = m)} />);
  const ta = screen.getByPlaceholderText('输入消息…');
  fireEvent.change(ta, { target: { value: '换行' } });
  fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
  expect(sent).toBe('');
});
