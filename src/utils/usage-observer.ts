/**
 * Usage observer — in-memory, observation-only worker telemetry.
 *
 * Records the *observed* provider/model identity and token counters of
 * every session the process sees (children and parents alike), from
 * events the host already emits — nothing is polled, generated, or
 * inferred from configuration. Data is exposed on demand through
 * `task_status` (usage view) and exists nowhere else.
 *
 * Sample granularity differs by host flavor, and the two v2 usage event
 * types have different meanings (verified against the pinned v2 host
 * source, `packages/core/src/session/projector.ts` +
 * `packages/schema/src/session-event.ts`):
 * - v1: one sample per completed assistant `message.updated`; a
 *   multi-request tool-loop message contributes its message totals once.
 * - v2: one sample per provider-request step — `session.step.ended`
 *   (tokens/cost are per-step deltas), plus `session.step.failed` when
 *   the host attributes usage (cost AND tokens present — the projector's
 *   own rule). `session.usage.updated` is NOT a sample: it publishes the
 *   session row's CUMULATIVE totals, so it is stored separately as the
 *   host snapshot and never summed.
 *
 * Semantics and limits (also documented in docs/tools.md):
 * - Advisory only. No gate, ceiling, cancellation, or model decision may
 *   be derived from these numbers.
 * - Every field is optional and stays `undefined` when the host never
 *   reported it — unavailable is never rendered as zero.
 * - `observed_totals` sums only the distinct requests this process
 *   actually observed. It is not billing, not subscription-quota
 *   consumption, and not the session's active context size; provider
 *   token categories (input/cache/reasoning) do not have identical
 *   semantics across providers. `session_totals` (v2) is the host's own
 *   cumulative snapshot and may include usage from before this process
 *   started observing.
 * - `cost` is the host's own computed estimate from model cost tables
 *   (the v2 host source marks provider-billed amounts as a TODO), not a
 *   provider invoice.
 * - Process-local lifetime. The registry does not survive a host or
 *   plugin process restart; a restart gap renders as "none observed",
 *   never as stale data. (A same-process plugin reload keeps it.)
 * - Dedupe is per session by native identity where the host provides it
 *   (v1 message id; v2 envelope event id `evt_…`), with a content
 *   fallback for reduced hosts — so replays count once. The fallback can
 *   collapse genuinely identical consecutive steps; the identity path
 *   cannot. Beyond 512 remembered fingerprints per session the oldest is
 *   evicted, so a replay of an evicted fingerprint counts again.
 * - Bounded: 256 sessions, least recently observed evicted first;
 *   `session.deleted` evicts immediately.
 * - `observed_model` prefers the latest primary-loop request; title,
 *   compaction, and generate requests (which may use another model) are
 *   shown only when no primary request was observed, labelled by kind.
 *
 * Sources, per host flavor:
 * - v1: native `message.updated` assistant messages (modelID/providerID/
 *   cost/tokens incl. reasoning, once `time.completed` is set).
 * - v2: raw step/usage events (the adapter's synthesized
 *   `message.updated` echoes are skipped by their `v2-usage:` id prefix —
 *   the raw events preserve fields the synthesis zero-fills), plus the
 *   `session.model.request` hook payload for the observed effective
 *   model/variant/kind (recorded by the v2 setup; configured preset
 *   bindings are never treated as observed execution).
 *
 * Cache safety: nothing here feeds prompt assembly. Rendered output
 * lives only in a `task_status` tool result (new conversation content at
 * the payload tail), so timestamps below never touch a cached prefix.
 */

import { isRecord } from './guards';

/** Mirrors the cache-monitor's bounds: bounded memory, oldest eviction. */
export const MAX_TRACKED_SESSIONS = 256;
const MAX_FINGERPRINTS_PER_SESSION = 512;

/** Fields present only when the host actually reported a finite value. */
export interface ObservedRequestTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Observed effective model at request time (v2 `session.model.request`). */
export interface ObservedModelRequest {
  sessionID: string;
  providerID?: string;
  modelID?: string;
  variant?: string;
  /** v2 request kind: primary | compaction | title | generate. */
  kind?: string;
}

/** Host-cumulative usage snapshot (v2 `session.usage.updated`). */
export interface HostUsageSnapshot {
  tokens?: ObservedRequestTokens;
  cost?: number;
  observedAt?: number;
}

/** Structured summary for one session; absent values stay absent. */
export interface UsageSessionSummary {
  sessionID: string;
  /** Distinct observed requests (post-dedupe), not a billing count. */
  observedRequests: number;
  firstObservedAt?: number;
  lastObservedAt?: number;
  latestTokens?: ObservedRequestTokens;
  latestCost?: number;
  /** Model identity carried by the latest v1 assistant message, if any. */
  latestMessageModel?: { providerID?: string; modelID?: string };
  /** Observed model request (v2): the latest primary-loop request, else
   * the latest of any kind (labelled by kind). */
  lastModelRequest?: ObservedModelRequest;
  /** Sums over observed requests; a field is present only if ever observed. */
  totals?: ObservedRequestTokens & { cost?: number };
  /** Latest host-cumulative snapshot (v2), if any. */
  hostTotals?: HostUsageSnapshot;
}

interface SessionUsageState {
  latest?: {
    tokens?: ObservedRequestTokens;
    cost?: number;
    model?: { providerID?: string; modelID?: string };
    observedAt?: number;
  };
  lastModelRequest?: ObservedModelRequest;
  lastPrimaryModelRequest?: ObservedModelRequest;
  hostTotals?: HostUsageSnapshot;
  totals: ObservedRequestTokens & { cost?: number };
  observedRequests: number;
  firstObservedAt?: number;
  lastObservedAt?: number;
  seen: Set<string>;
}

export interface UsageObserver {
  /** Consume one plugin event (v1 native or v2 raw/synthesized). Fail-soft. */
  observeEvent(event: unknown): void;
  /** Record one v2 `session.model.request` observation. Fail-soft. */
  recordModelRequest(event: unknown): void;
  /** Bounded read; `undefined` when nothing was ever observed. */
  describeSession(sessionID: string): UsageSessionSummary | undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function parseTokensShape(
  tokens: Record<string, unknown> | undefined,
  cache: Record<string, unknown> | undefined,
): ObservedRequestTokens {
  const parsed: ObservedRequestTokens = {};
  const input = asFiniteNumber(tokens?.input);
  if (input !== undefined) parsed.input = input;
  const output = asFiniteNumber(tokens?.output);
  if (output !== undefined) parsed.output = output;
  const reasoning = asFiniteNumber(tokens?.reasoning);
  if (reasoning !== undefined) parsed.reasoning = reasoning;
  const cacheRead = asFiniteNumber(cache?.read);
  if (cacheRead !== undefined) parsed.cacheRead = cacheRead;
  const cacheWrite = asFiniteNumber(cache?.write);
  if (cacheWrite !== undefined) parsed.cacheWrite = cacheWrite;
  return parsed;
}

function hasAnyTokenField(tokens: ObservedRequestTokens): boolean {
  return (
    tokens.input !== undefined ||
    tokens.output !== undefined ||
    tokens.reasoning !== undefined ||
    tokens.cacheRead !== undefined ||
    tokens.cacheWrite !== undefined
  );
}

/** ISO string for renderable timestamps only; invalid dates stay absent. */
function safeIso(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Content fallback fingerprint for reduced v2 hosts with no envelope
 * event id: token/cost content plus the step's assistant message id, so
 * repeated replays dedupe while distinct steps usually stay distinct.
 */
function v2ContentFingerprint(
  sessionID: string,
  tokens: ObservedRequestTokens,
  cost: number | undefined,
  assistantMessageID: string | undefined,
): string {
  const f = (value: number | undefined): string =>
    value === undefined ? 'u' : String(value);
  return [
    'v2c',
    sessionID,
    assistantMessageID ?? '',
    f(tokens.input),
    f(tokens.output),
    f(tokens.reasoning),
    f(tokens.cacheRead),
    f(tokens.cacheWrite),
    f(cost),
  ].join(':');
}

interface ParsedUsageSample {
  sessionID: string;
  fingerprint: string;
  tokens: ObservedRequestTokens;
  cost?: number;
  model?: { providerID?: string; modelID?: string };
  observedAt?: number;
}

interface ParsedUsageSnapshot {
  sessionID: string;
  tokens: ObservedRequestTokens;
  cost?: number;
  observedAt?: number;
}

/** v1 native `message.updated` (assistant, completed) → one sample. */
function parseMessageUpdated(
  event: Record<string, unknown>,
): ParsedUsageSample | undefined {
  const properties = isRecord(event.properties) ? event.properties : undefined;
  const info =
    properties && isRecord(properties.info) ? properties.info : undefined;
  if (info?.role !== 'assistant') return undefined;
  if (typeof info.sessionID !== 'string' || typeof info.id !== 'string') {
    return undefined;
  }
  // v2 adapter echo of a raw event this observer already parsed.
  if (info.id.startsWith('v2-usage:')) return undefined;
  const time = isRecord(info.time) ? info.time : undefined;
  if (time?.completed === undefined || time.completed === null) {
    return undefined;
  }
  const tokensRecord = isRecord(info.tokens) ? info.tokens : undefined;
  const cache = isRecord(tokensRecord?.cache) ? tokensRecord.cache : undefined;
  const tokens = parseTokensShape(tokensRecord, cache);
  const cost = asFiniteNumber(info.cost);
  if (!hasAnyTokenField(tokens) && cost === undefined) return undefined;
  const model: { providerID?: string; modelID?: string } = {};
  if (typeof info.providerID === 'string') model.providerID = info.providerID;
  if (typeof info.modelID === 'string') model.modelID = info.modelID;
  return {
    sessionID: info.sessionID,
    fingerprint: `v1:${info.id}`,
    tokens,
    ...(cost !== undefined ? { cost } : {}),
    ...(model.providerID !== undefined || model.modelID !== undefined
      ? { model }
      : {}),
    observedAt: asFiniteNumber(time.completed),
  };
}

/**
 * v2 raw step events → one per-request sample each.
 * `session.step.ended` attributes usage unconditionally;
 * `session.step.failed` only when cost AND tokens are present (the
 * host projector's own attribution rule). Dedupe prefers the envelope
 * event id (`evt_…`), which is unique per published event.
 */
function parseStepEvent(
  event: Record<string, unknown>,
  type: string,
): ParsedUsageSample | undefined {
  const payload = isRecord(event.data)
    ? event.data
    : isRecord(event.properties)
      ? event.properties
      : undefined;
  if (!payload || typeof payload.sessionID !== 'string') return undefined;
  const tokensRecord = isRecord(payload.tokens) ? payload.tokens : undefined;
  const cache = isRecord(tokensRecord?.cache) ? tokensRecord.cache : undefined;
  const tokens = parseTokensShape(tokensRecord, cache);
  const cost = asFiniteNumber(payload.cost);
  if (!hasAnyTokenField(tokens) && cost === undefined) return undefined;
  if (
    type === 'session.step.failed' &&
    (cost === undefined || !hasAnyTokenField(tokens))
  ) {
    return undefined;
  }
  const assistantMessageID =
    typeof payload.assistantMessageID === 'string'
      ? payload.assistantMessageID
      : undefined;
  const envelopeID = typeof event.id === 'string' ? event.id : undefined;
  const hostTime =
    asFiniteNumber(payload.timestamp) ?? asFiniteNumber(payload.activityAt);
  return {
    sessionID: payload.sessionID,
    fingerprint: envelopeID
      ? `v2:${envelopeID}`
      : v2ContentFingerprint(
          payload.sessionID,
          tokens,
          cost,
          assistantMessageID,
        ),
    tokens,
    ...(cost !== undefined ? { cost } : {}),
    observedAt: hostTime ?? asFiniteNumber(event.created),
  };
}

/** v2 `session.usage.updated` → host-cumulative snapshot (never summed). */
function parseUsageSnapshot(
  event: Record<string, unknown>,
): ParsedUsageSnapshot | undefined {
  const payload = isRecord(event.data)
    ? event.data
    : isRecord(event.properties)
      ? event.properties
      : undefined;
  if (!payload || typeof payload.sessionID !== 'string') return undefined;
  const tokensRecord = isRecord(payload.tokens) ? payload.tokens : undefined;
  const cache = isRecord(tokensRecord?.cache) ? tokensRecord.cache : undefined;
  const tokens = parseTokensShape(tokensRecord, cache);
  const cost = asFiniteNumber(payload.cost);
  if (!hasAnyTokenField(tokens) && cost === undefined) return undefined;
  const hostTime =
    asFiniteNumber(payload.timestamp) ?? asFiniteNumber(payload.activityAt);
  return {
    sessionID: payload.sessionID,
    tokens,
    ...(cost !== undefined ? { cost } : {}),
    observedAt: hostTime ?? asFiniteNumber(event.created),
  };
}

/** `session.deleted` arrives in both v1 and v2 (adapted) spellings. */
function deletedSessionID(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== 'session.deleted') return undefined;
  const candidates: unknown[] = [];
  const properties = isRecord(event.properties) ? event.properties : undefined;
  const info =
    properties && isRecord(properties.info) ? properties.info : undefined;
  if (info) candidates.push(info.id);
  if (properties) candidates.push(properties.sessionID);
  if (isRecord(event.data)) candidates.push(event.data.sessionID);
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return undefined;
}

function addTotal(
  totals: ObservedRequestTokens & { cost?: number },
  field: keyof (ObservedRequestTokens & { cost?: number }),
  value: number | undefined,
): void {
  if (value === undefined) return;
  totals[field] = (totals[field] ?? 0) + value;
}

export function createUsageObserver(): UsageObserver {
  const sessions = new Map<string, SessionUsageState>();

  function getState(sessionID: string): SessionUsageState {
    const existing = sessions.get(sessionID);
    if (existing) {
      // LRU touch: Map iteration is insertion-ordered, so re-inserting on
      // every observation keeps eviction at the least recently observed
      // session instead of the earliest created one.
      sessions.delete(sessionID);
      sessions.set(sessionID, existing);
      return existing;
    }
    if (sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    const state: SessionUsageState = {
      totals: {},
      observedRequests: 0,
      seen: new Set(),
    };
    sessions.set(sessionID, state);
    return state;
  }

  function observe(sample: ParsedUsageSample): void {
    const state = getState(sample.sessionID);
    if (state.seen.has(sample.fingerprint)) return;
    if (state.seen.size >= MAX_FINGERPRINTS_PER_SESSION) {
      // Bounded memory: evict the oldest remembered fingerprint (Set
      // iteration is insertion-ordered). Recent replays still dedupe;
      // only a replay of an evicted fingerprint counts again.
      const oldest = state.seen.values().next().value;
      if (oldest !== undefined) state.seen.delete(oldest);
    }
    state.seen.add(sample.fingerprint);
    state.observedRequests += 1;
    addTotal(state.totals, 'input', sample.tokens.input);
    addTotal(state.totals, 'output', sample.tokens.output);
    addTotal(state.totals, 'reasoning', sample.tokens.reasoning);
    addTotal(state.totals, 'cacheRead', sample.tokens.cacheRead);
    addTotal(state.totals, 'cacheWrite', sample.tokens.cacheWrite);
    addTotal(state.totals, 'cost', sample.cost);
    // Latest = newest timestamped sample; ties and missing timestamps
    // fall back to arrival order.
    const currentAt = state.latest?.observedAt;
    if (
      !state.latest ||
      sample.observedAt === undefined ||
      currentAt === undefined ||
      sample.observedAt >= currentAt
    ) {
      state.latest = {
        tokens: sample.tokens,
        ...(sample.cost !== undefined ? { cost: sample.cost } : {}),
        ...(sample.model ? { model: sample.model } : {}),
        ...(sample.observedAt !== undefined
          ? { observedAt: sample.observedAt }
          : {}),
      };
    }
    const at = sample.observedAt;
    if (at !== undefined) {
      state.firstObservedAt =
        state.firstObservedAt === undefined
          ? at
          : Math.min(state.firstObservedAt, at);
      state.lastObservedAt =
        state.lastObservedAt === undefined
          ? at
          : Math.max(state.lastObservedAt, at);
    }
  }

  return {
    observeEvent(event: unknown): void {
      try {
        const deleted = deletedSessionID(event);
        if (deleted) {
          sessions.delete(deleted);
          return;
        }
        if (!isRecord(event) || typeof event.type !== 'string') return;
        if (event.type === 'message.updated') {
          const sample = parseMessageUpdated(event);
          if (sample) observe(sample);
          return;
        }
        if (
          event.type === 'session.step.ended' ||
          event.type === 'session.step.failed'
        ) {
          const sample = parseStepEvent(event, event.type);
          if (sample) observe(sample);
          return;
        }
        if (event.type === 'session.usage.updated') {
          const snapshot = parseUsageSnapshot(event);
          if (snapshot) {
            const state = getState(snapshot.sessionID);
            // Cumulative snapshots are monotonic: keep the newest by host
            // time so a delayed older snapshot cannot regress the display.
            const currentAt = state.hostTotals?.observedAt;
            if (
              currentAt !== undefined &&
              snapshot.observedAt !== undefined &&
              snapshot.observedAt < currentAt
            ) {
              return;
            }
            state.hostTotals = {
              ...(snapshot.tokens && hasAnyTokenField(snapshot.tokens)
                ? { tokens: snapshot.tokens }
                : {}),
              ...(snapshot.cost !== undefined ? { cost: snapshot.cost } : {}),
              ...(snapshot.observedAt !== undefined
                ? { observedAt: snapshot.observedAt }
                : {}),
            };
          }
        }
      } catch {
        // Observation only — never let telemetry break event handling.
      }
    },

    recordModelRequest(event: unknown): void {
      try {
        if (!isRecord(event)) return;
        const sessionID = event.sessionID;
        if (typeof sessionID !== 'string' || !sessionID) return;
        const model = isRecord(event.model) ? event.model : undefined;
        const request: ObservedModelRequest = {
          sessionID,
          ...(typeof model?.providerID === 'string'
            ? { providerID: model.providerID }
            : {}),
          ...(typeof model?.id === 'string' ? { modelID: model.id } : {}),
          ...(typeof model?.variant === 'string'
            ? { variant: model.variant }
            : {}),
          ...(typeof event.kind === 'string' ? { kind: event.kind } : {}),
        };
        const state = getState(sessionID);
        state.lastModelRequest = request;
        // The worker's effective model is the primary loop's; a missing
        // kind (reduced host) is treated as primary rather than dropped.
        if (request.kind === undefined || request.kind === 'primary') {
          state.lastPrimaryModelRequest = request;
        }
      } catch {
        // Observation only.
      }
    },

    describeSession(sessionID: string): UsageSessionSummary | undefined {
      const state = sessions.get(sessionID);
      if (
        !state ||
        (state.observedRequests === 0 &&
          !state.lastModelRequest &&
          !state.hostTotals)
      ) {
        return undefined;
      }
      const modelRequest =
        state.lastPrimaryModelRequest ?? state.lastModelRequest;
      return {
        sessionID,
        observedRequests: state.observedRequests,
        ...(state.firstObservedAt !== undefined
          ? { firstObservedAt: state.firstObservedAt }
          : {}),
        ...(state.lastObservedAt !== undefined
          ? { lastObservedAt: state.lastObservedAt }
          : {}),
        ...(state.latest?.tokens ? { latestTokens: state.latest.tokens } : {}),
        ...(state.latest?.cost !== undefined
          ? { latestCost: state.latest.cost }
          : {}),
        ...(state.latest?.model
          ? { latestMessageModel: state.latest.model }
          : {}),
        ...(modelRequest ? { lastModelRequest: modelRequest } : {}),
        ...(state.observedRequests > 0 ? { totals: state.totals } : {}),
        ...(state.hostTotals ? { hostTotals: state.hostTotals } : {}),
      };
    },
  };
}

let sharedObserver: UsageObserver | undefined;

/**
 * Process-wide instance: observation lifetime equals process lifetime
 * (a same-process plugin reload keeps it; a process restart clears it).
 */
export function getUsageObserver(): UsageObserver {
  if (!sharedObserver) sharedObserver = createUsageObserver();
  return sharedObserver;
}

/** Strip binary float noise from summed USD estimates (0.1 + 0.2 → 0.3). */
function tidyCost(value: number): number {
  return Number.parseFloat(value.toPrecision(12));
}

function tokenFieldsOf(
  tokens: ObservedRequestTokens & { cost?: number },
): Array<[string, number]> {
  const fields: Array<[string, number]> = [];
  if (tokens.input !== undefined) fields.push(['input', tokens.input]);
  if (tokens.output !== undefined) fields.push(['output', tokens.output]);
  if (tokens.reasoning !== undefined)
    fields.push(['reasoning', tokens.reasoning]);
  if (tokens.cacheRead !== undefined)
    fields.push(['cache_read', tokens.cacheRead]);
  if (tokens.cacheWrite !== undefined)
    fields.push(['cache_write', tokens.cacheWrite]);
  if (tokens.cost !== undefined) fields.push(['cost', tidyCost(tokens.cost)]);
  return fields;
}

/**
 * Render one session's summary as compact task_status lines. `undefined`
 * renders the explicit none-observed line (a restart gap or a session
 * with no observed usage — unavailable, not zero).
 */
export function formatUsageSummary(
  summary: UsageSessionSummary | undefined,
): string[] {
  if (!summary) {
    return [
      'observed_usage: none observed for this session in this process (advisory telemetry resets when the process restarts)',
    ];
  }
  const lines = [
    'observed_usage: advisory, process-local; not billing, subscription quota, or active context size',
  ];
  const model = summary.lastModelRequest ?? summary.latestMessageModel;
  if (
    model &&
    (model.modelID !== undefined || model.providerID !== undefined)
  ) {
    const parts: string[] = [];
    parts.push(`${model.providerID ?? '?'}/${model.modelID ?? '?'}`);
    if ('variant' in model && model.variant)
      parts.push(`variant: ${model.variant}`);
    if ('kind' in model && model.kind) parts.push(`kind: ${model.kind}`);
    lines.push(`  observed_model: ${parts.join(', ')}`);
  }
  if (summary.latestTokens) {
    const latest = { ...summary.latestTokens, cost: summary.latestCost };
    const fields = tokenFieldsOf(latest);
    if (fields.length > 0) {
      lines.push(
        `  latest_request: ${fields
          .map(([name, value]) => `${name}=${value}`)
          .join(' ')}`,
      );
    }
  }
  if (summary.totals && summary.observedRequests > 0) {
    const since = safeIso(summary.firstObservedAt);
    const window = since ? ` since ${since}` : '';
    const fields = tokenFieldsOf(summary.totals);
    const totalsText =
      fields.length > 0
        ? fields.map(([name, value]) => `${name}=${value}`).join(' ')
        : 'no token fields reported';
    lines.push(
      `  observed_totals: ${summary.observedRequests} observed request(s)${window}: ${totalsText}`,
    );
  }
  if (summary.hostTotals) {
    const snapshot = {
      ...summary.hostTotals.tokens,
      cost: summary.hostTotals.cost,
    };
    const fields = tokenFieldsOf(snapshot);
    const asOf = safeIso(summary.hostTotals.observedAt);
    if (fields.length > 0) {
      lines.push(
        `  session_totals (host snapshot${asOf ? ` at ${asOf}` : ''}): ${fields
          .map(([name, value]) => `${name}=${value}`)
          .join(
            ' ',
          )} — host cumulative, may include usage from before this process`,
      );
    }
  }
  return lines;
}
