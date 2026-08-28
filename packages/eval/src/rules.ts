import type { TraceEvent } from '@veridical/schema';

export interface Verdict {
  passed: boolean;
  detail?: string;
}

export interface Rule {
  name: string;
  check(events: TraceEvent[]): Verdict;
}

const payloadOf = (e: TraceEvent) => e.payload as any;

export function ruleOutcomeEquals(value: unknown): Rule {
  return {
    name: 'outcome_equals',
    check(events) {
      const end = [...events].reverse().find(e => e.type === 'turn/end');
      const outcome = end ? payloadOf(end).outcome : undefined;
      return { passed: JSON.stringify(outcome) === JSON.stringify(value) };
    },
  };
}

export function ruleTextContains(substring: string, role: 'assistant' | 'user' = 'assistant'): Rule {
  const types = role === 'user' ? ['user.message'] : ['assistant.message'];
  return {
    name: 'text_contains',
    check(events) {
      const hit = events.some(e => types.includes(e.type) && String(payloadOf(e).text ?? '').includes(substring));
      return hit ? { passed: true } : { passed: false, detail: `no ${role}.message contains "${substring}"` };
    },
  };
}

export function ruleToolCalled(name: string): Rule {
  return {
    name: 'tool_called',
    check(events) {
      const hit = events.some(e => e.type === 'tool.called' && payloadOf(e).name === name);
      return hit ? { passed: true } : { passed: false, detail: `tool ${name} not called` };
    },
  };
}

export function ruleToolNotDenied(name: string): Rule {
  return {
    name: 'tool_not_denied',
    check(events) {
      const denied = events.some(e => e.type === 'tool.result' && payloadOf(e).name === name && payloadOf(e).result?.reason === 'denied');
      return denied ? { passed: false, detail: `tool ${name} was denied` } : { passed: true };
    },
  };
}

export function ruleNoErrors(): Rule {
  return {
    name: 'no_errors',
    check(events) {
      const err = events.find(e => e.verb === 'error' ||
        (e.type === 'tool.result' && (payloadOf(e)?.blocked === true || payloadOf(e)?.result?.ok === false)));
      return err ? { passed: false, detail: `${err.type} failure at seq ${err.seq}` } : { passed: true };
    },
  };
}
