import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  emptyUsage, fingerprint, scalarSchema, userTurnSchema, metricAssessmentSchema,
  type CallContext, type CheckResult, type Comparison, type DialogueMessage, type Revision,
  type Runtime, type Scenario, type Settings, type Source, type TargetSession, type Tool, type TraceEvent, type Trial, type World,
} from './contracts.js';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v));
const queryArgs = z.strictObject({ query: z.string().trim().min(1).max(1000) });
const lookupArgs = z.strictObject({ recordId: identifier });
const updateArgs = z.strictObject({ recordId: identifier, changes: z.record(identifier, scalarSchema) })
  .refine(v => Object.keys(v.changes).length > 0 && Object.keys(v.changes).length <= 16, 'Supply 1–16 changed fields');
const objectParameters = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const stringParameter = { type: 'string', minLength: 1, maxLength: 1000 };

function sandbox(state: World, sources: Source[], push: (event: Omit<Trial['events'][number], 'seq'>) => void, ctx: CallContext): Tool[] {
  function tool(name: Tool['name'], description: string, parameters: Tool['parameters'], execute: (args: unknown) => unknown): Tool {
    return { name, description, parameters, async execute(args) {
      ctx.signal.throwIfAborted();
      push({ type: 'tool_call', tool: name, args, state });
      let result: unknown;
      try { result = execute(args); }
      catch (error) { result = { ok: false, error: error instanceof z.ZodError ? 'Invalid tool arguments' : error instanceof Error ? error.message : 'Tool failed', retryable: false }; }
      push({ type: 'tool_result', tool: name, result, state });
      return structuredClone(result);
    } };
  }
  return [
    tool('search_materials', 'Search the supplied business policy materials. Returns source IDs and matching text.',
      objectParameters({ query: stringParameter }, ['query']), raw => {
        const { query } = queryArgs.parse(raw);
        const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const matches = sources.map(source => {
          const lower = source.content.toLocaleLowerCase();
          const index = Math.min(...words.map(w => lower.indexOf(w)).filter(i => i >= 0));
          return { sourceId: source.id, name: source.name, content: Number.isFinite(index) ? source.content.slice(Math.max(0, index - 200), index + 1800) : '', matched: Number.isFinite(index) };
        }).filter(m => m.matched).slice(0, 8).map(({ matched: _matched, ...match }) => match);
        return { ok: true, matches };
      }),
    tool('lookup_record', 'Read an existing sandbox record by its exact ID. Never invent a missing record.',
      objectParameters({ recordId: stringParameter }, ['recordId']), raw => {
        const { recordId } = lookupArgs.parse(raw);
        if (!Object.hasOwn(state.records, recordId)) return { ok: false, error: 'Record not found', retryable: false };
        return { ok: true, recordId, record: state.records[recordId] };
      }),
    tool('update_record', 'Update existing, explicitly writable fields in an existing record. Retry retryable errors; a failed result made no record changes.',
      objectParameters({ recordId: stringParameter, changes: { type: 'object', minProperties: 1, maxProperties: 16, additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } } }, ['recordId', 'changes']), raw => {
        const { recordId, changes } = updateArgs.parse(raw);
        const record = Object.hasOwn(state.records, recordId) ? state.records[recordId] : undefined;
        if (!record) return { ok: false, error: 'Record not found', retryable: false };
        if (Object.keys(changes).some(field => !state.writableFields.includes(field) || !Object.hasOwn(record, field))) {
          return { ok: false, error: 'A field does not exist or is not writable; no changes applied', retryable: false };
        }
        if (state.transientFailures > 0) {
          state.transientFailures -= 1;
          return { ok: false, error: 'Temporary update failure; retry is safe', retryable: true };
        }
        Object.assign(record, changes);
        return { ok: true, recordId, record };
      }),
  ];
}

function freshReadEvidence(events: TraceEvent[]): { passed: boolean; evidence: string } {
  const fresh = new Set<string>();
  const violations: string[] = [];
  let updates = 0;
  let pending: { tool?: string; recordId?: string; seq: number } | undefined;
  for (const event of events) {
    if (event.type === 'tool_call') {
      if (pending) violations.push(`Call at event ${pending.seq} has no paired result before event ${event.seq}`);
      const recordId = event.args && typeof event.args === 'object' && 'recordId' in event.args && typeof event.args.recordId === 'string' ? event.args.recordId : undefined;
      pending = { tool: event.tool, recordId, seq: event.seq };
      if (event.tool === 'update_record') {
        updates += 1;
        if (!recordId || !fresh.has(recordId)) violations.push(`Update at event ${event.seq} (${recordId ?? 'missing record ID'}) has no successful fresh lookup of that record`);
      }
    } else if (event.type === 'tool_result') {
      if (!pending || pending.tool !== event.tool) {
        violations.push(`Result at event ${event.seq} has no matching sequential call`);
      } else if (event.result && typeof event.result === 'object' && 'ok' in event.result && event.result.ok === true
        && (event.tool === 'lookup_record' || event.tool === 'update_record')) {
        if (!pending.recordId || !('recordId' in event.result) || event.result.recordId !== pending.recordId) {
          violations.push(`Successful result at event ${event.seq} does not identify the called record`);
        } else if (event.tool === 'lookup_record') fresh.add(pending.recordId);
        else fresh.delete(pending.recordId);
      }
      pending = undefined;
    }
  }
  if (pending) violations.push(`Call at event ${pending.seq} has no paired result`);
  return {
    passed: violations.length === 0,
    evidence: violations.length ? violations.join('; ') : updates
      ? `${updates} update attempt(s) each followed a successful lookup of the same record since its last successful update. Failed retries retained the read.`
      : 'No update attempts; the read-before-update constraint was not exercised.',
  };
}

function grade(scenario: Scenario, trial: Trial): CheckResult[] {
  const answers = trial.events.filter(e => e.type === 'assistant').map(e => e.text ?? '').join('\n').toLocaleLowerCase();
  return scenario.checks.map(check => {
    let passed: boolean;
    let evidence: string;
    if (check.kind === 'state_equals') {
      const actual = trial.finalState.records[check.recordId]?.[check.field];
      passed = Object.is(actual, check.value);
      evidence = `${check.recordId}.${check.field}: expected ${JSON.stringify(check.value)}, observed ${JSON.stringify(actual)}`;
    } else if (check.kind === 'answer_contains') {
      passed = answers.includes(check.value.toLocaleLowerCase());
      evidence = `Assistant transcript ${passed ? 'contains' : 'does not contain'} ${JSON.stringify(check.value)}. This is an exact text check, not a semantic judgment.`;
    } else if (check.kind === 'fresh_read_before_update') {
      ({ passed, evidence } = freshReadEvidence(trial.events));
    } else {
      const count = trial.events.filter(e => e.type === 'tool_call' && e.tool === check.tool).length;
      passed = check.kind === 'tool_count' ? count >= check.min && count <= check.max : check.kind === 'tool_called' ? count > 0 : count === 0;
      evidence = `${check.tool} was attempted ${count} time(s)${check.kind === 'tool_count' ? `; permitted range is ${check.min}–${check.max}, including failed/rejected attempts` : ''}`;
    }
    return { id: check.id, description: check.description, passed, evidence };
  });
}

export async function evaluateTrial(input: {
  runtime: Runtime; revision: Revision; scenario: Scenario; repeat: number; manifestHash: string;
  sources: Source[]; settings: Settings; ctx: CallContext;
}): Promise<Trial> {
  const { runtime, revision, scenario, repeat, manifestHash, sources, settings, ctx } = input;
  const started = performance.now();
  const state = structuredClone(scenario.initialState);
  const trial: Trial = {
    id: randomUUID(), revisionId: revision.id, scenarioId: scenario.id, familyId: scenario.familyId,
    repeat, split: scenario.split, manifestHash, outcome: 'invalid', reason: '', checks: [], events: [],
    initialState: structuredClone(state), finalState: structuredClone(state), usage: emptyUsage(), elapsedMs: 0,
  };
  const localCtx: CallContext = {
    ...ctx,
    beforeCall() { ctx.signal.throwIfAborted(); ctx.beforeCall(); trial.usage.calls += 1; },
    addUsage(usage) {
      ctx.addUsage(usage);
      trial.usage.inputTokens += usage.inputTokens;
      trial.usage.outputTokens += usage.outputTokens;
      trial.usage.costUsd = usage.costUsd === null || trial.usage.costUsd === null ? null : trial.usage.costUsd + usage.costUsd;
    },
  };
  const messages: DialogueMessage[] = [];
  let persistenceError: unknown;
  let persistenceFailed = false;
  const emit = (event: Omit<Trial['events'][number], 'seq'>) => {
    const snapshot = { ...structuredClone(event), seq: trial.events.length };
    trial.events.push(snapshot);
    try { ctx.onTrace?.(trial.id, structuredClone(snapshot)); }
    catch (error) { persistenceFailed = true; persistenceError = error; throw error; }
  };
  localCtx.onTargetEvent = emit;
  const userCtx = { ...localCtx, onTargetEvent: undefined };
  const append = (role: 'user' | 'assistant', content: string) => {
    messages.push({ role, content });
    emit({ type: role, text: content });
  };
  let session: TargetSession | undefined;
  let stage = 'target initialization';
  let stopped = false;
  let finalUserReply = false;
  try {
    ctx.signal.throwIfAborted();
    const tools = sandbox(state, sources, emit, localCtx).filter(tool => revision.spec.tools.includes(tool.name));
    session = await runtime.openTarget(structuredClone(revision.spec), structuredClone(sources), tools, localCtx);
    let userMessage = scenario.user.opening;
    for (let turn = 0; turn < settings.maxTurns; turn += 1) {
      ctx.signal.throwIfAborted();
      append('user', userMessage);
      stage = 'target response';
      const response = await session.respond(userMessage);
      if (persistenceFailed) throw persistenceError;
      ctx.signal.throwIfAborted();
      if (typeof response !== 'string') throw new Error('Target returned a non-text response');
      append('assistant', response);
      if (!response.trim()) { trial.reason = 'Target produced an empty response'; break; }
      if (finalUserReply || (scenario.user.maxFollowUps !== undefined && turn >= scenario.user.maxFollowUps)) { stopped = true; break; }
      stage = 'user simulation';
      const decision = await runtime.userTurn({ user: structuredClone(scenario.user), messages: structuredClone(messages), turn }, userCtx);
      emit({ type: 'simulator', result: decision });
      const user = userTurnSchema.parse(decision);
      ctx.signal.throwIfAborted();
      if (user.done && !user.message.trim()) { stopped = true; break; }
      userMessage = user.message;
      finalUserReply = user.done;
    }
    trial.finalState = structuredClone(state);
    trial.checks = grade(scenario, trial);
    const allPassed = trial.checks.length > 0 && trial.checks.every(check => check.passed);
    trial.outcome = !stopped ? 'fail' : trial.checks.length === 0 ? 'ungraded' : allPassed ? 'pass' : 'fail';
    trial.reason ||= !stopped ? 'Conversation did not complete within the target turn limit' : trial.checks.length === 0
      ? 'Dialogue completed without objective checks; rubric assessments are separate' : allPassed ? 'All objective checks passed' : 'One or more objective checks failed';
  } catch (error) {
    if (persistenceFailed) throw persistenceError;
    trial.outcome = ctx.signal.aborted ? 'cancelled' : 'invalid';
    trial.reason = ctx.signal.aborted ? 'Trial cancelled' : `${stage}: ${error instanceof Error ? error.message : 'Unknown failure'}`;
    emit({ type: 'error', text: trial.reason });
  } finally {
    try { await session?.close(); }
    catch {
      emit({ type: 'error', text: 'Target session cleanup failed' });
      if (trial.outcome !== 'cancelled') { trial.outcome = 'invalid'; trial.reason = 'Target session cleanup failed'; }
    }
    if (ctx.signal.aborted) { trial.outcome = 'cancelled'; trial.reason = 'Trial cancelled'; }
    trial.finalState = structuredClone(state);
    trial.elapsedMs = Math.round(performance.now() - started);
    if (persistenceFailed) throw persistenceError;
  }
  if (stopped && ['pass', 'fail', 'ungraded'].includes(trial.outcome) && scenario.metrics?.length) {
    try {
      if (!runtime.assess) throw new Error('Metric assessment is unavailable for this runtime');
      ctx.signal.throwIfAborted();
      const assessments = z.array(metricAssessmentSchema).parse(await runtime.assess({
        scenario: structuredClone(scenario), sources: structuredClone(sources), trial: structuredClone(trial),
      }, { ...localCtx, onTargetEvent: undefined, onTrace: undefined }));
      ctx.signal.throwIfAborted();
      const metricIds = new Set(scenario.metrics.map(metric => metric.id));
      if (metricIds.size !== scenario.metrics.length || assessments.length !== metricIds.size
        || new Set(assessments.map(a => a.metricId)).size !== metricIds.size || assessments.some(a => !metricIds.has(a.metricId))) {
        throw new Error('Assessment must cover every requested metric exactly once');
      }
      const eventIds = new Set(trial.events.map(event => event.seq));
      for (const assessment of assessments) {
        if (assessment.evidence.some(seq => !eventIds.has(seq))) throw new Error(`Assessment ${assessment.metricId} cites a nonexistent trace event`);
        if (assessment.result !== 'unknown' && assessment.evidence.length === 0) throw new Error(`Assessment ${assessment.metricId} needs trace evidence for pass/fail`);
      }
      trial.assessments = assessments;
    } catch (error) {
      trial.assessmentError = (ctx.signal.aborted ? 'Metric assessment cancelled' : error instanceof Error ? error.message : 'Metric assessment failed').slice(0, 4000);
    }
    trial.elapsedMs = Math.round(performance.now() - started);
  }
  return trial;
}

function clusterInterval(values: number[], seed: string): [number, number] | null {
  if (values.length < 2) return null;
  let state = 2166136261;
  for (const c of seed) state = Math.imul(state ^ c.charCodeAt(0), 16777619) >>> 0;
  state ||= 1;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const means: number[] = [];
  for (let i = 0; i < 4000; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) sum += values[Math.floor(random() * values.length)]!;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [means[99]!, means[3899]!];
}

export function compareTrials(input: {
  baselineId: string; candidateId: string; manifestHash: string; scenarios: Scenario[]; repeats: number;
  trials: Trial[]; split: 'dev' | 'control'; mode: 'demo' | 'live';
}): Comparison {
  const { baselineId, candidateId, manifestHash, repeats, split } = input;
  const scenarios = input.scenarios.filter(s => s.split === split);
  const validRepeats = Number.isInteger(repeats) && repeats >= 1 && repeats <= 5;
  const result: Comparison = {
    baselineId, candidateId, manifestHash, split, plannedPairs: validRepeats ? scenarios.length * repeats : 0, validPairs: 0,
    invalidPairs: 0, families: 0, baselinePasses: 0, candidatePasses: 0, fixed: 0, regressed: 0, tied: 0,
    delta: null, interval: null, verdict: 'insufficient', reasons: [], cases: [],
  };
  if (!validRepeats) return { ...result, verdict: 'incomparable', reasons: ['Repeats must be an integer from 1 to 5.'] };
  const relevant = input.trials.filter(t => (t.revisionId === baselineId || t.revisionId === candidateId) && t.split === split);
  const scenarioMap = new Map(scenarios.map(s => [s.id, s]));
  const initialStates = new Map(scenarios.map(s => [s.id, fingerprint(s.initialState)]));
  const seenTrialIds = new Set<string>();
  const trialMap = new Map<string, Trial[]>();
  let incompatible = scenarios.length !== scenarioMap.size;
  if (incompatible) result.reasons.push('Invalid or duplicate planned cases/repeats');
  for (const trial of relevant) {
    const scenario = scenarioMap.get(trial.scenarioId);
    if (seenTrialIds.has(trial.id)) incompatible = true;
    seenTrialIds.add(trial.id);
    if (!scenario || trial.familyId !== scenario.familyId || trial.manifestHash !== manifestHash || fingerprint(trial.initialState) !== initialStates.get(trial.scenarioId)
      || !Number.isInteger(trial.repeat) || trial.repeat < 0 || trial.repeat >= repeats) {
      incompatible = true;
      continue;
    }
    const key = `${trial.revisionId}:${trial.scenarioId}:${trial.repeat}`;
    const trials = trialMap.get(key) ?? [];
    trials.push(trial);
    trialMap.set(key, trials);
    if (trials.length > 1) incompatible = true;
  }
  if (incompatible) result.reasons.push('Reused/duplicate trials, unknown cases, or mismatched manifest/family/initial-state/repeat prevent a comparable experiment');
  const families = new Map<string, number[]>();
  for (const scenario of scenarios) {
    const row = { scenarioId: scenario.id, baselinePasses: 0, candidatePasses: 0, repeats };
    const deltas: number[] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const base = trialMap.get(`${baselineId}:${scenario.id}:${repeat}`);
      const candidate = trialMap.get(`${candidateId}:${scenario.id}:${repeat}`);
      if (base?.length !== 1 || candidate?.length !== 1 || !['pass', 'fail'].includes(base[0]!.outcome) || !['pass', 'fail'].includes(candidate[0]!.outcome)) continue;
      const a = Number(base[0]!.outcome === 'pass');
      const b = Number(candidate[0]!.outcome === 'pass');
      result.validPairs += 1;
      result.baselinePasses += a;
      result.candidatePasses += b;
      row.baselinePasses += a;
      row.candidatePasses += b;
      if (b > a) result.fixed += 1;
      else if (b < a) result.regressed += 1;
      else result.tied += 1;
      deltas.push(b - a);
    }
    result.cases.push(row);
    if (deltas.length > 0) {
      const group = families.get(scenario.familyId) ?? [];
      group.push(deltas.reduce((sum, d) => sum + d, 0) / deltas.length);
      families.set(scenario.familyId, group);
    }
  }
  result.invalidPairs = result.plannedPairs - result.validPairs;
  const familyDeltas = [...families.values()].map(values => values.reduce((sum, v) => sum + v, 0) / values.length);
  result.families = familyDeltas.length;
  const positiveFamilies = familyDeltas.filter(delta => delta > 0).length;
  // With no regressions, the two-sided paired sign test has p = 2 / 2^positiveFamilies.
  const signP = positiveFamilies ? Math.min(1, 2 ** (1 - positiveFamilies)) : 1;
  if (familyDeltas.length) {
    result.delta = familyDeltas.reduce((sum, d) => sum + d, 0) / familyDeltas.length;
    result.interval = clusterInterval(familyDeltas, manifestHash);
  }
  result.reasons.push('Delta weights scenario families equally; 95% percentile interval resamples whole families. Repeats do not create independent families.');
  if (input.mode === 'demo') result.reasons.push('Scripted offline demonstration: observed repairs do not establish model quality or real-user performance.');
  else result.reasons.push('Synthetic user evidence does not establish performance with real users.');
  if (incompatible) result.verdict = 'incomparable';
  else if (result.invalidPairs > 0 || result.plannedPairs === 0) {
    result.verdict = 'insufficient';
    result.reasons.push(`${result.invalidPairs} planned pair(s) are missing, invalid, or cancelled; positive improvement claims are blocked.`);
  } else if (result.regressed > 0) {
    result.verdict = 'regressed';
    result.reasons.push('At least one previously passing trial now fails; conservative selection rejects this revision.');
  } else if (result.fixed === 0) result.verdict = 'no_change';
  else if (split === 'dev' || input.mode === 'demo' || result.families < 8 || signP > 0.05 || !result.interval || result.interval[0] <= 0) {
    result.verdict = 'insufficient';
    result.reasons.push('Observed fixes are descriptive; confirmation requires final control evaluation in live mode, at least eight independent families, a positive interval lower bound, and a two-sided paired sign-test p ≤ 0.05.');
    if (split === 'dev') result.reasons.push('Development data guides candidate selection; its uncertainty estimates are descriptive and cannot confirm an improvement independently.');
  } else {
    result.verdict = 'improved';
    result.reasons.push(`The no-regression family sign test has two-sided p = ${signP.toPrecision(3)} (ties excluded). This assumes independent case families.`);
  }
  return result;
}
