import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createInputSchema, draftPatchSchema, emptyUsage, validateFailureModes, experimentSchema, goalToScenario, goldenCaseSchema, goldenToScenario, observedGoalSchema, observedProfileSchema, profileSchema, settingsSchema, targetSchema, validatePreparation,
  type Profile,
} from '../src/contracts.js';

const source = { id: 'source-1', name: 'policy', content: 'Rule one: read before update.', hash: 'h' };
const requirement = { id: 'req_1', text: 'Read before update', sourceId: 'source-1', quote: 'read before update', critical: true };
const agent = { name: 'A', instructions: 'Do the thing.', tools: ['lookup_record' as const] };
const metric = { id: 'm', name: 'M', subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' };
const user = { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 0, persona: 'P', characteristics: ['c'] };
function card(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1', familyId: 'f1', title: 'Card', requirementIds: ['req_1'], provenance: 'synthetic' as const, successCriteria: 'ok',
    user, initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [], metrics: [metric], ...overrides,
  };
}
const preparation = (scenarios: unknown[]) => ({ requirements: [requirement], questions: [], agent, scenarios });

test('target schema accepts sandbox, absolute module paths and env-var header names only', () => {
  assert.ok(targetSchema.safeParse({ kind: 'sandbox' }).success);
  assert.equal(targetSchema.safeParse({ kind: 'module', path: 'relative/agent.mjs' }).success, false);
  assert.ok(targetSchema.safeParse({ kind: 'module', path: '/abs/agent.mjs' }).success);
  assert.equal(targetSchema.safeParse({ kind: 'http', url: 'http://127.0.0.1:1/agent', headersEnv: { Authorization: 'not a var' } }).success, false);
  const http = targetSchema.parse({ kind: 'http', url: 'http://127.0.0.1:1/agent', headersEnv: { Authorization: 'AGENT_TOKEN' } });
  assert.equal(http.kind === 'http' ? http.timeoutMs : 0, 60000);
  assert.equal(targetSchema.safeParse({ kind: 'http', url: 'http://127.0.0.1:1/agent', headers: { Authorization: 'secret' } }).success, false);
});

test('golden cases become curated scenarios that keep their checks, metrics and script', () => {
  const golden = goldenCaseSchema.parse({
    id: 'gold_1', goal: 'Block a lost card', opening: 'I lost my card', successCriteria: 'The card is blocked',
    script: ['The last four digits are 1234.'],
    initialState: { records: { card_1: { status: 'active' } }, writableFields: ['status'], transientFailures: 0 },
    checks: [{ id: 'blocked', kind: 'state_equals', description: 'Card blocked', recordId: 'card_1', field: 'status', value: 'blocked' }],
  });
  const scenario = goldenToScenario(golden);
  assert.equal(scenario.provenance, 'curated');
  assert.equal(scenario.id, 'gold_1');
  assert.equal(scenario.title, 'Block a lost card');
  assert.deepEqual(scenario.requirementIds, []);
  assert.equal(scenario.checks.length, 1);
  assert.deepEqual(scenario.user.script, ['The last four digits are 1234.']);
  assert.equal(scenario.user.maxFollowUps, 1);
  assert.equal(scenario.successCriteria, 'The card is blocked');
  assert.equal(golden.behavior.length > 0, true);
});

test('old experiment files load with defaults for workflow, human reviews, target, imports and trial user mode', () => {
  const settings = settingsSchema.parse({});
  const legacy = {
    schemaVersion: '1', id: 'legacy', task: 'task', mode: 'demo', createdAt: 'now', updatedAt: 'now', phase: 'complete', message: 'm',
    sources: [], settings: { ...settings, userModes: undefined }, requirements: [], questions: [], scenarios: [], revisions: [], selectedRevisionId: null,
    manifestHash: null, reviewedAt: null, controlConsumedAt: null, comparisons: [], iterations: [], usage: emptyUsage(), error: null, limitations: [],
    trials: [{ id: 't1', revisionId: 'r', scenarioId: 's', familyId: 'f', repeat: 0, split: 'dev', manifestHash: 'h', outcome: 'pass', reason: '', checks: [], events: [],
      initialState: { records: {}, writableFields: [], transientFailures: 0 }, finalState: { records: {}, writableFields: [], transientFailures: 0 }, usage: emptyUsage(), elapsedMs: 1 }],
  };
  delete (legacy.settings as { userModes?: unknown }).userModes;
  const parsed = experimentSchema.parse(legacy);
  assert.equal(parsed.workflow, 'compare');
  assert.deepEqual(parsed.humanReviews, []);
  assert.deepEqual(parsed.target, { kind: 'sandbox' });
  assert.deepEqual([parsed.goldenCases, parsed.dialogues, parsed.profiles], [[], [], []]);
  assert.deepEqual(parsed.settings.userModes, ['reactive']);
  assert.equal(parsed.trials[0]!.userMode, 'reactive');
});

test('synthetic cards need grounded requirements; curated and production cards do not', () => {
  assert.throws(() => validatePreparation(preparation([card({ requirementIds: [] })]), [source], 'evaluate'), /requirement/i);
  const curated = validatePreparation(preparation([card({ requirementIds: [], provenance: 'curated', user: { ...user, persona: undefined, characteristics: undefined } })]), [source], 'evaluate');
  assert.equal(curated.scenarios[0]!.provenance, 'curated');
  const production = validatePreparation(preparation([card({ requirementIds: [], provenance: 'production' })]), [source], 'evaluate');
  assert.equal(production.scenarios[0]!.provenance, 'production');
});

test('linked profiles supply persona text while unlinked cards need no persona', () => {
  const profiles: Profile[] = [{ id: 'observed_1', persona: 'Observed customer', characteristics: ['Short messages'], observedStyle: '12 chars avg', evidenceDialogueIds: ['d1'] }];
  const plain = validatePreparation(preparation([card({ user: { ...user, persona: undefined, characteristics: undefined } })]), [source], 'evaluate', profiles);
  assert.equal(plain.scenarios[0]!.user.persona, undefined);
  assert.throws(() => validatePreparation(preparation([card({ profileId: 'missing' })]), [source], 'evaluate', profiles), /profileId/);
  const prepared = validatePreparation(preparation([card({ profileId: 'observed_1', user: { ...user, persona: 'Invented dramatic persona', characteristics: ['Shouts'] } })]), [source], 'evaluate', profiles);
  assert.equal(prepared.scenarios[0]!.user.persona, 'Observed customer');
  assert.deepEqual(prepared.scenarios[0]!.user.characteristics, ['Short messages']);
  const curated = validatePreparation(preparation([card({ provenance: 'curated', requirementIds: [] })]), [source], 'evaluate', profiles);
  assert.equal(curated.scenarios[0]!.user.persona, 'P');
});

test('user modes default to reactive and reject duplicates; imports reject duplicate ids and oversized dialogues', () => {
  assert.deepEqual(settingsSchema.parse({}).userModes, ['reactive']);
  assert.equal(settingsSchema.safeParse({ userModes: ['static', 'static'] }).success, false);
  assert.deepEqual(settingsSchema.parse({ userModes: ['static', 'scripted', 'reactive'] }).userModes, ['static', 'scripted', 'reactive']);
  const base = { task: 'task', materials: [{ name: 'm', content: 'c' }], mode: 'demo' as const };
  const dialogue = (id: string, content = 'hello') => ({ id, messages: [{ role: 'user' as const, content }] });
  assert.equal(createInputSchema.safeParse({ ...base, dialogues: [dialogue('d1'), dialogue('d1')] }).success, false);
  assert.equal(createInputSchema.safeParse({ ...base, goldenCases: [{ id: 'g', goal: 'x', opening: 'y', successCriteria: 'z' }, { id: 'g', goal: 'x', opening: 'y', successCriteria: 'z' }] }).success, false);
  const parsed = createInputSchema.parse({ ...base, dialogues: [dialogue('d1')], goldenCases: [{ id: 'g', goal: 'x', opening: 'y', successCriteria: 'z' }] });
  assert.equal(parsed.dialogues[0]!.outcome, 'unknown');
  assert.deepEqual(parsed.target, { kind: 'sandbox' });
  const huge = Array.from({ length: 200 }, (_, i) => ({ id: `d${i}`, messages: Array.from({ length: 2 }, () => ({ role: 'user' as const, content: 'x'.repeat(8000) })) }));
  assert.equal(createInputSchema.safeParse({ ...base, dialogues: huge }).success, false);
});

test('owner-supplied profiles need no evidence, observed ones do, and owner notes travel with the input', () => {
  assert.equal(profileSchema.safeParse({ id: 'p', persona: 'Busy parent', characteristics: ['Terse'] }).success, false);
  const owner = profileSchema.parse({ id: 'p', persona: 'Busy parent', characteristics: ['Terse'], source: 'owner' });
  assert.deepEqual([owner.source, owner.evidenceDialogueIds, owner.observedStyle], ['owner', [], undefined]);
  const observed = profileSchema.parse({ id: 'o', persona: 'Observed', characteristics: ['Short'], evidenceDialogueIds: ['d1'] });
  assert.equal(observedProfileSchema.safeParse({ ...observed, source: 'owner' }).success, false);
  assert.equal(observedProfileSchema.safeParse({ ...observed, draftOverride: { persona: 'Model pretending this was edited' } }).success, false);
  assert.equal(observed.source, 'observed');
  const base = { task: 'task', materials: [{ name: 'm', content: 'c' }], mode: 'demo' as const };
  const parsed = createInputSchema.parse({ ...base, notes: 'Users are often angry and rarely know their appointment ID.', profiles: [{ id: 'p', persona: 'Busy parent', characteristics: ['Terse'] }] });
  assert.equal(parsed.notes, 'Users are often angry and rarely know their appointment ID.');
  assert.equal(parsed.profiles[0]!.source, 'owner');
  assert.equal(createInputSchema.safeParse({ ...base, profiles: [{ id: 'p', persona: 'A', characteristics: ['x'] }, { id: 'p', persona: 'B', characteristics: ['y'] }] }).success, false);
  assert.equal(experimentSchema.parse({ ...legacyRecord(), profiles: [{ id: 'p', persona: 'Busy parent', characteristics: ['Terse'], source: 'owner' }] }).notes, '');
});

function legacyRecord() {
  return {
    schemaVersion: '1', id: 'legacy', task: 'task', mode: 'demo', createdAt: 'now', updatedAt: 'now', phase: 'complete', message: 'm',
    sources: [], settings: settingsSchema.parse({}), requirements: [], questions: [], scenarios: [], revisions: [], selectedRevisionId: null,
    manifestHash: null, reviewedAt: null, controlConsumedAt: null, comparisons: [], iterations: [], usage: emptyUsage(), error: null, limitations: [], trials: [],
  };
}

test('command targets run a local process: executable plus arguments, optional absolute cwd', () => {
  const parsed = targetSchema.parse({ kind: 'command', command: 'python3', args: ['/abs/agent.py'] });
  assert.deepEqual(parsed, { kind: 'command', command: 'python3', args: ['/abs/agent.py'], timeoutMs: 60000 });
  assert.equal(targetSchema.safeParse({ kind: 'command', command: '' }).success, false);
  assert.equal(targetSchema.safeParse({ kind: 'command', command: 'python3', cwd: 'relative/dir' }).success, false);
  assert.ok(targetSchema.safeParse({ kind: 'command', command: 'python3', cwd: '/abs/dir' }).success);
});

test('observed goals become production cards with a verbatim real opening and the matching profile', () => {
  const profile: Profile = { id: 'observed_1', persona: 'Observed customer', characteristics: ['Short messages'], observedStyle: 's', evidenceDialogueIds: ['d1'], source: 'observed' };
  const goal = observedGoalSchema.parse({ id: 'goal_move', goal: 'Move appointment A101 to 14:00', opening: 'move A101 to 14:00 pls', profileId: 'observed_1', evidenceDialogueIds: ['d1'], successCriteria: 'The appointment is moved to 14:00 or the user is told why not' });
  const scenario = goalToScenario(goal, profile);
  assert.equal(scenario.provenance, 'production');
  assert.equal(scenario.profileId, 'observed_1');
  assert.equal(scenario.user.opening, 'move A101 to 14:00 pls');
  assert.equal(scenario.user.persona, 'Observed customer');
  assert.deepEqual(scenario.user.characteristics, ['Short messages']);
  assert.equal(scenario.user.maxFollowUps, 2);
  assert.deepEqual(scenario.requirementIds, []);
  assert.ok(scenario.metrics!.some(m => m.subject === 'agent') && scenario.metrics!.some(m => m.subject === 'simulator'));
  assert.ok(scenario.assumptions!.some(a => /real dialogue/i.test(a)));
  assert.equal(goal.outcome, 'unknown');
});

test('кластер провалов обязан ссылаться на диалоги, которые действительно провалились', () => {
  const trial = (id: string, outcome: 'fail' | 'pass') => ({ id, outcome } as unknown as Parameters<typeof validateFailureModes>[1][number]);
  const trials = [trial('t1', 'fail'), trial('t2', 'fail'), trial('t3', 'pass')];
  const mode = { id: 'hotline', name: 'Нашёл статью и всё равно отправил на горячую линию', description: 'd', trialIds: ['t1', 't2'] };
  validateFailureModes([mode], trials);
  assert.throws(() => validateFailureModes([{ ...mode, trialIds: ['t1', 't9'] }], trials), /не проваливались/);
  assert.throws(() => validateFailureModes([{ ...mode, trialIds: ['t1', 't3'] }], trials), /не проваливались/);
  assert.throws(() => validateFailureModes([{ ...mode, trialIds: ['t1', 't1'] }], trials), /дважды/);
  assert.throws(() => validateFailureModes([mode, mode], trials), /повторяются/);
});

test('draft card operations name removals and reject duplicate or conflicting ids', () => {
  assert.ok(draftPatchSchema.safeParse({ scenarios: [card()] }).success);
  assert.deepEqual(draftPatchSchema.parse({ removeScenarioIds: ['c1'] }), { removeScenarioIds: ['c1'] });
  for (const patch of [
    { scenarios: [card(), card()] }, { removeScenarioIds: ['c1', 'c1'] },
    { scenarios: [card()], removeScenarioIds: ['c1'] }, { removeScenarioIds: ['../c1'] }, {},
  ]) assert.equal(draftPatchSchema.safeParse(patch).success, false);
});

test('exact final-answer checks reject impossible combinations without constraining earlier replies', () => {
  const exact = { id: 'exact', kind: 'answer_equals', description: 'Final answer', value: 'Thank you.' };
  const validate = (checks: unknown[]) => validatePreparation(preparation([card({ checks })]), [source], 'evaluate');
  assert.throws(() => validate([exact, { ...exact, id: 'different', value: 'thank you.' }]), /Contradictory exact answer/);
  const forbidden = { id: 'forbidden', kind: 'answer_omits', description: 'Forbidden wording', value: 'THANK' };
  assert.throws(() => validate([exact, forbidden]), /Exact answer contains forbidden/);
  assert.throws(() => validate([forbidden, exact]), /Exact answer contains forbidden/);
  assert.doesNotThrow(() => validate([exact, { ...exact, id: 'same' }, { id: 'earlier', kind: 'answer_contains', description: 'Earlier clarification', value: 'What is your name?' }]));
});
