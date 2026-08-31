import type { ReactNode } from 'react';
import { MessageContent } from './MessageContent';

export function ChatBubble({
  role,
  content,
  children,
  streaming,
}: {
  role: 'user' | 'assistant';
  content: string;
  children?: ReactNode;
  streaming?: boolean;
}) {
  const isUser = role === 'user';
  return (
    <div className={`chat-message ${isUser ? 'is-user' : 'is-assistant'}`}>
      <div className="chat-avatar">{isUser ? '你' : 'AI'}</div>
      <div className="chat-message-body">
        <div className="chat-message-text">
          {isUser ? content : <MessageContent text={content} />}
          {streaming && <span className="cursor-typing" />}
        </div>
        {children}
      </div>
    </div>
  );
}
