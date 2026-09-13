import { randomUUID } from 'node:crypto';
import {
  emptyUsage, userTurnSchema, scriptIssue, simulatorWasUsed, validateAssessments,
  type CallContext, type CheckResult, type DialogueMessage, type Revision,
  type Runtime, type Scenario, type Settings, type Source, type Target, type TargetSession, type TraceEvent, type Trial, type UserMode,
} from './contracts.js';
import { sandbox } from './sandbox.js';
import { openExternalTarget } from './targets.js';

/*
 * One trial = one fresh world, one target session, one user side.
 *
 *   opening ──► target.respond ──► [static? budget? done?] ──► next user message ──► target.respond ──► ...
 *      │                                   │ reactive: runtime.userTurn                            │
 *      │                                   │ scripted: user.script[turn]                            │
 *      └────────── every message, tool call/result and user decision → trial.events ◄──────────────┘
 *   end ──► grade(checks) over finalState + events ──► outcome ──► optional rubric assessment
 *
 * Target: sandbox = nested model session with trusted tools mutating the world;
 *         http/module = external agent whose reported events/records feed the same grading.
 * Invalid = the harness could not measure the agent. Fail = the agent was measured and fell short.
 */
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

/** Where a failed dialogue broke, in the owner's words. */
const stages: Record<string, string> = {
  'target session': 'открытие сессии с испытуемым',
  'target response': 'ответ испытуемого',
  'user simulation': 'реплика симулированного пользователя',
  assessment: 'оценка по рубрикам',
};

export function grade(scenario: Scenario, trial: Trial): CheckResult[] {
  if (scenario.checks.some(c => c.kind === 'state_equals') && trial.observation?.state === 'missing') {
    throw new Error('Внешний агент не сообщил итоговое состояние. Проверки состояния не измерены.');
  }
  if (scenario.checks.some(c => c.kind.startsWith('tool_') || c.kind === 'fresh_read_before_update') && trial.observation?.tools === 'partial') {
    throw new Error('Адаптер не подтвердил полноту событий инструментов (eventsComplete). Проверки действий не измерены.');
  }
  for (const check of scenario.checks) if (check.kind === 'state_equals') {
    const observed = trial.finalState.records[check.recordId];
    if (!observed || !Object.hasOwn(observed, check.field)) throw new Error(`Не наблюдалось поле ${check.recordId}.${check.field}. Проверка не измерена.`);
    if (trial.observation && trial.observation.state !== 'sandbox' && trial.observation.resetConfirmed !== true) throw new Error('Адаптер не подтвердил сброс исходного состояния (resetConfirmed).');
  }
  const scope = trial.observation?.toolScope;
  if (scope) for (const check of scenario.checks) {
    const tools = check.kind === 'fresh_read_before_update' ? ['lookup_record', 'update_record'] : 'tool' in check ? [check.tool] : [];
    if (tools.some(tool => !scope.some(pattern => pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern))) {
      throw new Error('Проверяемый инструмент не входит в заявленную полную область событий адаптера.');
    }
  }
  const answers = trial.events.filter(e => e.type === 'assistant').map(e => e.text ?? '').join('\n').toLocaleLowerCase();
  return scenario.checks.map(check => {
    let passed: boolean;
    let evidence: string;
    if (check.kind === 'state_equals') {
      const actual = trial.finalState.records[check.recordId]?.[check.field];
      passed = Object.is(actual, check.value);
      evidence = `${check.recordId}.${check.field}: expected ${JSON.stringify(check.value)}, observed ${JSON.stringify(actual)}`;
    } else if (check.kind === 'answer_equals') {
      const last = trial.events.findLast(event => event.type === 'assistant');
      passed = last?.text === check.value;
      evidence = `Последний ответ${last ? ` #${last.seq}` : ' отсутствует'}: ожидается ${JSON.stringify(check.value)}, получено ${JSON.stringify(last?.text)}. Регистр, пробелы и переносы строк значимы.`;
    } else if (check.kind === 'answer_contains' || check.kind === 'answer_omits') {
      const present = answers.includes(check.value.toLocaleLowerCase());
      passed = check.kind === 'answer_contains' ? present : !present;
      evidence = `Assistant transcript ${present ? 'contains' : 'does not contain'} ${JSON.stringify(check.value)}. This is an exact text check, not a semantic judgment.`;
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

export function previewAnswer(scenario: Scenario, answer: string) {
  const checks = scenario.checks.filter(c => c.kind.startsWith('answer_'));
  const trial: Trial = { id: 'preview', revisionId: 'preview', scenarioId: scenario.id, familyId: scenario.familyId,
    userMode: 'static', repeat: 0, split: 'dev', manifestHash: 'preview', outcome: 'ungraded', reason: '', checks: [],
    events: [{ seq: 1, type: 'assistant', text: answer }], initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 0 };
  return { checks: grade({ ...scenario, checks }, trial), unmeasured: [
    ...scenario.checks.filter(c => !checks.includes(c)).map(c => c.description), ...(scenario.metrics ?? []).map(m => m.name),
  ] };
}

export async function evaluateTrial(input: {
  runtime: Runtime; revision: Revision; scenario: Scenario; repeat: number; manifestHash: string;
  sources: Source[]; settings: Settings; ctx: CallContext; userMode: UserMode; target: Target;
  onStage?(stage: 'target' | 'user' | 'assessment'): void;
}): Promise<Trial> {
  const { runtime, revision, scenario, repeat, manifestHash, sources, settings, ctx, userMode, target, onStage } = input;
  const started = performance.now();
  const state = structuredClone(scenario.initialState);
  const trial: Trial = {
    id: randomUUID(), revisionId: revision.id, scenarioId: scenario.id, familyId: scenario.familyId, userMode,
    repeat, split: scenario.split, manifestHash, outcome: 'invalid', reason: '', checks: [], events: [],
    initialState: structuredClone(state), finalState: structuredClone(state), usage: emptyUsage(), elapsedMs: 0,
    observation: { state: target.kind === 'sandbox' ? 'sandbox' : 'missing', tools: target.kind === 'sandbox' ? 'sandbox' : 'complete' },
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
  let stage = 'target session';
  let stopped = false;
  let finalUserReply = false;
  let reportedState = false;
  try {
    ctx.signal.throwIfAborted();
    if (userMode === 'scripted') {
      const issue = scriptIssue(scenario.user, settings.maxTurns);
      if (issue) { stage = 'сценарий теста'; throw new Error(issue); }
    }
    onStage?.('target');
    if (target.kind === 'sandbox') {
      const tools = sandbox(state, sources, emit, localCtx).filter(tool => revision.spec.tools.includes(tool.name));
      session = await runtime.openTarget(structuredClone(revision.spec), structuredClone(sources), tools, localCtx);
    } else {
      let responseCount = 0;
      let usageComplete = true;
      session = await openExternalTarget({ target, sessionId: trial.id, scenarioId: scenario.id, state, history: () => structuredClone(messages), ctx: localCtx,
        onRecords: () => { reportedState = true; },
        onReply(reply) {
          responseCount++;
          const observation = trial.observation!;
          observation.state = typeof reply !== 'string' && reply.records !== undefined ? 'reported' : 'missing';
          if (typeof reply === 'string' || reply.eventsComplete !== true) observation.tools = 'partial';
          if (typeof reply === 'string' || !reply.usage) {
            usageComplete = false;
            if (trial.externalUsage) trial.externalUsage.costUsd = null;
          }
          if (typeof reply === 'string') return;
          if (reply.eventScope) observation.toolScope = observation.toolScope ? observation.toolScope.filter(tool => reply.eventScope!.includes(tool)) : [...reply.eventScope];
          if (reply.sessionId !== undefined && reply.sessionId !== trial.id || reply.turn !== undefined && reply.turn !== responseCount) throw new Error('Адаптер вернул неверный идентификатор сессии или номер хода.');
          if (responseCount === 1) observation.resetConfirmed = reply.resetConfirmed;
          if (reply.version) {
            if (observation.version && observation.version !== reply.version) throw new Error('Версия внешнего агента изменилась внутри диалога.');
            observation.version = reply.version;
          }
          if (reply.usage) {
            const usage = trial.externalUsage ??= emptyUsage();
            usage.calls += reply.usage.calls; usage.inputTokens += reply.usage.inputTokens; usage.outputTokens += reply.usage.outputTokens;
            usage.costUsd = !usageComplete || usage.costUsd === null || reply.usage.costUsd === null ? null : usage.costUsd + reply.usage.costUsd;
          }
        } });
    }
    let userMessage = scenario.user.opening;
    for (let turn = 0; turn < settings.maxTurns; turn += 1) {
      ctx.signal.throwIfAborted();
      append('user', userMessage);
      stage = 'target response';
      onStage?.('target');
      const response = await session.respond(userMessage);
      if (persistenceFailed) throw persistenceError;
      ctx.signal.throwIfAborted();
      if (typeof response !== 'string') throw new Error('Target returned a non-text response');
      append('assistant', response);
      if (!response.trim()) { trial.reason = 'Испытуемый вернул пустой ответ.'; break; }
      if (userMode === 'static' || finalUserReply || (scenario.user.maxFollowUps !== undefined && turn >= scenario.user.maxFollowUps)) { stopped = true; break; }
      if (userMode === 'scripted') {
        const next = scenario.user.script?.[turn];
        if (next === undefined) { stopped = true; break; }
        emit({ type: 'simulator', result: { message: next, done: false, scripted: true } });
        userMessage = next;
        continue;
      }
      stage = 'user simulation';
      onStage?.('user');
      const decision = await runtime.userTurn({ user: structuredClone(scenario.user), messages: structuredClone(messages), turn }, userCtx);
      emit({ type: 'simulator', result: decision });
      const user = userTurnSchema.parse(decision);
      ctx.signal.throwIfAborted();
      if (user.done && !user.message.trim()) { stopped = true; break; }
      userMessage = user.message;
      finalUserReply = user.done;
    }
    trial.finalState = structuredClone(state);
    stage = 'проверка наблюдений';
    trial.checks = grade(scenario, trial);
    const allPassed = trial.checks.length > 0 && trial.checks.every(check => check.passed);
    trial.outcome = !stopped ? 'fail' : trial.checks.length === 0 ? 'ungraded' : allPassed ? 'pass' : 'fail';
    trial.reason ||= !stopped ? 'Разговор не завершился в отведённое число реплик.' : trial.checks.length === 0
      ? 'Диалог дошёл до конца, но объективных проверок в карточке нет: оценки по рубрикам считаются отдельно.'
      : allPassed ? 'Все объективные проверки пройдены.' : 'Часть объективных проверок провалена.';
    if (target.kind !== 'sandbox') {
      trial.reason += reportedState
        ? ' Состояние сообщил сам агент, доверенный код его не наблюдал.'
        : ' Состояние внешний агент не сообщил.';
    }
  } catch (error) {
    if (persistenceFailed) throw persistenceError;
    trial.outcome = ctx.signal.aborted ? 'cancelled' : 'invalid';
    trial.reason = ctx.signal.aborted ? 'Диалог остановлен.' : `${stages[stage] ?? stage}: ${error instanceof Error ? error.message : 'неизвестный сбой'}`;
    emit({ type: 'error', text: trial.reason });
  } finally {
    try { await session?.close(); }
    catch {
      emit({ type: 'error', text: 'Target session cleanup failed' });
      if (trial.outcome !== 'cancelled') { trial.outcome = 'invalid'; trial.reason = 'Не удалось корректно закрыть сессию испытуемого.'; }
    }
    if (ctx.signal.aborted) { trial.outcome = 'cancelled'; trial.reason = 'Диалог остановлен.'; }
    trial.finalState = structuredClone(state);
    trial.elapsedMs = Math.round(performance.now() - started);
    if (persistenceFailed) throw persistenceError;
  }
  if (stopped && ['pass', 'fail', 'ungraded'].includes(trial.outcome) && scenario.metrics?.length) {
    try {
      if (!runtime.assess) throw new Error('Metric assessment is unavailable for this runtime');
      ctx.signal.throwIfAborted();
      onStage?.('assessment');
      trial.assessments = await assessTrial(runtime, scenario, sources, trial, localCtx);
    } catch (error) {
      trial.assessmentError = (ctx.signal.aborted ? 'Metric assessment cancelled' : error instanceof Error ? error.message : 'Metric assessment failed').slice(0, 4000);
    }
    trial.elapsedMs = Math.round(performance.now() - started);
  }
  return trial;
}

/** Shared by live evaluation and reassessment of immutable recorded evidence. */
export async function assessTrial(runtime: Runtime, scenario: Scenario, sources: Source[], trial: Trial, ctx: CallContext) {
  if (!runtime.assess) throw new Error('Metric assessment is unavailable for this runtime');
  const metrics = scenario.metrics ?? [];
  const assessments = validateAssessments(metrics, trial.events, await runtime.assess({
    scenario: structuredClone(scenario), sources: structuredClone(sources), trial: structuredClone(trial),
  }, { ...ctx, onTargetEvent: undefined, onTrace: undefined }));
  ctx.signal.throwIfAborted();
  return assessments.map(assessment => !simulatorWasUsed(trial) && metrics.find(m => m.id === assessment.metricId)?.subject === 'simulator'
    ? { ...assessment, result: 'unknown' as const, evidence: [], rationale: 'Реактивный симулятор не участвовал в этом диалоге; его качество не измерено.' }
    : assessment);
}
