#!/usr/bin/env node
/** Replay a complete task or an invocation subtree through the running API. */
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: pnpm --filter @veridical/server replay -- --session <id> [options]

Options:
  --invocation-id <id>  replay one invocation (and descendants)
  --path <path>         select a node by invocation path
  --scope <scope>       invocation | subtree | agent (default: subtree)
  --mode <mode>         strict | fixture | semantic (default: strict)
  --url <url>           API origin (default: http://127.0.0.1:8787)
  --token <token>       optional bearer token
  --json                print machine-readable result`);
  process.exit(0);
}
const session = value('--session');
const invocationId = value('--invocation-id');
const path = value('--path');
if (!session) throw new Error('--session is required');
if (invocationId && path) throw new Error('choose --invocation-id or --path, not both');
const mode = value('--mode') ?? 'strict';
if (!['strict', 'fixture', 'semantic'].includes(mode)) throw new Error('invalid --mode');
const scope = value('--scope') ?? 'subtree';
if (!['invocation', 'subtree', 'agent'].includes(scope)) throw new Error('invalid --scope');
const origin = (value('--url') ?? process.env.VERIDICAL_API_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const body = {
  session,
  mode,
  ...(invocationId ? { target_invocation_id: invocationId } : {}),
  ...(path ? { target_path: path } : {}),
  ...(invocationId || path ? { target_scope: scope } : {}),
};
const headers = { 'content-type': 'application/json', 'idempotency-key': `cli-replay-${Date.now()}-${Math.random()}` };
const token = value('--token') ?? process.env.VERIDICAL_API_TOKEN;
if (token) headers.authorization = `Bearer ${token}`;
const create = await fetch(`${origin}/v1/replay`, { method: 'POST', headers, body: JSON.stringify(body) });
if (!create.ok) throw new Error(`replay request failed (${create.status}): ${await create.text()}`);
const job = await create.json();
let result;
for (let i = 0; i < 600; i++) {
  const response = await fetch(`${origin}/v1/jobs/${encodeURIComponent(job.id)}`, { headers });
  if (!response.ok) throw new Error(`job lookup failed (${response.status}): ${await response.text()}`);
  const current = await response.json();
  if (current.state === 'completed') { result = current.result ?? current; break; }
  if (!['queued', 'running'].includes(current.state)) throw new Error(JSON.stringify(current.result ?? current));
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!result) throw new Error('replay timed out after 60 seconds');
console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : [
  `Replay ${result.identical ? 'identical' : 'completed'} (${result.mode ?? mode})`,
  result.replayed_scope ? `Scope: ${result.replayed_scope} @ ${result.target_path ?? invocationId ?? path}` : 'Scope: full session',
  `External calls: ${result.external_calls ?? 0}`,
].join('\n'));
