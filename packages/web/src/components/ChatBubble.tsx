import type { ReactNode } from 'react';

export function ChatBubble({ role, content, children, streaming }: { role: 'user' | 'assistant'; content: string; children?: ReactNode; streaming?: boolean }) {
  const isUser = role === 'user';
  return (
    <div className={`flex gap-3 animate-fade-in ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${isUser ? 'bg-[#4338CA] text-white' : 'bg-[#EDE9FE] text-[#4338CA]'}`}>
        {isUser ? '你' : 'AI'}
      </div>
      <div className={`flex-1 max-w-[85%] flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
        <div className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words ${
          isUser ? 'bg-[#4338CA] text-white rounded-tr-sm' : 'bg-[#F5F5F4] text-[#1A1A1A] rounded-tl-sm'
        }`}>
          {content}
          {streaming && <span className="cursor-typing" />}
        </div>
        {children}
      </div>
    </div>
  );
}