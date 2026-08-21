import { useSpecs } from '../api/queries';

export function SpecsPage() {
  const { data, isLoading } = useSpecs();
  if (isLoading) return <p>Loading…</p>;
  return (<div><h2 className="text-xl font-semibold mb-3">Specs</h2>{data && data.length ? <ul className="space-y-1">{data.map((s: any) => <li key={s.name + s.version} className="border p-2 rounded">{s.name}@{s.version}</li>)}</ul> : <p>No specs registered.</p>}</div>);
}
