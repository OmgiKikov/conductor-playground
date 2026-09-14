import assert from 'node:assert/strict';
import { test } from 'node:test';
import { awaitingVerdict, compareRuns, compareUserModes, evidenceSummary, humanFindings, isAgentFailure, judgeCalibration, repeatResults, simulatorFidelity, verdictSummary } from '../src/comparison.js';
import { assessRepeated, judgeInput } from '../src/judge.js';
import { emptyUsage, fingerprint, settingsSchema, type Experiment, type HumanReview, type MetricAssessment, type Outcome, type Scenario, type TraceEvent, type Trial, type UserMode } from '../src/contracts.js';

/** Sample size at which the verdict is allowed to call itself trusted. */
const TRUSTED = 30;
const world = { records: { r: { t: '0' } }, writableFields: ['t'], transientFailures: 0 };
const metrics = [
  { id: 'goal', name: 'Goal', subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' },
  { id: 'fidelity', name: 'Fidelity', subject: 'simulator' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' },
];
function scenario(id: string): Scenario {
  return { id, familyId: id, title: id, requirementIds: [], provenance: 'curated', user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 1 },
    initialState: world, checks: [{ id: 'time', kind: 'state_equals', description: 'time', recordId: 'r', field: 't', value: '1' }, { id: 'extra', kind: 'tool_called', description: 'x', tool: 'lookup_record' }], metrics, split: 'dev' };
}
function record(overrides: Partial<Experiment> = {}): Experiment {
  return {
    schemaVersion: '1', id: 'exp', task: 't', mode: 'demo', workflow: 'evaluate', createdAt: 'now', updatedAt: 'now', phase: 'results_review', message: '',
    sources: [], settings: settingsSchema.parse({ userModes: ['static', 'scripted', 'reactive'] }), target: { kind: 'sandbox' }, requirements: [], questions: [],
    goldenCases: [], dialogues: [], profiles: [], scenarios: [scenario('s1'), scenario('s2')], revisions: [], selectedRevisionId: null, manifestHash: 'h',
    reviewedAt: null, reviewMode: 'human', controlConsumedAt: null, trials: [], comparisons: [], iterations: [], usage: emptyUsage(), error: null, limitations: [], humanReviews: [],
    ...overrides,
  };
}
/** user messages alternate with assistant replies; `ended` adds a terminal simulator decision after the last exchange. */
function dialogue(userMessages: string[], ended?: 'done' | 'continue'): TraceEvent[] {
  const events: TraceEvent[] = [];
  userMessages.forEach((text, i) => {
    if (i > 0) events.push({ seq: events.length, type: 'simulator', result: { message: text, done: false } });
    events.push({ seq: events.length, type: 'user', text });
    events.push({ seq: events.length, type: 'assistant', text: 'ok' });
  });
  if (ended) events.push({ seq: events.length, type: 'simulator', result: { message: '', done: ended === 'done' } });
  return events;
}
function trial(id: string, scenarioId: string, userMode: UserMode, outcome: Outcome, options: { failed?: string[]; events?: TraceEvent[]; assessments?: MetricAssessment[]; calls?: number; costUsd?: number | null } = {}): Trial {
  const failed = new Set(options.failed ?? []);
  return {
    id, revisionId: 'rev', scenarioId, familyId: scenarioId, repeat: 0, userMode, split: 'dev', manifestHash: 'h', outcome, reason: '',
    checks: ['time', 'extra'].map(check => ({ id: check, description: check, passed: !failed.has(check), evidence: '' })),
    events: options.events ?? dialogue(['hello']), initialState: world, finalState: world,
    usage: { ...emptyUsage(), calls: options.calls ?? 1, costUsd: options.costUsd === undefined ? 0.01 : options.costUsd }, elapsedMs: 1, assessments: options.assessments === undefined ? [{ metricId: 'fidelity', result: 'pass', rationale: 'Fixture simulator follows its card.', evidence: [0] }] : options.assessments,
  };
}
const review = (id: string, trialId: string, verdict: HumanReview['verdict'], target: { metricId?: string; checkId?: string } = {}, createdAt = '2026-09-08T00:00:00Z'): HumanReview => ({ id, trialId, verdict, note: 'n', createdAt, ...target });

test('identical replies with flipped rubric scores require review without rewriting evidence', () => {
  const card = { ...scenario('s1'), checks: [] };
  const a = { ...trial('a', 's1', 'reactive', 'ungraded', {
    assessments: [{ metricId: 'goal', result: 'fail', rationale: 'later refusal', evidence: [1] }],
  }), checks: [] };
  const before = record({ id: 'before', scenarios: [card], trials: [a],
    settings: settingsSchema.parse({ repeats: 1, userModes: ['reactive'] }) });
  const after = structuredClone(before); after.id = 'after';
  after.trials[0]!.id = 'b';
  after.trials[0]!.assessments![0]!.result = 'pass';
  after.trials[0]!.events[0]!.text = 'A differently worded question';
  const original = structuredClone([before, after]);
  const diff = compareRuns(before, after);
  assert.equal(diff.comparable, true);
  assert.equal(diff.pairs[0]?.change, 'unknown', 'a score flip on coincident replies is not an agent fix');
  assert.match(diff.pairs[0]?.reviewNote ?? '', /Ответы агента совпали/);
  assert.match(diff.headline, /Общих оценённых карточек нет/);
  assert.match(diff.headline, /разными оценками: 1\./);
  assert.doesNotMatch(diff.headline, /Исправлено/);
  assert.deepEqual([before, after], original);
  const acrossModes = record({ scenarios: [{ ...card, metrics: card.metrics!.filter(m => m.subject === 'agent') }],
    settings: settingsSchema.parse({ repeats: 1, userModes: ['static', 'scripted'] }),
    trials: [{ ...a, userMode: 'static' }, { ...after.trials[0]!, userMode: 'scripted' }],
  });
  assert.deepEqual(compareUserModes(acrossModes)[0]!.failedChecks, ['s1/metric:goal']);
  assert.deepEqual(compareUserModes(acrossModes)[0]!.uniqueFailedChecks, [],
    'coincident replies with a rubric flip do not establish a mode-specific failure');
  after.trials[0]!.events[1]!.text = 'A changed answer';
  assert.equal(compareRuns(before, after).pairs[0]?.reviewNote, undefined);
  assert.deepEqual(compareUserModes(acrossModes)[0]!.uniqueFailedChecks, ['s1/metric:goal']);
  after.trials[0]!.events = [];
  before.trials[0]!.events = [];
  assert.equal(compareRuns(before, after).pairs[0]?.reviewNote, undefined, 'missing replies are not identical evidence');
});

test('user-mode comparison reports pass rates, turns, cost and the failures only the reactive simulator found', () => {
  const r = record({ trials: [
    trial('a', 's1', 'static', 'fail', { failed: ['time'] }),
    trial('b', 's2', 'static', 'pass'),
    trial('c', 's1', 'scripted', 'pass', { calls: 2 }),
    trial('d', 's2', 'scripted', 'invalid', { costUsd: null }),
    trial('e', 's1', 'reactive', 'fail', { failed: ['time', 'extra'], events: dialogue(['hello', 'again'], 'done'), calls: 4 }),
    trial('f', 's2', 'reactive', 'pass', { events: dialogue(['hi'], 'done'), calls: 3 }),
  ] });
  const modes = compareUserModes(r);
  assert.deepEqual(modes.map(m => m.userMode), ['static', 'scripted', 'reactive']);
  const [stat, scripted, reactive] = modes as [typeof modes[0], typeof modes[0], typeof modes[0]];
  assert.deepEqual([stat.trials, stat.valid, stat.passed, stat.passRate], [2, 2, 1, 0.5]);
  assert.deepEqual([scripted.trials, scripted.valid, scripted.passed, scripted.passRate], [2, 1, 1, 1]);
  assert.equal(scripted.costUsd, null);
  assert.deepEqual([reactive.trials, reactive.valid, reactive.passed, reactive.passRate, reactive.calls], [2, 2, 1, 0.5, 7]);
  assert.deepEqual(stat.failedChecks, ['s1/check:time']);
  assert.deepEqual(stat.uniqueFailedChecks, []);
  assert.deepEqual(reactive.failedChecks, ['s1/check:extra', 's1/check:time']);
  assert.deepEqual(reactive.uniqueFailedChecks, ['s1/check:extra']);
  assert.equal(reactive.avgUserTurns, 1.5);
  assert.equal(stat.avgUserTurns, 1);
  const rubricOnly = compareUserModes(record({ trials: [
    trial('rubric', 's1', 'reactive', 'ungraded', { events: dialogue(['question', 'clarification'], 'answer') }),
    trial('timeout', 's2', 'reactive', 'invalid', { events: dialogue(['question'], '') }),
  ] })).find(m => m.userMode === 'reactive')!;
  assert.equal(rubricOnly.avgUserTurns, 2, 'completed rubric-only dialogues have observable turns; invalid attempts are excluded');
  assert.equal(rubricOnly.passRate, null, 'observing turns does not invent a deterministic score');
  assert.deepEqual(compareUserModes(record()).map(m => [m.userMode, m.trials, m.passRate]), [['static', 0, null], ['scripted', 0, null], ['reactive', 0, null]]);
});

test('judge calibration compares the latest human verdict with model estimates using fail as the positive class', () => {
  const assess = (goal: 'pass' | 'fail' | 'unknown'): MetricAssessment[] => [{ metricId: 'goal', result: goal, rationale: 'r', evidence: goal === 'unknown' ? [] : [1] }, { metricId: 'fidelity', result: 'pass', rationale: 'r', evidence: [1] }];
  const r = record({
    trials: [
      trial('t1', 's1', 'reactive', 'fail', { failed: ['time'], assessments: assess('fail') }),
      trial('t2', 's1', 'reactive', 'pass', { assessments: assess('pass') }),
      trial('t3', 's2', 'reactive', 'pass', { assessments: assess('fail') }),
      trial('t4', 's2', 'reactive', 'pass', { assessments: assess('unknown') }),
    ],
    humanReviews: [
      review('h1', 't1', 'pass', { metricId: 'goal' }, '2026-09-08T00:00:00Z'),
      review('h2', 't1', 'fail', { metricId: 'goal' }, '2026-09-08T01:00:00Z'),
      review('h3', 't2', 'fail', { metricId: 'goal' }),
      review('h4', 't3', 'pass', { metricId: 'goal' }),
      review('h5', 't4', 'fail', { metricId: 'goal' }),
      review('h6', 't3', 'unknown', { metricId: 'fidelity' }),
      review('h7', 't1', 'pass', { checkId: 'time' }),
      review('h8', 't2', 'fail'),
    ],
  });
  const rows = judgeCalibration(r);
  const goal = rows.find(row => row.key === 'goal')!;
  assert.deepEqual([goal.subject, goal.n, goal.tp, goal.fn, goal.fp, goal.tn], ['agent', 3, 1, 1, 1, 0]);
  assert.equal(goal.tpr, 1 / 3, 'unknown stays in the denominator of human-confirmed failures');
  assert.equal(goal.tnr, 0);
  assert.equal(goal.agreement, 1 / 4);
  assert.deepEqual([goal.reviewed, goal.abstained, goal.coverage], [4, 1, 3 / 4]);
  assert.equal(goal.sampleSufficient, false);
  assert.equal(goal.validationStatus, 'not_established');
  const fidelity = rows.find(row => row.key === 'fidelity')!;
  assert.deepEqual([fidelity.subject, fidelity.n, fidelity.tpr, fidelity.tnr, fidelity.agreement], ['simulator', 0, null, null, null]);
  const time = rows.find(row => row.key === 'check:time')!;
  assert.deepEqual([time.subject, time.n, time.fp, time.tn], ['check', 1, 1, 0]);
  assert.equal(rows.some(row => row.key === 'check:extra'), true);
});

test('human agreement separates criterion definitions and judge protocols even when metric IDs match', async () => {
  const a = { ...scenario('s1'), checks: [], metrics: [metrics[0]!] };
  const b = { ...scenario('s2'), checks: [], metrics: [{ ...metrics[0]!, passCriteria: 'A different requirement' }] };
  const r = record({ mode: 'live', scenarios: [a, b], trials: [], humanReviews: [] });
  for (const [i, card, configurationHash] of [[0, a, 'v1'], [1, b, 'v1'], [2, a, 'v2']] as const) {
    const t = trial(`t${i}`, card.id, 'reactive', 'ungraded', { assessments: [] });
    t.assessments = await assessRepeated({ scenario: card, sources: [], trial: t }, { provider: 'offline', id: 'test', configurationHash },
      { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, audit) { t.judgeAudit = audit; } },
      async () => JSON.stringify({ assessments: [{ metricId: 'goal', passCondition: 'met', failCondition: 'not_met', rationale: 'Fixture evidence', evidence: [1], citations: [{ seq: 1, quote: t.events.find(e => e.seq === 1)!.text! }] }] }));
    r.trials.push(t); r.humanReviews.push(review(`h${i}`, t.id, 'pass', { metricId: 'goal' }));
  }
  const rows = judgeCalibration(r);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map(x => x.criterionHash)).size, 2);
  assert.equal(new Set(rows.map(x => x.judgeHash)).size, 2);
  assert.ok(rows.every(x => x.n === 1 && x.tnr === 1 && x.validationStatus === 'not_established'));
  r.trials[0]!.judgeAudit!.attempts[0]!.raw = 'corrupt response';
  const corrupt = judgeCalibration(r).find(x => x.missing)!;
  assert.deepEqual([corrupt.reviewed, corrupt.n, corrupt.missing, corrupt.tnr], [1, 0, 1, 0]);
});

test('sample size cannot certify a judge or hide an absent class and missing assessments', () => {
  const trials = Array.from({ length: 60 }, (_, i) => trial(`t${i}`, 's1', 'reactive', 'pass', {
    assessments: [{ metricId: 'goal', result: 'pass', rationale: 'r', evidence: [1] }],
  }));
  const r = record({ scenarios: [scenario('s1')], trials,
    humanReviews: trials.map((t, i) => review(`h${i}`, t.id, 'pass', { metricId: 'goal' })),
  });
  let goal = judgeCalibration(r).find(x => x.key === 'goal')!;
  assert.equal(goal.n, 60); assert.equal(goal.sampleSufficient, false);
  assert.equal(goal.tpr, null); assert.equal(goal.validationStatus, 'not_established');
  r.humanReviews.slice(0, 30).forEach(h => { h.verdict = 'fail'; });
  r.trials[0]!.assessments = [];
  goal = judgeCalibration(r).find(x => x.key === 'goal')!;
  assert.equal(goal.sampleSufficient, true);
  assert.equal(goal.validationStatus, 'not_established', 'balanced review labels are not held-out validation');
  assert.deepEqual([goal.reviewed, goal.n, goal.missing, goal.tpr, goal.tnr], [60, 59, 1, 0, 1]);
});

test('simulator fidelity compares reactive dialogues with real ones and reports human fidelity verdicts', () => {
  assert.equal(simulatorFidelity(record()), null);
  const r = record({
    dialogues: [
      { id: 'd1', messages: [{ role: 'user', content: 'Hi?' }, { role: 'assistant', content: 'yes' }, { role: 'user', content: 'ok' }], outcome: 'abandoned' },
      { id: 'd2', messages: [{ role: 'user', content: 'hello there' }, { role: 'assistant', content: 'hi' }], outcome: 'success' },
    ],
    trials: [
      trial('a', 's1', 'reactive', 'fail', { events: dialogue(['hi', 'x?'], 'done') }),
      trial('b', 's2', 'reactive', 'pass', { events: dialogue(['hello'], 'done') }),
      trial('c', 's2', 'static', 'pass', { events: dialogue(['ignored static']) }),
      trial('d', 's1', 'reactive', 'invalid', { events: dialogue(['ignored invalid']) }),
    ],
    humanReviews: [review('h1', 'a', 'pass', { metricId: 'fidelity' }), review('h2', 'b', 'fail', { metricId: 'fidelity' }), review('h3', 'b', 'pass', { metricId: 'goal' })],
  });
  const report = simulatorFidelity(r)!;
  assert.deepEqual([report.realDialogues, report.simulatedDialogues], [2, 2]);
  const metric = (name: string) => report.metrics.find(m => m.metric === name)!;
  assert.deepEqual([metric('userTurns').real, metric('userTurns').simulated, metric('userTurns').gap], [1.5, 1.5, 0]);
  assert.equal(metric('userMessageLength').real, (3 + 2 + 11) / 3);
  assert.equal(metric('userMessageLength').simulated, (2 + 2 + 5) / 3);
  assert.equal(metric('questionRate').real, 1 / 3);
  assert.equal(metric('questionRate').simulated, 1 / 3);
  assert.deepEqual([metric('disengagementRate').real, metric('disengagementRate').simulated], [0.5, 0.5]);
  assert.deepEqual(report.humanFidelity, { reviewed: 2, passed: 1 });
  const empty = simulatorFidelity(record({ dialogues: r.dialogues }))!;
  assert.equal(empty.simulatedDialogues, 0);
  assert.equal(empty.metrics.every(m => m.simulated === null && m.gap === null), true);
});

test('evidence summary states observed comparison results plainly and lists what the evidence cannot yet support', () => {
  const evaluate = evidenceSummary(record({ trials: [trial('a', 's1', 'reactive', 'fail', { assessments: [{ metricId: 'goal', result: 'fail', rationale: 'r', evidence: [1] }] })], humanReviews: [review('h', 'a', 'fail', { metricId: 'goal' })] }));
  assert.equal(evaluate.comparison, null);
  assert.equal(evaluate.modes.length, 3);
  assert.ok(evaluate.notes.some(note => /мало примеров одного или обоих классов/.test(note) && /goal/.test(note)));
  assert.ok(evaluate.notes.some(note => /Реальные диалоги не загружены/.test(note)));
  const compare = evidenceSummary(record({ workflow: 'compare', comparisons: [{
    baselineId: 'b', candidateId: 'c', manifestHash: 'h', split: 'control', plannedPairs: 4, validPairs: 4, invalidPairs: 0, families: 2,
    baselinePasses: 1, candidatePasses: 4, fixed: 3, regressed: 0, tied: 1, delta: 0.75, interval: [0.5, 1], verdict: 'insufficient', reasons: ['Only two families.'], cases: [],
  }] }));
  assert.match(compare.comparison!.observed, /3 of 4/);
  assert.match(compare.comparison!.observed, /0 regress/);
  assert.match(compare.comparison!.observed, /0\.75/);
  assert.match(compare.comparison!.status, /insufficient/);
  assert.match(compare.comparison!.status, /Only two families/);
});

test('the verdict says how many dialogues passed, where the agent is weak, how much to trust it and what to do next', () => {
  const failing = (id: string, scenarioId: string, checks: string[], goal: 'pass' | 'fail') => trial(id, scenarioId, 'reactive', checks.length ? 'fail' : 'pass', { failed: checks, assessments: [{ metricId: 'goal', result: goal, rationale: 'r', evidence: [1] }] });
  const synthetic = record({
    scenarios: [scenario('s1'), scenario('s2')].map(s => ({ ...s, provenance: 'synthetic' as const })),
    trials: [failing('a', 's1', ['time'], 'fail'), failing('b', 's1', ['time', 'extra'], 'fail'), failing('c', 's2', [], 'pass'), trial('d', 's2', 'reactive', 'invalid')],
  });
  const verdict = verdictSummary(synthetic);
  assert.deepEqual([verdict.passed, verdict.graded, verdict.passRate], [1, 3, 1 / 3]);
  assert.match(verdict.headline, /1 из 3/);
  assert.deepEqual(verdict.provenance.synthetic, { cards: 2, passed: 1, graded: 3 });
  assert.deepEqual(verdict.provenance.curated, { cards: 0, passed: 0, graded: 0 });
  assert.deepEqual(verdict.weakSpots.map(w => [w.kind, w.description, w.failures]), [['check', 'time', 2], ['metric', 'Goal', 2], ['check', 'extra', 1]]);
  assert.equal(verdict.confidence, 'low');
  assert.ok(verdict.confidenceReasons.some(r => /синтетическ/.test(r.text)));
  assert.ok(verdict.confidenceReasons.some(r => /не удалось измерить/.test(r.text)));
  assert.ok(verdict.nextSteps.some(s => /golden set/.test(s.text)));
  assert.ok(verdict.nextSteps.some(s => /вердикт/.test(s.text)));
  assert.ok(verdict.nextSteps.some(s => /своего агента/.test(s.text)));
  const mixed = record({ mode: 'live',
    scenarios: [{ ...scenario('s1'), provenance: 'curated' as const }, { ...scenario('s2'), provenance: 'production' as const }],
    trials: Array.from({ length: TRUSTED }, (_, i) => failing(`t${i}`, i % 2 ? 's1' : 's2', i < 2 ? ['time'] : [], i < 2 ? 'fail' : 'pass')),
    humanReviews: [review('h1', 't0', 'fail', { metricId: 'goal' }), review('h2', 't1', 'fail')], resultsReviewedAt: '2026-09-09T00:00:00Z', target: { kind: 'module', path: '/agent.mjs', exportName: 'createSession' },
  });
  const trusted = verdictSummary(mixed);
  assert.equal(trusted.confidence, 'low');
  assert.ok(trusted.confidenceReasons.some(r => r.code === 'small_sample'));
  assert.deepEqual([trusted.passed, trusted.graded], [TRUSTED - 2, TRUSTED]);
  assert.equal(trusted.nextSteps.some(s => /своего агента/.test(s.text)), false);
  const partial = verdictSummary({ ...mixed, resultsReviewedAt: undefined, humanReviews: [] });
  assert.equal(partial.confidence, 'low');
  assert.ok(partial.confidenceReasons.some(r => /вердикт/.test(r.text)));
  const empty = verdictSummary(record());
  assert.equal(empty.passRate, null);
  assert.match(empty.headline, /Диалогов с оценкой ещё нет/);
  assert.equal(evidenceSummary(synthetic).verdict.confidence, 'low');
});

test('судья, расходящийся с человеком, назван по имени рубрики, а не спрятан в статистике', () => {
  // 24 пары: судья и человек согласны в 14, расходятся в 10 — это про формулировку рубрики.
  const trials = Array.from({ length: 24 }, (_, i) => trial(`t${i}`, 's1', 'reactive', 'pass', {
    assessments: [{ metricId: 'goal', result: i < 14 ? 'pass' : 'fail', rationale: 'r', evidence: [1] }],
  }));
  const humanReviews = trials.map((t, i) => review(`h${i}`, t.id, 'pass', { metricId: 'goal' }));
  const r = record({ scenarios: [scenario('s1')], trials, humanReviews });
  const evidence = evidenceSummary(r);
  assert.ok(evidence.notes.some(n => /goal.*подтвердил 14 из 24/.test(n)), evidence.notes.join(' | '));
  assert.ok(evidence.verdict.nextSteps.some(n => n.code === 'rewrite_rubric' && n.detail === 'goal'));

  // Согласный судья молчит: подсказка появляется только когда есть о чём говорить.
  const agreeing = record({
    scenarios: [scenario('s1')],
    trials: trials.map(t => ({ ...t, assessments: [{ metricId: 'goal', result: 'pass' as const, rationale: 'r', evidence: [1] }] })),
    humanReviews,
  });
  assert.equal(evidenceSummary(agreeing).verdict.nextSteps.some(n => n.code === 'rewrite_rubric'), false);
});

test('сравнение двух прогонов называет, что починилось и что сломалось, а не среднее', () => {
  let runId = 0;
  const card = (id: string, tier: 'smoke' | 'regression' | 'frontier'): Scenario => ({ ...scenario(id), tier, metrics: [] });
  const run = (results: Record<string, 'pass' | 'fail'>, extra: Partial<Experiment> = {}) => record({
    id: `run-${runId++}`, settings: settingsSchema.parse({ repeats: 1, userModes: ['reactive'] }),
    scenarios: Object.keys(results).map(id => card(id, id === 'basics' ? 'smoke' : 'regression')),
    trials: Object.entries(results).map(([id, outcome], i) => trial(`t${i}_${id}`, id, 'reactive', outcome, { failed: outcome === 'fail' ? ['time'] : [] })),
    ...extra,
  });
  const before = run({ basics: 'pass', tariff: 'fail', refund: 'fail' });
  const after = run({ basics: 'pass', tariff: 'pass', refund: 'fail' });
  const diff = compareRuns(before, after);
  assert.match(diff.headline, /Исправлено 1, сломалось 0/);
  assert.deepEqual(diff.fixed.map(f => f.scenarioId), ['tariff']);
  assert.deepEqual(diff.regressed, []);
  assert.deepEqual(diff.unchanged, { passing: 1, failing: 1 });
  assert.ok(diff.notes.some(n => /может быть случайной/.test(n)), 'малая выборка названа прямо');

  // Улучшение на одной карточке не должно прятать поломку базового поведения.
  const broken = compareRuns(before, run({ basics: 'fail', tariff: 'pass', refund: 'fail' }));
  assert.match(broken.headline, /Исправлено 1, сломалось 1/);
  assert.deepEqual(broken.regressed.map(r => [r.scenarioId, r.tier]), [['basics', 'smoke']]);
  assert.ok(broken.notes.some(n => /дымовых карточек/.test(n)));

  // Несравнимые прогоны признаются несравнимыми.
  const other = compareRuns(before, run({ basics: 'pass', newcard: 'pass' }, { settings: settingsSchema.parse({ repeats: 3 }) }));
  assert.ok(other.notes.some(n => /Набор карточек изменился/.test(n)));
  assert.ok(other.notes.some(n => /повторов отличаются/.test(n)));
  assert.deepEqual(other.cards.onlyBefore.sort(), ['refund', 'tariff']);
  assert.deepEqual(other.cards.onlyAfter, ['newcard']);
});

test('этапы показывают, какое звено сломалось, а провал дымовой карточки роняет доверие', () => {
  const staged = (id: string): Scenario => ({
    ...scenario(id), tier: id === 'smoke_card' ? 'smoke' : 'frontier',
    checks: [{ id: 'time', description: 'Клиент получил ответ', kind: 'answer_contains', value: 'ответ', stage: 'сборка ответа' }],
    metrics: [
      { id: 'compose', name: 'Ответ собран по базе знаний', subject: 'agent', description: 'd', passCriteria: 'p', failCriteria: 'f', stage: 'сборка ответа' },
      { id: 'guard', name: 'Ответ дошёл до клиента', subject: 'agent', description: 'd', passCriteria: 'p', failCriteria: 'f', stage: 'валидация' },
    ],
  });
  // Агент собрал верный ответ и сам его убил валидатором: сквозной вердикт этого не различает.
  const composed = (id: string, scenarioId: string, guard: 'pass' | 'fail'): Trial => trial(id, scenarioId, 'reactive', guard === 'pass' ? 'pass' : 'fail', {
    failed: guard === 'pass' ? [] : ['time'],
    assessments: [{ metricId: 'compose', result: 'pass', rationale: 'r', evidence: [1] }, { metricId: 'guard', result: guard, rationale: 'r', evidence: [2] }],
  });
  const r = record({
    scenarios: [staged('frontier_card'), staged('smoke_card')],
    trials: [composed('t1', 'frontier_card', 'fail'), composed('t2', 'frontier_card', 'fail'), composed('t3', 'smoke_card', 'pass')],
  });
  const v = verdictSummary(r);
  assert.deepEqual(v.stages, [
    { stage: 'валидация', passed: 1, evaluated: 3 },
    { stage: 'сборка ответа', passed: 4, evaluated: 6 },
  ]);
  assert.ok(v.weakSpots.every(w => w.stage), 'каждое слабое место названо этапом');
  assert.ok(v.weakSpots.some(w => w.stage === 'валидация' && w.kind === 'metric'));
  assert.ok(v.nextSteps.some(n => n.code === 'fix_weakest' && /на этапе «/.test(n.text)));
  assert.deepEqual(v.tiers.filter(t => t.cards), [
    { tier: 'smoke', cards: 1, passed: 1, graded: 1 },
    { tier: 'frontier', cards: 1, passed: 0, graded: 2 },
  ]);

  // Дымовая карточка — приоритет исправления; уверенность в измерении остаётся отдельной осью.
  const broken = verdictSummary({ ...r, trials: [...r.trials, composed('t4', 'smoke_card', 'fail')] });
  assert.equal(broken.confidence, 'low');
  assert.ok(broken.nextSteps.some(n => n.code === 'smoke_failed' && n.count === 1));
  assert.equal(broken.confidenceReasons.some(n => n.code === 'smoke_failed'), false);
});

test('rubric failures in dialogues without objective checks still count as weak spots and never earn high confidence', () => {
  const rubricOnly = (id: string, goal: 'pass' | 'fail', fidelity: 'pass' | 'fail' = 'pass'): Trial => ({
    ...trial(id, 's1', 'reactive', 'ungraded', { assessments: [{ metricId: 'goal', result: goal, rationale: 'r', evidence: [1] }, { metricId: 'fidelity', result: fidelity, rationale: 'r', evidence: [1] }] }), checks: [],
  });
  const r = record({
    scenarios: [{ ...scenario('s1'), checks: [], provenance: 'curated' }],
    trials: [rubricOnly('a', 'fail'), rubricOnly('b', 'fail', 'fail'), rubricOnly('c', 'pass')],
    humanReviews: [review('h', 'a', 'fail', { metricId: 'goal' })], resultsReviewedAt: '2026-09-09T00:00:00Z',
  });
  const v = verdictSummary(r);
  assert.deepEqual([v.passed, v.graded], [0, 0]);
  assert.deepEqual(v.rubric, { assessed: 3, passed: 1, failed: 2, unknown: 0 });
  assert.deepEqual(v.weakSpots, [{ kind: 'metric', description: 'Goal', failures: 2 }]);
  assert.match(v.headline, /Объективных проверок нет/);
  assert.match(v.headline, /1 из 3/);
  assert.match(v.headline, /не проверена/);
  assert.notEqual(v.confidence, 'high');
  assert.ok(v.confidenceReasons.some(n => n.code === 'rubric_only'));
  assert.ok(v.confidenceReasons.some(n => n.code === 'simulator_flagged' && n.count === 1));
  assert.equal(v.simulatorFlagged, 1);
  assert.ok(v.nextSteps.some(n => n.code === 'record_verdicts' && n.count === 1));
});

test('high confidence requires human verdicts on every failed dialogue, not just a finalized review', () => {
  const r = record({ mode: 'live',
    scenarios: [{ ...scenario('s1'), provenance: 'curated' }, { ...scenario('s2'), provenance: 'production' }],
    trials: Array.from({ length: TRUSTED }, (_, i) => trial(`t${i}`, i % 2 ? 's1' : 's2', 'reactive', i < 2 ? 'fail' : 'pass', { failed: i < 2 ? ['time'] : [] })),
    resultsReviewedAt: '2026-09-09T00:00:00Z', humanReviews: [],
  });
  const finalizedOnly = verdictSummary(r);
  assert.equal(finalizedOnly.confidence, 'low');
  assert.ok(finalizedOnly.confidenceReasons.some(n => n.code === 'no_human'));
  const partial = verdictSummary({ ...r, humanReviews: [review('h0', 't0', 'fail')] });
  assert.equal(partial.confidence, 'low');
  assert.ok(partial.confidenceReasons.some(n => n.code === 'unreviewed_failures' && n.count === 1));
  assert.ok(partial.nextSteps.some(n => n.code === 'record_verdicts' && n.count === 1));
  const complete = verdictSummary({ ...r, humanReviews: [review('h0', 't0', 'fail'), review('h1', 't1', 'fail')] });
  assert.equal(complete.confidence, 'low');
  assert.equal(complete.nextSteps.some(n => n.code === 'record_verdicts'), false);
});

test('unknown and invalid human verdicts are not decisions: they keep confidence medium and stay listed as undecided', () => {
  const r = record({ mode: 'live',
    scenarios: [{ ...scenario('s1'), provenance: 'curated' }, { ...scenario('s2'), provenance: 'production' }],
    trials: Array.from({ length: TRUSTED }, (_, i) => trial(`t${i}`, i % 2 ? 's1' : 's2', 'reactive', i < 2 ? 'fail' : 'pass', { failed: i < 2 ? ['time'] : [] })),
    resultsReviewedAt: '2026-09-09T00:00:00Z', humanReviews: [review('h0', 't0', 'unknown'), review('h1', 't1', 'invalid', { checkId: 'time' })],
  });
  const undecided = verdictSummary(r);
  assert.equal(undecided.confidence, 'low');
  assert.ok(undecided.confidenceReasons.some(n => n.code === 'no_decisive_verdicts'));
  assert.ok(undecided.nextSteps.some(n => n.code === 'record_verdicts' && n.count === 2));
  const half = verdictSummary({ ...r, humanReviews: [review('h0', 't0', 'fail'), review('h1', 't1', 'unknown')] });
  assert.equal(half.confidence, 'low');
  assert.ok(half.confidenceReasons.some(n => n.code === 'undecided_failures' && n.count === 1));
  assert.ok(half.nextSteps.some(n => n.code === 'record_verdicts' && n.count === 1));
  const decided = verdictSummary({ ...r, humanReviews: [review('h0', 't0', 'fail'), review('h1', 't1', 'unknown'), review('h2', 't1', 'pass', { metricId: 'goal' })] });
  assert.equal(decided.confidence, 'low');
  assert.ok(decided.nextSteps.some(n => n.code === 'record_verdicts' && n.count === 1), 'a passing rubric label does not resolve a failed objective check');
});

test('a revised human verdict counts by its latest value: fail replaced by unknown reopens the dialogue', () => {
  const r = record({ mode: 'live',
    scenarios: [{ ...scenario('s1'), provenance: 'curated' }, { ...scenario('s2'), provenance: 'production' }],
    trials: Array.from({ length: TRUSTED }, (_, i) => trial(`t${i}`, i % 2 ? 's1' : 's2', 'reactive', i < 2 ? 'fail' : 'pass', { failed: i < 2 ? ['time'] : [] })),
    resultsReviewedAt: '2026-09-09T03:00:00Z',
    humanReviews: [review('h0', 't0', 'fail', {}, '2026-09-09T00:00:00Z'), review('h1', 't1', 'fail', {}, '2026-09-09T00:00:00Z'), review('h2', 't1', 'unknown', {}, '2026-09-09T01:00:00Z')],
  });
  const revised = verdictSummary(r);
  assert.equal(revised.confidence, 'low');
  assert.ok(revised.confidenceReasons.some(n => n.code === 'undecided_failures' && n.count === 1));
  assert.ok(revised.nextSteps.some(n => n.code === 'record_verdicts' && n.count === 1));
  const reaffirmed = verdictSummary({ ...r, humanReviews: [...r.humanReviews, review('h3', 't1', 'fail', {}, '2026-09-09T02:00:00Z')] });
  assert.equal(reaffirmed.confidence, 'low');
  const metricOnly = verdictSummary({ ...r, humanReviews: [review('h0', 't0', 'fail'), review('h1', 't1', 'fail', { metricId: 'goal' }, '2026-09-09T00:00:00Z'), review('h2', 't1', 'unknown', { metricId: 'goal' }, '2026-09-09T01:00:00Z')] });
  assert.equal(metricOnly.confidence, 'low');
});

test('confidence needs distinct reviewed situations and complete evidence; demo repetitions never qualify', () => {
  const scenarios = Array.from({ length: TRUSTED }, (_, i) => ({ ...scenario(`s${i}`), metrics: [] }));
  const trials = scenarios.map(s => trial(`t_${s.id}`, s.id, 'reactive', 'pass'));
  const r = record({ mode: 'live', settings: settingsSchema.parse({ repeats: 1, userModes: ['reactive'] }), scenarios, trials,
    resultsReviewedAt: 'now', humanReviews: trials.map(t => review(`h_${t.id}`, t.id, 'pass')) });
  assert.equal(verdictSummary(r).confidence, 'high');
  assert.equal(verdictSummary({ ...r, mode: 'demo' }).confidence, 'low');
  assert.notEqual(verdictSummary({ ...r, trials: trials.slice(1) }).confidence, 'high');
  assert.notEqual(verdictSummary({ ...r, humanReviews: r.humanReviews.slice(0, 1) }).confidence, 'high');
  assert.notEqual(verdictSummary({ ...r, scenarios: scenarios.map(s => ({ ...s, familyId: 'one' })), trials: trials.map(t => ({ ...t, familyId: 'one' })) }).confidence, 'high');
  const smokeFailure = verdictSummary({ ...r,
    scenarios: scenarios.map((s, i) => ({ ...s, tier: i === 0 ? 'smoke' : 'regression' })),
    trials: [{ ...trials[0]!, outcome: 'fail', checks: trials[0]!.checks.map((c, i) => ({ ...c, passed: i !== 0 })) }, ...trials.slice(1)],
    humanReviews: r.humanReviews.map((review, i) => ({ ...review, verdict: i === 0 ? 'fail' : 'pass' })),
  });
  assert.equal(smokeFailure.confidence, 'high', 'a well-reviewed failure is strong evidence of a bad result');
  assert.ok(smokeFailure.nextSteps.some(step => step.code === 'smoke_failed'));
});

test('run differences reject changed cards, missing or duplicate attempts and invalid evidence; rubric-only failures participate', () => {
  const s = { ...scenario('s1'), checks: [], metrics: metrics.filter(m => m.subject === 'agent') };
  const make = (id: string, result: 'pass' | 'fail' | 'unknown') => record({ id, scenarios: [s], settings: settingsSchema.parse({ repeats: 1, userModes: ['reactive'] }),
    trials: [{ ...trial('t', 's1', 'reactive', 'ungraded', { assessments: [{ metricId: 'goal', result, rationale: 'r', evidence: [1] }] }), checks: [] }] });
  const before = make('before', 'fail'); const after = make('after', 'pass'); after.trials[0]!.events[1]!.text = 'The actual improved answer';
  assert.equal(compareRuns(before, after).fixed.length, 1);
  assert.equal(compareRuns(before, after).includesRubrics, true);
  assert.equal(compareRuns(before, make('unknown', 'unknown')).ungraded, 1);
  for (const changed of [
    { ...after, scenarios: [{ ...s, user: { ...s.user, opening: 'easier task' } }] },
    { ...after, trials: [] },
    { ...after, trials: [after.trials[0]!, after.trials[0]!] },
    { ...after, trials: [{ ...after.trials[0]!, outcome: 'invalid' as const }] },
    { ...after, trials: [{ ...after.trials[0]!, manifestHash: 'stale' }] },
    { ...after, phase: 'cancelled' as const },
  ]) { const diff = compareRuns(before, changed); assert.equal(diff.comparable, false); assert.equal(diff.fixed.length, 0); }
  const failed = { ...before, humanReviews: [review('h', 't', 'pass', { metricId: 'fidelity' })] };
  assert.equal(awaitingVerdict(failed).size, 1);
  failed.humanReviews.push(review('h2', 't', 'fail', { metricId: 'goal' }));
  assert.equal(awaitingVerdict(failed).size, 0);
});

test('partial run comparisons pair the same valid attempts and disclose missing evidence without hiding regressions', () => {
  const cards = ['fixed', 'broken', 'unpaired'].map(id => ({ ...scenario(id), metrics: [] }));
  const settings = settingsSchema.parse({ repeats: 2, userModes: ['reactive'] });
  const attempt = (id: string, repeat: number, outcome: Outcome) => ({ ...trial(`${id}_${repeat}`, id, 'reactive', outcome, { failed: outcome === 'fail' ? ['time'] : [] }), repeat,
    ...(outcome === 'invalid' ? { checks: [] } : {}) });
  const before = record({ id: 'before', scenarios: cards, settings, trials: [attempt('fixed', 0, 'fail'), attempt('fixed', 1, 'invalid'), attempt('broken', 0, 'pass'), attempt('broken', 1, 'pass'), attempt('unpaired', 0, 'fail')] });
  const after = record({ id: 'after', scenarios: cards, settings, trials: [attempt('fixed', 0, 'pass'), attempt('fixed', 1, 'fail'), attempt('broken', 0, 'fail'), attempt('broken', 1, 'invalid'), attempt('unpaired', 1, 'pass')] });
  const result = compareRuns(before, after);
  assert.equal(result.comparable, true); assert.match(result.headline, /Частичное сравнение \(2\/6 пар\)/);
  assert.deepEqual(result.fixed.map(c => c.scenarioId), ['fixed']); assert.deepEqual(result.regressed.map(c => c.scenarioId), ['broken']);
  assert.equal(result.ungraded, 1, 'different repeat numbers must never be paired');
  assert.deepEqual(result.coverage, { plannedPairs: 6, validPairs: 2, excludedPairs: 4, invalidBefore: 1, invalidAfter: 1, missingBefore: 1, missingAfter: 1 });
  assert.ok(result.notes.some(n => /Сбои могут скрывать регрессии/.test(n)));
  const tier = result.tiers.find(t => t.tier === 'regression')!;
  assert.equal(tier.before.graded, 2); assert.equal(tier.after.graded, 2, 'stage/tier rates must use the paired sample too');
  const duplicated = compareRuns(before, { ...after, trials: [...after.trials, after.trials[0]!] });
  assert.equal(duplicated.comparable, false); assert.equal(duplicated.fixed.length, 0);
  assert.deepEqual(duplicated.pairs, []);
  assert.deepEqual(result.pairs, [
    { scenarioId: 'broken', userMode: 'reactive', repeat: 0, beforeTrialId: 'broken_0', afterTrialId: 'broken_0', change: 'regressed' },
    { scenarioId: 'fixed', userMode: 'reactive', repeat: 0, beforeTrialId: 'fixed_0', afterTrialId: 'fixed_0', change: 'fixed' },
  ]);
});

test('execution, judgement source and human review describe distinct facts across the run lifecycle', () => {
  const settings = settingsSchema.parse({ repeats: 1, userModes: ['reactive'] });
  const scenarios = [{ ...scenario('s1'), metrics: [] }];
  const base = record({ mode: 'live', scenarios, settings });
  const draft = verdictSummary({ ...base, phase: 'review' });
  assert.equal(draft.nextSteps[0]!.code, 'approve_and_run');
  assert.deepEqual(draft.execution, { planned: 1, completed: 0, invalid: 0, cancelled: 0, missing: 1, running: false });
  assert.equal(draft.review.status, 'not_started');
  const active = verdictSummary({ ...base, phase: 'evaluating' });
  assert.match(active.headline, /Идёт прогон/); assert.equal(active.execution.running, true);
  assert.equal(active.nextSteps[0]!.code, 'wait_for_run');
  const unavailable = verdictSummary({ ...base, trials: [{ ...trial('t', 's1', 'reactive', 'invalid'), reason: 'Cannot start fixture executable', checks: [] }] });
  assert.match(unavailable.headline, /Не удалось измерить.*Cannot start fixture executable/);
  assert.equal(unavailable.nextSteps[0]!.code, 'repair_execution');
  assert.equal(unavailable.nextSteps.some(step => step.code === 'approve_and_run'), false);
  assert.deepEqual(unavailable.execution, { planned: 1, completed: 0, invalid: 1, cancelled: 0, missing: 0, running: false });
  const failed = { ...base, phase: 'complete' as const, resultsReviewedAt: 'old', trials: [trial('t', 's1', 'reactive', 'fail', { failed: ['time'] })] };
  const reviewState = (record: Experiment) => {
    const { status, pending, reviewed, total } = verdictSummary(record).review;
    return { status, pending, reviewed, total };
  };
  assert.deepEqual(reviewState(failed), { status: 'pending', pending: 1, reviewed: 0, total: 1 });
  const reviewed = { ...failed, humanReviews: [review('h', 't', 'fail')] };
  assert.deepEqual(reviewState(reviewed), { status: 'complete', pending: 0, reviewed: 1, total: 1 });
  assert.deepEqual(reviewState({ ...reviewed, humanReviews: [review('h', 't', 'unknown')] }), { status: 'pending', pending: 1, reviewed: 0, total: 1 });
  const rubricOnly = verdictSummary({ ...base, scenarios: [{ ...scenario('s1'), checks: [] }],
    trials: [{ ...trial('t', 's1', 'reactive', 'ungraded', { assessments: [{ metricId: 'goal', result: 'pass', rationale: 'r', evidence: [1] }] }), checks: [] }] });
  assert.deepEqual([rubricOnly.execution.completed, rubricOnly.graded, rubricOnly.rubric.assessed], [1, 0, 1]);
  assert.match(rubricOnly.headline, /Оценка модели.*1 из 1/);
  assert.doesNotMatch(rubricOnly.headline, /Доверие/);
  assert.equal(rubricOnly.confidence, 'low');
});

test('legacy comparison summaries describe selected control evidence without averaging versions or exposing active control', () => {
  const dev = { ...scenario('dev'), metrics: [] };
  const control = { ...scenario('control'), split: 'control' as const, metrics: [] };
  const recordWithVersions = record({ workflow: 'compare', phase: 'complete', controlConsumedAt: 'now', selectedRevisionId: 'candidate',
    scenarios: [dev, control], settings: settingsSchema.parse({ repeats: 1, userModes: ['reactive'] }), trials: [
      { ...trial('base_dev', dev.id, 'reactive', 'fail', { failed: ['time'] }), revisionId: 'baseline' },
      { ...trial('candidate_dev', dev.id, 'reactive', 'pass'), revisionId: 'candidate' },
      { ...trial('base_control', control.id, 'reactive', 'fail', { failed: ['time'] }), revisionId: 'baseline', split: 'control' },
      { ...trial('candidate_control', control.id, 'reactive', 'pass'), revisionId: 'candidate', split: 'control' },
    ] });
  const summary = evidenceSummary(recordWithVersions);
  assert.deepEqual([summary.verdict.passed, summary.verdict.graded], [1, 1]);
  assert.deepEqual(summary.verdict.execution, { planned: 1, completed: 1, invalid: 0, cancelled: 0, missing: 0, running: false });
  assert.deepEqual([summary.modes[0]!.passed, summary.modes[0]!.trials], [1, 1]);
  const active = evidenceSummary({ ...recordWithVersions, phase: 'control',
    trials: recordWithVersions.trials.map(t => t.split === 'control' ? { ...t, outcome: 'fail', checks: t.checks.map(c => ({ ...c, passed: false })) } : t) });
  assert.deepEqual([active.verdict.passed, active.verdict.graded], [1, 1]);
  assert.deepEqual(active.verdict.weakSpots, []);
});

test('human findings surface missed failures and false alarms without rewriting automatic evidence', () => {
  const r = record({ scenarios: [{ ...scenario('s1'), metrics: [] }], trials: [trial('t1', 's1', 'static', 'pass')] });
  const measured = JSON.stringify(r.trials);
  r.humanReviews.push(review('negative', 't1', 'fail'));
  const v = verdictSummary(r);
  assert.match(v.headline, /^Человек отметил проблемы: 1/);
  assert.equal(v.passed, 1);
  assert.equal(v.review.flagged, 1);
  assert.equal(v.review.failed, 1);
  assert.equal(v.review.disagreements, 1);
  assert.equal(v.nextSteps[0]?.code, 'inspect_human_findings');
  assert.equal(JSON.stringify(r.trials), measured);
  assert.equal(isAgentFailure(r, r.trials[0]!), false);
  r.humanReviews.push(review('revised', 't1', 'pass', {}, '2026-09-09T00:00:00Z'));
  assert.deepEqual(humanFindings(r), []);
  r.humanReviews.push(review('specific', 't1', 'fail', { checkId: 'time' }));
  assert.equal(humanFindings(r)[0]?.target, 'time', 'a whole-dialogue pass must not erase a separate criterion finding');
  assert.equal(verdictSummary(r).review.passed, 1);
  r.humanReviews.push(review('unsure', 't1', 'unknown', { checkId: 'time' }, '2026-09-10T00:00:00Z'));
  assert.deepEqual(humanFindings(r), []);
  r.trials[0]!.outcome = 'fail'; r.trials[0]!.checks[0]!.passed = false;
  const falseAlarm = verdictSummary(r);
  assert.equal(falseAlarm.review.flagged, 0);
  assert.equal(falseAlarm.review.disagreements, 1);
  assert.match(falseAlarm.headline, /^Есть расхождения/);
});

test('simulator labels and unmeasured attempts never become automatic agent failures or calibrated disagreements', () => {
  const r = record({ trials: [trial('t1', 's1', 'reactive', 'pass', { assessments: [
    { metricId: 'goal', result: 'pass', rationale: 'r', evidence: [1] },
    { metricId: 'fidelity', result: 'pass', rationale: 'r', evidence: [1] },
  ] })], humanReviews: [review('h1', 't1', 'fail', { metricId: 'fidelity' })] });
  assert.equal(humanFindings(r)[0]?.subject, 'simulator');
  assert.equal(isAgentFailure(r, r.trials[0]!), false);
  assert.equal(verdictSummary(r).review.failed, 0, 'criterion review is not a whole-dialogue verdict');
  r.trials[0]!.outcome = 'cancelled';
  assert.equal(humanFindings(r)[0]?.automatic, 'unknown');
  assert.equal(humanFindings(r)[0]?.disagreement, false);
});

test('repeats reveal mixed cases behind 5/6 and retain missing, unknown and duplicate attempts', () => {
  const scenarios = ['s1', 's2'].map(id => ({ ...scenario(id), metrics: [] }));
  const trials = scenarios.flatMap(s => Array.from({ length: 3 }, (_, repeat) => ({
    ...trial(`${s.id}-${repeat}`, s.id, 'static', s.id === 's2' && repeat === 2 ? 'fail' : 'pass', { failed: s.id === 's2' && repeat === 2 ? ['time'] : [] }), repeat,
  })));
  const r = record({ scenarios, trials, settings: settingsSchema.parse({ repeats: 3, userModes: ['static', 'scripted'] }) });
  const v = verdictSummary(r);
  assert.equal(v.passed, 5); assert.equal(v.graded, 6);
  assert.deepEqual(v.repeats.map(row => [row.status, row.passed, row.failed, row.unknown]), [['all_pass', 3, 0, 0], ['mixed', 2, 1, 0]]);
  assert.equal(v.nextSteps.some(n => n.code === 'inspect_repeats'), true);
  assert.equal(v.repeats.length, 2, 'scripted mode without a script has no planned attempts');
  r.humanReviews = [review('override', 's2-2', 'pass')];
  assert.equal(repeatResults(r)[1]?.status, 'mixed', 'manual verdicts never rewrite repeated automatic results');
  r.trials.pop();
  assert.deepEqual(repeatResults(r)[1]?.unknown, 1);
  assert.equal(repeatResults(r)[1]?.status, 'incomplete');
  r.trials.push({ ...trials[0]!, id: 'duplicate' });
  assert.equal(repeatResults(r)[0]?.status, 'incomplete');
  assert.equal(repeatResults(r)[0]?.unknown, 1);
  r.trials[1]!.outcome = 'invalid';
  assert.equal(repeatResults(r)[0]?.unknown, 2);
  r.settings.repeats = 1; r.settings.userModes = ['static']; r.trials = [trials[0]!];
  assert.equal(repeatResults(r)[0]?.status, 'single');
});

test('comparison opens the repaired repeat before unchanged attempts of the same card', () => {
  const scenarios = [{ ...scenario('s1'), metrics: [] }];
  const settings = settingsSchema.parse({ repeats: 3, userModes: ['static'] });
  const attempts = Array.from({ length: 3 }, (_, repeat) => ({ ...trial(`t${repeat}`, 's1', 'static', repeat === 2 ? 'fail' : 'pass', { failed: repeat === 2 ? ['time'] : [] }), repeat }));
  const before = record({ id: 'before', scenarios, settings, trials: attempts });
  const after = record({ id: 'after', scenarios, settings, trials: attempts.map(t => ({ ...t, id: `new-${t.id}`, outcome: 'pass', checks: t.checks.map(c => ({ ...c, passed: true })) })) });
  const diff = compareRuns(before, after);
  assert.equal(diff.fixed.length, 1);
  assert.deepEqual(diff.pairs.map(p => p.repeat), [2, 0, 1]);
  assert.deepEqual(diff.pairs.map(p => p.change), ['fixed', 'unchanged', 'unchanged']);
});

test('live rubric comparisons require recorded compatible judge protocols and a measured simulator', () => {
  const card = { ...scenario('s1'), checks: [] };
  const before = record({ id: 'before', mode: 'live', scenarios: [card], settings: settingsSchema.parse({ repeats: 1, userModes: ['reactive'] }),
    trials: [{ ...trial('a', 's1', 'reactive', 'ungraded', { assessments: [
      { metricId: 'goal', result: 'fail', rationale: 'Evidence', evidence: [1] },
      { metricId: 'fidelity', result: 'pass', rationale: 'Evidence', evidence: [0] },
    ] }), checks: [] }] });
  const after = structuredClone(before); after.id = 'after'; after.trials[0]!.id = 'b'; after.trials[0]!.events[1]!.text = 'Better answer'; after.trials[0]!.assessments![0]!.result = 'pass';
  assert.equal(compareRuns(before, after).comparable, false, 'legacy single votes cannot establish improvement');
  for (const run of [before, after]) {
    for (const a of run.trials[0]!.assessments!) a.citations = a.evidence.map(seq => ({ seq, quote: run.trials[0]!.events.find(e => e.seq === seq)!.text! }));
    const data = judgeInput({ scenario: card, sources: run.sources, trial: run.trials[0]! });
    run.trials[0]!.judgeAudit = { protocolHash: 'protocol-v1', inputHash: fingerprint(data), provider: 'offline', model: 'judge', prompt: 'prompt', input: JSON.stringify(data),
      attempts: [0, 1].map(() => ({ startedAt: 'now', raw: JSON.stringify({ assessments: run.trials[0]!.assessments!.map(({ result, ...v }) => ({ ...v, passCondition: result === 'pass' ? 'met' : 'not_met', failCondition: result === 'fail' ? 'met' : 'not_met' })) }), assessments: structuredClone(run.trials[0]!.assessments!) })), notApplicable: [] };
  }
  assert.equal(compareRuns(before, after).fixed.length, 1);
  after.trials[0]!.judgeAudit!.protocolHash = 'protocol-v2';
  assert.equal(compareRuns(before, after).comparable, false);
  after.trials[0]!.judgeAudit!.protocolHash = 'protocol-v1';
  after.trials[0]!.assessments = after.trials[0]!.assessments!.filter(a => a.metricId !== 'fidelity');
  const unknown = compareRuns(before, after);
  assert.equal(unknown.fixed.length, 0); assert.equal(unknown.comparable, false);
  assert.equal(verdictSummary(after).simulatorFlagged, 1);
});
