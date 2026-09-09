import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareUserModes, evidenceSummary, judgeCalibration, simulatorFidelity, verdictSummary } from '../src/comparison.js';
import { emptyUsage, settingsSchema, type Experiment, type HumanReview, type MetricAssessment, type Outcome, type Scenario, type TraceEvent, type Trial, type UserMode } from '../src/contracts.js';

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
    usage: { ...emptyUsage(), calls: options.calls ?? 1, costUsd: options.costUsd === undefined ? 0.01 : options.costUsd }, elapsedMs: 1, assessments: options.assessments,
  };
}
const review = (id: string, trialId: string, verdict: HumanReview['verdict'], target: { metricId?: string; checkId?: string } = {}, createdAt = '2026-09-08T00:00:00Z'): HumanReview => ({ id, trialId, verdict, note: 'n', createdAt, ...target });

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
  assert.deepEqual(stat.failedChecks, ['time']);
  assert.deepEqual(stat.uniqueFailedChecks, []);
  assert.deepEqual(reactive.failedChecks, ['extra', 'time']);
  assert.deepEqual(reactive.uniqueFailedChecks, ['extra']);
  assert.equal(reactive.avgUserTurns, 1.5);
  assert.equal(stat.avgUserTurns, 1);
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
  assert.equal(goal.tpr, 0.5);
  assert.equal(goal.tnr, 0);
  assert.equal(goal.agreement, 1 / 3);
  assert.equal(goal.sufficient, false);
  const fidelity = rows.find(row => row.key === 'fidelity')!;
  assert.deepEqual([fidelity.subject, fidelity.n, fidelity.tpr, fidelity.tnr, fidelity.agreement], ['simulator', 0, null, null, null]);
  const time = rows.find(row => row.key === 'check:time')!;
  assert.deepEqual([time.subject, time.n, time.fp, time.tn], ['check', 1, 1, 0]);
  assert.equal(rows.some(row => row.key === 'check:extra'), true);
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
  assert.ok(evaluate.notes.some(note => /fewer than 60/.test(note) && /goal/.test(note)));
  assert.ok(evaluate.notes.some(note => /real dialogues/i.test(note)));
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
  assert.match(verdict.headline, /1 of 3/);
  assert.deepEqual(verdict.provenance.synthetic, { cards: 2, passed: 1, graded: 3 });
  assert.deepEqual(verdict.provenance.curated, { cards: 0, passed: 0, graded: 0 });
  assert.deepEqual(verdict.weakSpots.map(w => [w.kind, w.description, w.failures]), [['check', 'time', 2], ['metric', 'Goal', 2], ['check', 'extra', 1]]);
  assert.equal(verdict.confidence, 'low');
  assert.ok(verdict.confidenceReasons.some(r => /synthetic/.test(r.text)));
  assert.ok(verdict.confidenceReasons.some(r => /invalid/.test(r.text)));
  assert.ok(verdict.nextSteps.some(s => /golden cases or real dialogues/.test(s.text)));
  assert.ok(verdict.nextSteps.some(s => /verdicts/.test(s.text)));
  assert.ok(verdict.nextSteps.some(s => /your own agent/.test(s.text)));
  const mixed = record({
    scenarios: [{ ...scenario('s1'), provenance: 'curated' as const }, { ...scenario('s2'), provenance: 'production' as const }],
    trials: Array.from({ length: 10 }, (_, i) => failing(`t${i}`, i % 2 ? 's1' : 's2', i < 2 ? ['time'] : [], i < 2 ? 'fail' : 'pass')),
    humanReviews: [review('h1', 't0', 'fail', { metricId: 'goal' }), review('h2', 't1', 'fail')], resultsReviewedAt: '2026-09-09T00:00:00Z', target: { kind: 'module', path: '/agent.mjs', exportName: 'createSession' },
  });
  const trusted = verdictSummary(mixed);
  assert.equal(trusted.confidence, 'high');
  assert.deepEqual([trusted.passed, trusted.graded], [8, 10]);
  assert.equal(trusted.nextSteps.some(s => /your own agent/.test(s.text)), false);
  const partial = verdictSummary({ ...mixed, resultsReviewedAt: undefined, humanReviews: [] });
  assert.equal(partial.confidence, 'medium');
  assert.ok(partial.confidenceReasons.some(r => /human/.test(r.text)));
  const empty = verdictSummary(record());
  assert.equal(empty.passRate, null);
  assert.match(empty.headline, /No graded dialogues/);
  assert.equal(evidenceSummary(synthetic).verdict.confidence, 'low');
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
  assert.match(v.headline, /No objective checks/);
  assert.match(v.headline, /1 of 3/);
  assert.match(v.headline, /unverified/);
  assert.notEqual(v.confidence, 'high');
  assert.ok(v.confidenceReasons.some(n => n.code === 'rubric_only'));
  assert.ok(v.confidenceReasons.some(n => n.code === 'simulator_flagged' && n.count === 1));
  assert.equal(v.simulatorFlagged, 1);
  assert.ok(v.nextSteps.some(n => n.code === 'record_verdicts' && n.count === 1));
});

test('high confidence requires human verdicts on every failed dialogue, not just a finalized review', () => {
  const r = record({
    scenarios: [{ ...scenario('s1'), provenance: 'curated' }, { ...scenario('s2'), provenance: 'production' }],
    trials: Array.from({ length: 10 }, (_, i) => trial(`t${i}`, i % 2 ? 's1' : 's2', 'reactive', i < 2 ? 'fail' : 'pass', { failed: i < 2 ? ['time'] : [] })),
    resultsReviewedAt: '2026-09-09T00:00:00Z', humanReviews: [],
  });
  const finalizedOnly = verdictSummary(r);
  assert.equal(finalizedOnly.confidence, 'medium');
  assert.ok(finalizedOnly.confidenceReasons.some(n => n.code === 'no_human'));
  const partial = verdictSummary({ ...r, humanReviews: [review('h0', 't0', 'fail')] });
  assert.equal(partial.confidence, 'medium');
  assert.ok(partial.confidenceReasons.some(n => n.code === 'unreviewed_failures' && n.count === 1));
  assert.ok(partial.nextSteps.some(n => n.code === 'record_verdicts' && n.count === 1));
  const complete = verdictSummary({ ...r, humanReviews: [review('h0', 't0', 'fail'), review('h1', 't1', 'fail')] });
  assert.equal(complete.confidence, 'high');
  assert.equal(complete.nextSteps.some(n => n.code === 'record_verdicts'), false);
});
