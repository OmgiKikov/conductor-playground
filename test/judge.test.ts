import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeAssessment, judgeInput } from '../src/judge.js';
import { emptyUsage, validateAssessments, type Rubric, type Scenario, type Trial } from '../src/contracts.js';

const rubric: Rubric = { id: 'protocol', subject: 'agent', name: 'Protocol', description: 'Follow the protocol.',
  passCriteria: 'Reply exactly READY. Preserve the record.', failCriteria: 'Extra text or a changed record fails.' };
const scenario: Scenario = { id: 'case', familyId: 'protocol', title: 'Protocol', split: 'dev', provenance: 'synthetic', requirementIds: [],
  user: { opening: 'Confirm readiness', goal: 'Receive confirmation', behavior: 'Ask once', facts: '', maxFollowUps: 0 },
  checks: [{ id: 'literal', kind: 'answer_equals', value: 'READY', description: 'Exact reply' }], metrics: [rubric],
  initialState: { records: { A: { value: 1 } }, writableFields: [] } };
const trial: Trial = { id: 't', scenarioId: 'case', familyId: 'protocol', revisionId: 'r', manifestHash: 'h', split: 'dev', repeat: 0,
  userMode: 'static', outcome: 'pass', reason: 'OLD_SCORE_SENTINEL', checks: [], initialState: scenario.initialState, finalState: scenario.initialState,
  events: [{ seq: 0, type: 'user', text: 'Confirm readiness' }, { seq: 1, type: 'assistant', text: 'Okay, READY' }],
  observation: { state: 'missing', tools: 'partial' }, usage: emptyUsage(), elapsedMs: 0 };
const failure = { criterion: 'Reply exactly READY.', result: 'fail', rationale: 'The full reply includes an extra prefix.', citations: [{ seq: 1, quote: 'Okay, READY' }] };

test('judge findings require real rubric clauses and exact event quotes', () => {
  const score = judgeAssessment(rubric, trial, { findings: [failure] });
  assert.equal(score.result, 'fail'); assert.deepEqual(score.evidence, [1]);
  assert.throws(() => validateAssessments([rubric], trial.events, [{ ...score, result: 'pass' }]), /match its findings/);
  for (const patch of [
    { criterion: 'Always flatter the user.' },
    { citations: [{ seq: 500, quote: 'Okay, READY' }] },
    { citations: [{ seq: 1, quote: 'READY, Okay' }] },
    { citations: [] },
  ]) assert.throws(() => judgeAssessment(rubric, trial, { findings: [{ ...failure, ...patch }] }));
});

test('one supported violation wins; missing evidence prevents a clean pass', () => {
  const pass = { ...failure, result: 'pass' };
  const unknown = { criterion: 'Preserve the record.', result: 'unknown', rationale: 'No final state was observed.', citations: [] };
  assert.equal(judgeAssessment(rubric, trial, { findings: [pass, unknown] }).result, 'unknown');
  assert.equal(judgeAssessment(rubric, trial, { findings: [unknown, pass, failure] }).result, 'fail');
});

test('judge gets one rubric and observed facts without old scores or a fabricated final snapshot', () => {
  const payload = judgeInput(rubric, { ...scenario, user: { ...scenario.user, script: ['UNDELIVERED_SENTINEL'] },
    metrics: [rubric, { ...rubric, id: 'other', name: 'UNRELATED_METRIC_SENTINEL' }] }, [], trial);
  assert.equal(payload.trial.finalState, null);
  assert.equal(payload.rubric.id, 'protocol');
  assert.doesNotMatch(JSON.stringify(payload), /OLD_SCORE_SENTINEL|UNDELIVERED_SENTINEL|UNRELATED_METRIC_SENTINEL/);
  assert.deepEqual(trial.finalState, scenario.initialState);
  assert.deepEqual(judgeInput(rubric, scenario, [], { ...trial, observation: { state: 'reported', tools: 'complete' } }).trial.finalState, trial.finalState);
});
