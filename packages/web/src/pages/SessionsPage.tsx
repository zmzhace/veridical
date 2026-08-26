import { useNavigate } from 'react-router-dom';
import { useSessions } from '../api/queries';
import { SessionList } from '../components/SessionList';

export function SessionsPage() {
  const { data, isLoading, error } = useSessions();
  const nav = useNavigate();
  if (isLoading) return <p className="text-[var(--muted)]">加载中…</p>;
  if (error) return <p className="text-red-600">加载会话失败。</p>;
  return (
    <div>
      <div className="mb-5">
        <h2 className="page-title">会话</h2>
        <p className="page-desc">每一次 agent 运行都会留下一条完整轨迹。点开看它说了什么、调了什么工具、有没有被合规拦住。</p>
      </div>
      {data && data.length ? (
        <SessionList sessions={data} onSelect={(id) => nav(`/sessions/${id}`)} />
      ) : (
        <div className="empty">
          <div className="empty-title">还没有任何运行记录</div>
          <div className="empty-desc">去「运行」页跑一个 agent，或先跑 demo：pnpm -F @veridical/demo test 生成 .traces</div>
        </div>
      )}
    </div>
  );
}