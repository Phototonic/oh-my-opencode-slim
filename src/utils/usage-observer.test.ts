import { describe, expect, test } from 'bun:test';

import {
  createUsageObserver,
  formatUsageSummary,
  MAX_TRACKED_SESSIONS,
  type UsageObserver,
} from './usage-observer';

/** v1 native completed assistant message. */
function v1Message(overrides: {
  sessionID: string;
  id: string;
  input: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  modelID?: string;
  providerID?: string;
  cost?: number;
  completedAt?: number;
}) {
  return {
    type: 'message.updated',
    properties: {
      info: {
        id: overrides.id,
        role: 'assistant',
        sessionID: overrides.sessionID,
        modelID: overrides.modelID ?? 'glm-4.7',
        providerID: overrides.providerID ?? 'zai-coding-plan',
        time: { completed: overrides.completedAt ?? 1_000 },
        tokens: {
          input: overrides.input,
          output: overrides.output ?? 0,
          reasoning: overrides.reasoning ?? 0,
          cache: {
            read: overrides.cacheRead ?? 0,
            write: overrides.cacheWrite ?? 0,
          },
        },
        ...(overrides.cost !== undefined ? { cost: overrides.cost } : {}),
      },
    },
  };
}

let v2EventSeq = 0;

/**
 * Raw v2 step/usage event. Step events carry per-step deltas and an
 * envelope id; usage events carry the host's cumulative snapshot.
 */
function v2Event(
  kind: 'step' | 'usage',
  overrides: {
    sessionID: string;
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
    created?: number;
    assistantMessageID?: string;
    failed?: boolean;
    envelopeID?: string;
  },
) {
  v2EventSeq += 1;
  const tokens: Record<string, unknown> = {};
  if (overrides.input !== undefined) tokens.input = overrides.input;
  if (overrides.output !== undefined) tokens.output = overrides.output;
  if (overrides.reasoning !== undefined) tokens.reasoning = overrides.reasoning;
  if (overrides.cacheRead !== undefined || overrides.cacheWrite !== undefined) {
    tokens.cache = {
      ...(overrides.cacheRead !== undefined
        ? { read: overrides.cacheRead }
        : {}),
      ...(overrides.cacheWrite !== undefined
        ? { write: overrides.cacheWrite }
        : {}),
    };
  }
  const data: Record<string, unknown> = {
    sessionID: overrides.sessionID,
    ...(Object.keys(tokens).length > 0 ? { tokens } : {}),
    ...(overrides.cost !== undefined ? { cost: overrides.cost } : {}),
  };
  if (kind === 'step' && overrides.assistantMessageID) {
    data.assistantMessageID = overrides.assistantMessageID;
  }
  return {
    // Unique per constructed event, like the host's evt_ ids; tests can
    // replay one event object for duplicate delivery.
    id: overrides.envelopeID ?? `evt_test_${v2EventSeq}`,
    created: overrides.created ?? 2_000,
    type:
      kind === 'step'
        ? overrides.failed
          ? 'session.step.failed'
          : 'session.step.ended'
        : 'session.usage.updated',
    data,
  };
}

describe('usage observer: v1 message.updated', () => {
  test('records latest and cumulative fields explicitly', () => {
    const observer = createUsageObserver();
    observer.observeEvent(
      v1Message({
        sessionID: 'ses_a',
        id: 'msg_1',
        input: 100,
        output: 10,
        reasoning: 1,
        cacheRead: 5,
        cacheWrite: 2,
        cost: 0.5,
      }),
    );
    observer.observeEvent(
      v1Message({
        sessionID: 'ses_a',
        id: 'msg_2',
        input: 200,
        output: 20,
        reasoning: 2,
        cacheRead: 7,
        cacheWrite: 3,
        cost: 0.25,
      }),
    );
    const summary = observer.describeSession('ses_a');
    expect(summary).toBeDefined();
    expect(summary?.observedRequests).toBe(2);
    expect(summary?.latestTokens).toEqual({
      input: 200,
      output: 20,
      reasoning: 2,
      cacheRead: 7,
      cacheWrite: 3,
    });
    expect(summary?.totals).toEqual({
      input: 300,
      output: 30,
      reasoning: 3,
      cacheRead: 12,
      cacheWrite: 5,
      cost: 0.75,
    });
  });

  test('records observed model identity from the message', () => {
    const observer = createUsageObserver();
    observer.observeEvent(
      v1Message({
        sessionID: 'ses_a',
        id: 'msg_1',
        input: 1,
        modelID: 'claude-sonnet-4',
        providerID: 'anthropic',
      }),
    );
    expect(observer.describeSession('ses_a')?.latestMessageModel).toEqual({
      modelID: 'claude-sonnet-4',
      providerID: 'anthropic',
    });
  });

  test('ignores streaming (not yet completed) messages', () => {
    const observer = createUsageObserver();
    observer.observeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_1',
          role: 'assistant',
          sessionID: 'ses_a',
          tokens: { input: 5 },
        },
      },
    });
    expect(observer.describeSession('ses_a')).toBeUndefined();
  });

  test('missing token fields stay unavailable, never zero-filled', () => {
    const observer = createUsageObserver();
    observer.observeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_1',
          role: 'assistant',
          sessionID: 'ses_a',
          time: { completed: 900 },
          tokens: { input: 42 },
        },
      },
    });
    observer.observeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_2',
          role: 'assistant',
          sessionID: 'ses_a',
          time: { completed: 1_100 },
          tokens: { input: 10, output: 3, cache: { read: 1, write: 1 } },
        },
      },
    });
    const summary = observer.describeSession('ses_a');
    expect(summary?.latestTokens).toEqual({
      input: 10,
      output: 3,
      cacheRead: 1,
      cacheWrite: 1,
    });
    expect(summary?.totals).toEqual({
      input: 52,
      output: 3,
      cacheRead: 1,
      cacheWrite: 1,
    });
    expect('reasoning' in (summary?.totals ?? {})).toBe(false);
    expect('reasoning' in (summary?.latestTokens ?? {})).toBe(false);
  });

  test('v2-usage synthetic echoes are skipped (raw events own the samples)', () => {
    const observer = createUsageObserver();
    observer.observeEvent(
      v2Event('step', {
        sessionID: 'ses_a',
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
      }),
    );
    // The adapter's synthesized echo (zero-fills output/reasoning).
    observer.observeEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'v2-usage:ses_a:10:4:2:1',
          role: 'assistant',
          sessionID: 'ses_a',
          time: { completed: 0 },
          tokens: {
            input: 10,
            output: 4,
            reasoning: 0,
            cache: { read: 2, write: 1 },
          },
        },
      },
    });
    const summary = observer.describeSession('ses_a');
    expect(summary?.observedRequests).toBe(1);
    expect(summary?.latestTokens).toEqual({
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
    });
    expect('reasoning' in (summary?.latestTokens ?? {})).toBe(false);
  });
});

describe('usage observer: raw v2 step and usage events', () => {
  test('replayed step events (same envelope id) count once', () => {
    const observer = createUsageObserver();
    const event = v2Event('step', {
      sessionID: 'ses_a',
      input: 100,
      output: 20,
      cacheRead: 8,
      cacheWrite: 2,
    });
    observer.observeEvent(event);
    observer.observeEvent(event);
    observer.observeEvent({ ...event });
    expect(observer.describeSession('ses_a')?.observedRequests).toBe(1);
  });

  test('steps of one assistant message (tool loop) count separately', () => {
    const observer = createUsageObserver();
    observer.observeEvent(
      v2Event('step', {
        sessionID: 'ses_a',
        input: 100,
        assistantMessageID: 'msg_1',
      }),
    );
    observer.observeEvent(
      v2Event('step', {
        sessionID: 'ses_a',
        input: 150,
        assistantMessageID: 'msg_1',
      }),
    );
    const summary = observer.describeSession('ses_a');
    expect(summary?.observedRequests).toBe(2);
    expect(summary?.totals).toEqual({ input: 250 });
  });

  test('session.usage.updated is a cumulative snapshot, never summed', () => {
    const observer = createUsageObserver();
    // Two steps of 100 + 200; the host then publishes cumulative 300.
    observer.observeEvent(
      v2Event('step', {
        sessionID: 'ses_a',
        input: 100,
        cost: 0.1,
        created: 1_000,
      }),
    );
    observer.observeEvent(
      v2Event('step', {
        sessionID: 'ses_a',
        input: 200,
        cost: 0.2,
        created: 2_000,
      }),
    );
    observer.observeEvent(
      v2Event('usage', {
        sessionID: 'ses_a',
        input: 300,
        cost: 0.3,
        created: 2_000,
      }),
    );
    // A later cumulative snapshot replaces, not adds.
    observer.observeEvent(
      v2Event('usage', {
        sessionID: 'ses_a',
        input: 350,
        cost: 0.35,
        created: 3_000,
      }),
    );
    const summary = observer.describeSession('ses_a');
    expect(summary?.observedRequests).toBe(2);
    expect(summary?.totals).toEqual({ input: 300, cost: 0.30000000000000004 });
    expect(summary?.hostTotals).toEqual({
      tokens: { input: 350 },
      cost: 0.35,
      observedAt: 3_000,
    });
  });

  test('a delayed older usage snapshot never regresses the newest one', () => {
    const observer = createUsageObserver();
    observer.observeEvent(
      v2Event('usage', { sessionID: 'ses_a', input: 500, created: 5_000 }),
    );
    // Older cumulative snapshot delivered late (reorder).
    observer.observeEvent(
      v2Event('usage', { sessionID: 'ses_a', input: 300, created: 3_000 }),
    );
    expect(observer.describeSession('ses_a')?.hostTotals).toEqual({
      tokens: { input: 500 },
      observedAt: 5_000,
    });
    // An untimed snapshot still replaces (arrival order is all we have).
    const untimed = v2Event('usage', { sessionID: 'ses_a', input: 650 });
    delete (untimed as { created?: number }).created;
    observer.observeEvent(untimed);
    expect(observer.describeSession('ses_a')?.hostTotals?.tokens).toEqual({
      input: 650,
    });
  });

  test('a usage snapshot alone still surfaces (host totals predate steps)', () => {
    const observer = createUsageObserver();
    observer.observeEvent(
      v2Event('usage', { sessionID: 'ses_a', input: 9_000 }),
    );
    const summary = observer.describeSession('ses_a');
    expect(summary?.observedRequests).toBe(0);
    expect(summary?.hostTotals?.tokens).toEqual({ input: 9_000 });
    const lines = formatUsageSummary(summary);
    expect(lines.some((l) => l.includes('session_totals (host snapshot'))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes('input=9000'))).toBe(true);
    expect(lines.some((l) => l.includes('observed_totals'))).toBe(false);
  });

  test('step.failed records usage only when cost and tokens are both present', () => {
    const observer = createUsageObserver();
    observer.observeEvent(
      v2Event('step', {
        sessionID: 'ses_a',
        input: 50,
        output: 5,
        cost: 0.05,
        failed: true,
      }),
    );
    expect(observer.describeSession('ses_a')?.observedRequests).toBe(1);
    // No tokens → the host attributes no usage; ignored.
    observer.observeEvent(
      v2Event('step', { sessionID: 'ses_b', cost: 0.02, failed: true }),
    );
    expect(observer.describeSession('ses_b')).toBeUndefined();
  });

  test('out-of-order arrival counts each request; latest is newest by host time', () => {
    const observer = createUsageObserver();
    observer.observeEvent(
      v2Event('step', {
        sessionID: 'ses_a',
        input: 30,
        output: 3,
        created: 3_000,
      }),
    );
    // An earlier request delivered later (reorder).
    observer.observeEvent(
      v2Event('step', {
        sessionID: 'ses_a',
        input: 10,
        output: 1,
        created: 1_000,
      }),
    );
    const summary = observer.describeSession('ses_a');
    expect(summary?.observedRequests).toBe(2);
    expect(summary?.totals).toEqual({ input: 40, output: 4 });
    expect(summary?.latestTokens?.input).toBe(30);
    expect(summary?.firstObservedAt).toBe(1_000);
    expect(summary?.lastObservedAt).toBe(3_000);
  });

  test('reduced hosts without envelope ids dedupe by content fallback', () => {
    const observer = createUsageObserver();
    const a = {
      ...v2Event('step', {
        sessionID: 'ses_a',
        input: 10,
        assistantMessageID: 'msg_1',
      }),
    };
    delete (a as { id?: string }).id;
    observer.observeEvent(a);
    observer.observeEvent({ ...a });
    expect(observer.describeSession('ses_a')?.observedRequests).toBe(1);
    // Same content under a different assistant message stays distinct.
    const b = {
      ...v2Event('step', {
        sessionID: 'ses_a',
        input: 10,
        assistantMessageID: 'msg_2',
      }),
    };
    delete (b as { id?: string }).id;
    observer.observeEvent(b);
    expect(observer.describeSession('ses_a')?.observedRequests).toBe(2);
  });

  test('accepts step events missing input/cache counters', () => {
    const observer = createUsageObserver();
    observer.observeEvent(v2Event('step', { sessionID: 'ses_a', output: 12 }));
    const summary = observer.describeSession('ses_a');
    expect(summary?.latestTokens).toEqual({ output: 12 });
    expect(summary?.totals).toEqual({ output: 12 });
  });

  test('legacy properties spelling resolves the payload', () => {
    const observer = createUsageObserver();
    observer.observeEvent({
      type: 'session.step.ended',
      properties: {
        sessionID: 'ses_a',
        tokens: { input: 7, cache: { read: 1 } },
      },
    });
    expect(observer.describeSession('ses_a')?.totals).toEqual({
      input: 7,
      cacheRead: 1,
    });
  });
});

describe('usage observer: session isolation', () => {
  test('two concurrent children and the parent never share counters', () => {
    const observer = createUsageObserver();
    // Interleaved traffic across three sessions.
    observer.observeEvent(
      v2Event('step', { sessionID: 'ses_child1', input: 100 }),
    );
    observer.observeEvent(
      v2Event('step', { sessionID: 'ses_child2', input: 500 }),
    );
    observer.observeEvent(
      v1Message({
        sessionID: 'ses_parent',
        id: 'msg_p1',
        input: 9_000,
        providerID: 'p',
        modelID: 'm',
      }),
    );
    observer.observeEvent(
      v2Event('step', { sessionID: 'ses_child1', input: 50 }),
    );
    observer.observeEvent(
      v2Event('step', { sessionID: 'ses_child2', input: 700 }),
    );

    const child1 = observer.describeSession('ses_child1');
    const child2 = observer.describeSession('ses_child2');
    const parent = observer.describeSession('ses_parent');
    expect(child1?.observedRequests).toBe(2);
    expect(child1?.totals?.input).toBe(150);
    expect(child2?.observedRequests).toBe(2);
    expect(child2?.totals?.input).toBe(1_200);
    expect(parent?.observedRequests).toBe(1);
    expect(parent?.totals?.input).toBe(9_000);
    // Same step content in different sessions stays distinct.
    observer.observeEvent(
      v2Event('step', { sessionID: 'ses_child2', input: 100 }),
    );
    expect(observer.describeSession('ses_child2')?.totals?.input).toBe(1_300);
    expect(observer.describeSession('ses_child1')?.totals?.input).toBe(150);
  });

  test('a usage snapshot of one session never leaks into another', () => {
    const observer = createUsageObserver();
    observer.observeEvent(
      v2Event('usage', { sessionID: 'ses_a', input: 999_999 }),
    );
    observer.observeEvent(v2Event('step', { sessionID: 'ses_b', input: 1 }));
    const b = observer.describeSession('ses_b');
    expect(b?.totals).toEqual({ input: 1 });
    expect(b?.hostTotals).toBeUndefined();
  });

  test('provider/model differences are recorded per session, not merged', () => {
    const observer = createUsageObserver();
    observer.recordModelRequest({
      sessionID: 'ses_a',
      model: { id: 'glm-4.7', providerID: 'zai-coding-plan', variant: 'think' },
      kind: 'primary',
    });
    observer.recordModelRequest({
      sessionID: 'ses_b',
      model: { id: 'claude-sonnet-4', providerID: 'anthropic' },
      kind: 'primary',
    });
    expect(observer.describeSession('ses_a')?.lastModelRequest?.modelID).toBe(
      'glm-4.7',
    );
    expect(observer.describeSession('ses_b')?.lastModelRequest?.modelID).toBe(
      'claude-sonnet-4',
    );
  });

  test('a continuation on a new session id starts fresh (no inheritance)', () => {
    const observer = createUsageObserver();
    observer.observeEvent(
      v2Event('step', { sessionID: 'ses_run1', input: 100 }),
    );
    observer.observeEvent(
      v2Event('usage', { sessionID: 'ses_run1', input: 100 }),
    );
    // Continuation/relaunch gets a new host session id.
    observer.observeEvent(
      v2Event('step', { sessionID: 'ses_run2', input: 11 }),
    );
    const run2 = observer.describeSession('ses_run2');
    expect(run2?.observedRequests).toBe(1);
    expect(run2?.totals).toEqual({ input: 11 });
    expect(run2?.hostTotals).toBeUndefined();
    expect(run2?.firstObservedAt).toBe(2_000);
  });

  test('session.deleted evicts state in v1 and v2 spellings', () => {
    const observer: UsageObserver = createUsageObserver();
    observer.observeEvent(v2Event('step', { sessionID: 'ses_a', input: 5 }));
    observer.observeEvent({
      type: 'session.deleted',
      properties: { info: { id: 'ses_a' }, sessionID: 'ses_a' },
    });
    expect(observer.describeSession('ses_a')).toBeUndefined();

    observer.observeEvent(v2Event('step', { sessionID: 'ses_b', input: 6 }));
    observer.observeEvent({
      type: 'session.deleted',
      data: { sessionID: 'ses_b' },
    });
    expect(observer.describeSession('ses_b')).toBeUndefined();
  });

  test('restart gap: a fresh observer instance has no history', () => {
    const first = createUsageObserver();
    first.observeEvent(v2Event('step', { sessionID: 'ses_a', input: 100 }));
    expect(first.describeSession('ses_a')).toBeDefined();
    const restarted = createUsageObserver();
    expect(restarted.describeSession('ses_a')).toBeUndefined();
    restarted.observeEvent(v2Event('step', { sessionID: 'ses_a', input: 1 }));
    expect(restarted.describeSession('ses_a')?.totals).toEqual({ input: 1 });
  });
});

describe('usage observer: model requests (v2 tap)', () => {
  test('records model, variant, and kind; last request wins', () => {
    const observer = createUsageObserver();
    observer.recordModelRequest({
      sessionID: 'ses_a',
      model: { id: 'glm-4.7', providerID: 'zai' },
      kind: 'title',
    });
    observer.recordModelRequest({
      sessionID: 'ses_a',
      model: { id: 'glm-4.7', providerID: 'zai', variant: 'think' },
      kind: 'primary',
    });
    const last = observer.describeSession('ses_a')?.lastModelRequest;
    expect(last?.variant).toBe('think');
    expect(last?.kind).toBe('primary');
  });

  test('title/compaction requests never displace the primary observed model', () => {
    const observer = createUsageObserver();
    observer.recordModelRequest({
      sessionID: 'ses_a',
      model: { id: 'glm-4.7', providerID: 'zai', variant: 'think' },
      kind: 'primary',
    });
    // The host titles and compacts the same session with another model.
    observer.recordModelRequest({
      sessionID: 'ses_a',
      model: { id: 'gpt-5-mini', providerID: 'openai' },
      kind: 'title',
    });
    observer.recordModelRequest({
      sessionID: 'ses_a',
      model: { id: 'gpt-5-mini', providerID: 'openai' },
      kind: 'compaction',
    });
    const last = observer.describeSession('ses_a')?.lastModelRequest;
    expect(last?.modelID).toBe('glm-4.7');
    expect(last?.kind).toBe('primary');
    const lines = formatUsageSummary(observer.describeSession('ses_a'));
    expect(lines.some((l) => l.includes('observed_model: zai/glm-4.7'))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes('gpt-5-mini'))).toBe(false);
  });

  test('a non-primary-only observation is still shown, labelled by kind', () => {
    const observer = createUsageObserver();
    observer.recordModelRequest({
      sessionID: 'ses_a',
      model: { id: 'gpt-5-mini', providerID: 'openai' },
      kind: 'title',
    });
    const lines = formatUsageSummary(observer.describeSession('ses_a'));
    const model = lines.find((l) => l.includes('observed_model'));
    expect(model).toContain('openai/gpt-5-mini');
    expect(model).toContain('kind: title');
    // A missing kind (reduced host) is treated as the primary loop.
    observer.recordModelRequest({
      sessionID: 'ses_a',
      model: { id: 'glm-4.7', providerID: 'zai' },
    });
    expect(observer.describeSession('ses_a')?.lastModelRequest?.modelID).toBe(
      'glm-4.7',
    );
  });

  test('model request with no usage yet yields a model-only summary', () => {
    const observer = createUsageObserver();
    observer.recordModelRequest({
      sessionID: 'ses_a',
      model: { id: 'm1', providerID: 'p1' },
      kind: 'primary',
    });
    const summary = observer.describeSession('ses_a');
    expect(summary?.observedRequests).toBe(0);
    expect(summary?.lastModelRequest?.modelID).toBe('m1');
    const lines = formatUsageSummary(summary);
    expect(lines.some((l) => l.includes('observed_model: p1/m1'))).toBe(true);
    expect(lines.some((l) => l.includes('observed_totals'))).toBe(false);
  });
});

describe('usage observer: bounds and fail-soft', () => {
  test('evicts the oldest session beyond the cap', () => {
    const observer = createUsageObserver();
    const cap = MAX_TRACKED_SESSIONS;
    for (let i = 0; i < cap; i += 1) {
      observer.observeEvent(
        v2Event('step', { sessionID: `ses_${i}`, input: 1 }),
      );
    }
    observer.observeEvent(v2Event('step', { sessionID: 'ses_new', input: 1 }));
    expect(observer.describeSession('ses_0')).toBeUndefined();
    expect(observer.describeSession('ses_1')).toBeDefined();
    expect(observer.describeSession('ses_new')).toBeDefined();
  });

  test('session eviction is least recently observed, not earliest created', () => {
    const observer = createUsageObserver();
    const cap = MAX_TRACKED_SESSIONS;
    for (let i = 0; i < cap; i += 1) {
      observer.observeEvent(
        v2Event('step', { sessionID: `ses_${i}`, input: 1 }),
      );
    }
    // The earliest session is still active: one more observation keeps it.
    observer.observeEvent(v2Event('step', { sessionID: 'ses_0', input: 1 }));
    observer.observeEvent(v2Event('step', { sessionID: 'ses_new', input: 1 }));
    expect(observer.describeSession('ses_0')?.observedRequests).toBe(2);
    expect(observer.describeSession('ses_1')).toBeUndefined();
    expect(observer.describeSession('ses_new')).toBeDefined();
  });

  test('fingerprint overflow evicts the oldest; recent replays still dedupe', () => {
    const observer = createUsageObserver();
    const events: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 512; i += 1) {
      const event = v2Event('step', { sessionID: 'ses_a', input: i });
      events.push(event);
      observer.observeEvent(event);
    }
    expect(observer.describeSession('ses_a')?.observedRequests).toBe(512);
    // The 513th distinct fingerprint evicts the oldest remembered one…
    observer.observeEvent(
      v2Event('step', { sessionID: 'ses_a', input: 9_999 }),
    );
    expect(observer.describeSession('ses_a')?.observedRequests).toBe(513);
    // …but a recent fingerprint (512th) still dedupes…
    observer.observeEvent(events[511]);
    expect(observer.describeSession('ses_a')?.observedRequests).toBe(513);
    // …while the evicted oldest counts again (documented horizon).
    observer.observeEvent(events[0]);
    expect(observer.describeSession('ses_a')?.observedRequests).toBe(514);
  });

  test('malformed events never throw', () => {
    const observer = createUsageObserver();
    expect(() => {
      observer.observeEvent(null);
      observer.observeEvent(undefined);
      observer.observeEvent({ type: 'message.updated' });
      observer.observeEvent({ type: 'session.step.ended', data: 'garbage' });
      observer.observeEvent({
        type: 'message.updated',
        properties: {
          info: { role: 'assistant', sessionID: 'x', id: 'y', tokens: 'nope' },
        },
      });
      observer.recordModelRequest(null);
      observer.recordModelRequest({ sessionID: 5 });
    }).not.toThrow();
    // Non-usage event types are ignored.
    observer.observeEvent({
      type: 'session.idle',
      properties: { sessionID: 'ses_a' },
    });
    expect(observer.describeSession('ses_a')).toBeUndefined();
  });

  test('unrenderable timestamps do not break the summary render', () => {
    const observer = createUsageObserver();
    observer.observeEvent(
      v2Event('step', {
        sessionID: 'ses_a',
        input: 5,
        created: Number.MAX_VALUE,
      }),
    );
    const lines = formatUsageSummary(observer.describeSession('ses_a'));
    expect(lines.some((l) => l.includes('observed_totals'))).toBe(true);
    expect(lines.some((l) => l.includes('NaN'))).toBe(false);
  });
});

describe('formatUsageSummary', () => {
  test('renders unavailable explicitly and labels cumulative as observed', () => {
    const observer = createUsageObserver();
    observer.observeEvent(
      v2Event('step', {
        sessionID: 'ses_a',
        input: 10,
        output: 2,
        cacheRead: 4,
      }),
    );
    const lines = formatUsageSummary(observer.describeSession('ses_a'));
    expect(lines[0]).toContain('advisory');
    expect(lines[0]).toContain('not billing');
    const totals = lines.find((l) => l.includes('observed_totals'));
    expect(totals).toContain('1 observed request');
    expect(totals).toContain('input=10');
    expect(totals).toContain('cache_read=4');
    expect(totals).not.toContain('reasoning=');
    expect(totals).not.toContain('cost=');
    const latest = lines.find((l) => l.includes('latest_request'));
    expect(latest).toContain('input=10 output=2 cache_read=4');
  });

  test('renders the v2 observed model with variant and kind', () => {
    const observer = createUsageObserver();
    observer.recordModelRequest({
      sessionID: 'ses_a',
      model: { id: 'glm-4.7', providerID: 'zai-coding-plan', variant: 'think' },
      kind: 'primary',
    });
    observer.observeEvent(v2Event('step', { sessionID: 'ses_a', input: 1 }));
    const lines = formatUsageSummary(observer.describeSession('ses_a'));
    const model = lines.find((l) => l.includes('observed_model'));
    expect(model).toContain('zai-coding-plan/glm-4.7');
    expect(model).toContain('variant: think');
    expect(model).toContain('kind: primary');
  });

  test('renders the host snapshot separately from observed totals', () => {
    const observer = createUsageObserver();
    observer.observeEvent(
      v2Event('step', { sessionID: 'ses_a', input: 100, created: 1_000 }),
    );
    observer.observeEvent(
      v2Event('usage', {
        sessionID: 'ses_a',
        input: 700,
        cost: 0.4,
        created: 2_000,
      }),
    );
    const lines = formatUsageSummary(observer.describeSession('ses_a'));
    const totals = lines.find((l) => l.includes('observed_totals'));
    expect(totals).toContain('input=100');
    const snapshot = lines.find((l) => l.includes('session_totals'));
    expect(snapshot).toContain('input=700');
    expect(snapshot).toContain('cost=0.4');
    expect(snapshot).toContain('may include usage from before this process');
  });

  test('summed cost renders without binary float noise', () => {
    const observer = createUsageObserver();
    observer.observeEvent(
      v2Event('step', { sessionID: 'ses_a', input: 1, cost: 0.1 }),
    );
    observer.observeEvent(
      v2Event('step', { sessionID: 'ses_a', input: 1, cost: 0.2 }),
    );
    const totals = formatUsageSummary(observer.describeSession('ses_a')).find(
      (l) => l.includes('observed_totals'),
    );
    expect(totals).toContain('cost=0.3');
    expect(totals).not.toContain('0.30000000000000004');
  });

  test('undefined summary renders the none-observed line', () => {
    const lines = formatUsageSummary(undefined);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('none observed');
  });
});
