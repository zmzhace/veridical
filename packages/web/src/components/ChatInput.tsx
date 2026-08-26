import { useRef, useState } from 'react';

export function ChatInput({ onSend, disabled, loading, placeholder = '输入消息…' }: { onSend: (m: string) => void; disabled?: boolean; loading?: boolean; placeholder?: string }) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  function resize() {
    const el = ref.current; if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  function send() {
    if (!value.trim() || disabled || loading) return;
    onSend(value.trim());
    setValue('');
    if (ref.current) ref.current.style.height = 'auto';
  }

  return (
    <div className="border-t border-[#E7E5E4] bg-white p-4">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <textarea ref={ref} value={value} onChange={(e) => { setValue(e.target.value); resize(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={placeholder} disabled={disabled || loading} rows={1} maxLength={2000}
            className="w-full px-4 py-3 bg-[#FAFAF9] border border-[#E7E5E4] rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#4338CA] focus:border-transparent transition-all duration-200 disabled:opacity-50"
            style={{ minHeight: 44, maxHeight: 120 }} />
          <div className="text-xs text-[#78716C] mt-1 text-right">{value.length} / 2000</div>
        </div>
        <button onClick={send} disabled={!value.trim() || disabled} className="shrink-0 w-11 h-11 flex items-center justify-center rounded-full bg-[#4338CA] hover:bg-[#3730A3] text-white transition-all duration-200 active:scale-95 disabled:opacity-40">
          {loading ? (
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
          )}
        </button>
      </div>
    </div>
  );
}