import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessRepeated, hasCompleteJudgment, judgeInput, JUDGE_PROTOCOL } from '../src/judge.js';
import { auditJudge, repeatability } from '../src/judge-audit.js';
import { emptyUsage, settingsSchema, simulatorFidelity, type JudgeAudit, type Runtime, type Scenario, type Trial } from '../src/contracts.js';
import { ExperimentStore } from '../src/store.js';

const scenario: Scenario = { id: 'card', familyId: 'family', title: 'A fixed input', split: 'dev', provenance: 'synthetic', requirementIds: [],
  user: { goal: 'Receive an instruction', facts: 'Known facts', behavior: 'Stop after the instruction', opening: 'Help', maxFollowUps: 0 },
  checks: [], initialState: { records: {}, writableFields: [], transientFailures: 0 },
  metrics: [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'Original task', passCriteria: 'Instruction supplied', failCriteria: 'A refusal is supplied' }, simulatorFidelity] };
const trial: Trial = { id: 'trial', revisionId: 'revision', scenarioId: 'card', familyId: 'family', repeat: 0, split: 'dev', userMode: 'static', manifestHash: 'manifest',
  outcome: 'ungraded', reason: 'PRIOR_VERDICT_SECRET', checks: [], events: [{ seq: 0, type: 'user', text: 'Help' }, { seq: 1, type: 'assistant', text: 'Do this.' }],
  initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1 };
const input = { scenario, sources: [], trial };
const model = { provider: 'offline', id: 'test' };
const row = (passCondition: string, failCondition: string, evidence = [1]) => JSON.stringify({ assessments: [{ metricId: 'goal', passCondition, failCondition, rationale: 'Explicit evidence for both conditions.', evidence, citations: evidence.map(seq => ({ seq, quote: 'Do this.' })) }] });

test('judgment retains raw independent votes, rejects conflicting criteria, and never treats nonreactive fidelity as a pass', async () => {
  for (const [outputs, expected] of [
    [[row('met', 'not_met'), row('met', 'not_met')], 'pass'],
    [[row('not_met', 'met'), row('not_met', 'met')], 'fail'],
    [[row('met', 'met'), row('met', 'met')], 'unknown'],
    [[row('not_met', 'not_met'), row('not_met', 'not_met')], 'unknown'],
    [[row('met', 'not_met'), row('not_met', 'met')], 'unknown'],
  ] as const) {
    let audit: JudgeAudit | undefined;
    const requests: string[] = [];
    const original = structuredClone(input);
    const result = await assessRepeated(input, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, a) { audit = a; } },
      async (prompt, data) => { assert.doesNotMatch(data, /PRIOR_VERDICT_SECRET/); requests.push(prompt + data); return outputs[requests.length - 1]!; });
    assert.equal(result[0]!.result, expected);
    assert.equal(result[1]!.result, 'unknown'); assert.match(result[1]!.rationale, /Не применяется/);
    assert.equal(requests[0], requests[1]); assert.equal(audit!.protocolHash, JUDGE_PROTOCOL);
    assert.deepEqual(audit!.attempts.map(a => a.raw), outputs);
    assert.deepEqual(audit!.notApplicable, ['user_fidelity']); assert.deepEqual(input, original);
    const recorded = { ...input, trial: { ...trial, assessments: result, judgeAudit: audit } };
    assert.equal(hasCompleteJudgment(recorded), true);
    recorded.trial.judgeAudit = structuredClone(audit);
    recorded.trial.judgeAudit!.attempts[0]!.raw = 'not the saved model response';
    assert.equal(hasCompleteJudgment(recorded), false, 'cached verdicts cannot replace the original model output');
    recorded.trial.judgeAudit = structuredClone(audit);
    recorded.trial.judgeAudit!.attempts[0]!.assessments![0]!.evidence = [999];
    assert.equal(hasCompleteJudgment(recorded), false, 'a cached vote cannot introduce evidence absent from the original response');
    recorded.trial.judgeAudit = structuredClone(audit);
    recorded.trial.judgeAudit!.attempts[0]!.input = '{}';
    assert.equal(hasCompleteJudgment(recorded), false, 'each rubric request is checked against the frozen evidence');
    recorded.trial.judgeAudit = structuredClone(audit);
    for (const attempt of recorded.trial.judgeAudit!.attempts) { delete attempt.metricId; delete attempt.input; }
    assert.equal(hasCompleteJudgment(recorded), true, 'legacy two-vote receipts remain inspectable');
  }
});

test('malformed, unsupported and invented judgments cannot escape validation or be repaired silently', async () => {
  for (const raw of ['not json', row('met', 'not_met', [999]), row('met', 'not_met', []),
    row('met', 'not_met').replace('Do this.', 'Fabricated quotation.'), '{"assessments":[]}']) {
    let audit: JudgeAudit | undefined;
    let calls = 0;
    await assert.rejects(assessRepeated(input, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, a) { audit = a; } }, async () => { calls++; return raw; }), /Judge response rejected/);
    assert.equal(calls, 2); assert.equal(audit!.attempts[0]!.raw, raw); assert.ok(audit!.attempts.every(a => a.error));
  }
});

test('judge input withholds case labels, prior grades, unobserved state and undelivered static follow-ups', () => {
  const data = judgeInput({ ...input, scenario: { ...scenario, id: 'EXPECTED_FAIL', title: 'EXPECTED_FAIL',
    user: { ...scenario.user, script: ['UNDELIVERED'], maxFollowUps: 1 } },
    trial: { ...trial, outcome: 'fail', finalState: { ...trial.finalState, records: { SECRET_STATE: { time: '11:00' } } } } });
  assert.doesNotMatch(JSON.stringify(data), /EXPECTED_FAIL|PRIOR_VERDICT_SECRET|UNDELIVERED|SECRET_STATE/);
  assert.equal(data.trial.finalState, null);
  assert.deepEqual(data.scenario.user.script, []);
});

test('journal failure stops judgment before another request and original replies survive store reopening', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'judge-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ExperimentStore(directory); await store.init();
  let calls = 0;
  try {
    await assert.rejects(assessRepeated(input, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(id, a) {
      store.appendJudgment('run', id, a);
      if (a.attempts.some(v => v.raw)) throw new Error('disk failed');
    } }, async () => { calls++; return row('met', 'not_met'); }), /disk failed/);
    assert.equal(calls, 1);
  } finally { await store.close(); }
  const journal = await new ExperimentStore(directory).traceJournal('run');
  assert.equal(JSON.parse(journal.trim().split('\n').at(-1)!).judgeAudit.attempts[0].raw, row('met', 'not_met'));
});

test('repeatability counts unknown flips, separates disjoint pairs, and keeps errors out of the success denominator', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'judge-audit-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const audits: JudgeAudit[] = [];
  let calls = 0;
  const runtime = { async assess(value, ctx) { return assessRepeated(value, model, ctx, async () => {
    ctx.beforeCall(); calls++;
    if (calls === 3) throw new Error('Provider unavailable');
    return calls === 2 ? row('not_met', 'met') : row('met', 'not_met');
  }); } } as Runtime;
  await auditJudge([input], settingsSchema.parse({ maxCalls: 5, maxDurationMs: 5000 }), join(parent, 'audit'), 3, runtime);
  const result = JSON.parse(await readFile(join(parent, 'audit/statistics.json'), 'utf8'));
  assert.equal(result.usage.calls, 5); assert.equal(result.failures.length, 1); assert.equal(result.complete, false);
  const journal = (await readFile(join(parent, 'audit/responses.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  const latest = new Map(journal.map(r => [r.repeat, r.audit]));
  audits.push(...latest.values() as Iterable<JudgeAudit>);
  const stats = repeatability(audits);
  assert.equal(stats.errors, 1);
  assert.equal(stats.groups[0]!.n, 4); assert.equal(stats.groups[0]!.disagreed, 3);
  assert.equal(stats.groups[0]!.disagreement, 0.5); assert.equal(stats.groups[0]!.disjointPairs, 2); assert.equal(stats.groups[0]!.disjointFlips, 1);
  await assert.rejects(auditJudge([input], settingsSchema.parse({}), join(parent, 'audit'), 1, runtime), /EEXIST/);
});

test('reactive fidelity applies to actual simulator decisions, including a decision to stop, not to the fixed opening', async () => {
  for (const invoked of [false, true]) {
    let audit: JudgeAudit | undefined;
    const requests: string[][] = [];
    const value = { ...input, trial: { ...trial, userMode: 'reactive' as const,
      events: invoked ? [...trial.events, { seq: 2, type: 'simulator' as const, result: { done: true, message: '' } }] : trial.events } };
    const result = await assessRepeated(value, model, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, a) { audit = a; } }, async (_prompt, data) => {
      const ids = JSON.parse(data).scenario.metrics.map((m: { id: string }) => m.id);
      assert.equal(ids.length, 1, 'each model call assesses exactly one rubric'); requests.push(ids);
      const answer = JSON.parse(row('met', 'not_met'));
      if (ids[0] === 'user_fidelity') answer.assessments[0] = { ...answer.assessments[0], metricId: 'user_fidelity', evidence: [2], citations: [{ seq: 2, quote: '"done":true' }] };
      return JSON.stringify(answer);
    });
    assert.deepEqual(requests, invoked ? [['goal'], ['goal'], ['user_fidelity'], ['user_fidelity']] : [['goal'], ['goal']]);
    assert.equal(result[1]!.result, invoked ? 'pass' : 'unknown');
    assert.deepEqual(audit!.notApplicable, invoked ? [] : ['user_fidelity']);
    assert.equal(hasCompleteJudgment({ ...value, trial: { ...value.trial, judgeAudit: audit, assessments: result } }), true);
  }
});

test('a broken judge stops after three failed batches and leaves a complete account of unfinished work', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'judge-unavailable-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const runtime = { async assess(value, ctx) { return assessRepeated(value, model, ctx, async () => {
    ctx.beforeCall(); throw new Error('Provider unavailable');
  }); } } as Runtime;
  await auditJudge([input], settingsSchema.parse({ maxCalls: 20, maxDurationMs: 5000 }), join(parent, 'audit'), 10, runtime);
  const result = JSON.parse(await readFile(join(parent, 'audit/statistics.json'), 'utf8'));
  assert.equal(result.usage.calls, 3); assert.equal(result.failures.length, 3);
  assert.equal(result.completedBatches, 3); assert.equal(result.plannedBatches, 10);
  assert.equal(result.complete, false); assert.equal(result.ready, false);
  assert.match(result.stoppedBecause, /Three consecutive/);
});
