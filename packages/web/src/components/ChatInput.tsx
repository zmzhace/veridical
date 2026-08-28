import { useRef, useState } from 'react';

export function ChatInput({
  onSend,
  disabled,
  loading,
  placeholder = '输入消息…',
}: {
  onSend: (m: string) => void;
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  function send() {
    if (!value.trim() || disabled || loading) return;
    onSend(value.trim());
    setValue('');
    if (ref.current) ref.current.style.height = 'auto';
  }
  return (
    <div className="chat-composer">
      <div className="chat-composer-box">
        <textarea
          ref={ref}
          value={value}
          aria-label="消息"
          placeholder={placeholder}
          disabled={disabled || loading}
          rows={1}
          maxLength={2000}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onChange={(e) => {
            setValue(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
          }}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              !composing.current
            ) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          aria-label="发送消息"
          onClick={send}
          disabled={!value.trim() || disabled || loading}
          className="btn btn-primary"
        >
          {loading ? '执行中' : '发送'}
        </button>
      </div>
      <div className="chat-composer-footer">
        <span>Enter 发送 / Shift + Enter 换行</span>
        <span>{value.length} / 2000</span>
      </div>
    </div>
  );
}
