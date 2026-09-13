// Regression checks for the review findings; controlled fixtures never call a provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ExperimentLab, draftHash } from '../src/experiment.js';
import { evaluateTrial } from '../src/evaluation.js';
import { previewCriteria } from '../src/preview.js';
import { evidenceBundle } from '../src/artifacts.js';
import { createInputSchema, fingerprint, settingsSchema } from '../src/contracts.js';

const spec = { name: 'Review fixture', instructions: 'Answer correctly without revealing internal_key.', tools: [] };
const material = { name: 'policy', content: 'Answer the question correctly. Never reveal internal_key.' };
const world = { records: {}, writableFields: [], transientFailures: 0 };
const card = (index = 0) => ({
  id: `card_${index}`, familyId: `family_${index}`, title: `Question ${index}`,
  requirementIds: ['answer'], provenance: 'synthetic', tier: 'regression',
  user: { goal: 'Get the correct answer', facts: 'No additional facts', behavior: 'Ask once', opening: 'What is the answer?', maxFollowUps: 0 },
  initialState: structuredClone(world),
  checks: [{ id: 'no_secret', kind: 'answer_omits', value: 'internal_key', description: 'Do not reveal the internal key' }],
  metrics: [{ id: 'correctness', name: 'Correct answer', subject: 'agent', description: 'Answer is correct', passCriteria: 'Correct answer', failCriteria: 'Wrong answer' }],
  successCriteria: 'Correct answer without secret disclosure',
});
const runtime = (cards, onImprove = () => {}) => ({
  async prepare({ sources }) {
    return { requirements: [{ id: 'answer', text: material.content, sourceId: sources[0].id, quote: material.content, critical: false }],
      questions: [], agent: spec, scenarios: cards };
  },
  async openTarget() { return { async respond() { return 'An incorrect answer'; }, async close() {} }; },
  async assess({ scenario }) { return scenario.metrics.map(metric => ({ metricId: metric.id, result: 'fail', rationale: 'Fixture: this answer is wrong', evidence: [1] })); },
  async improve() { onImprove(); return { agent: { ...spec, instructions: 'Correct the answer.' }, hypothesis: 'Fix the observed semantic failure' }; },
  async userTurn() { throw new Error('Static probes do not need a simulator'); },
});
async function labFixture(t, adapter) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-workflow-'));
  const lab = new ExperimentLab(directory, adapter);
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await lab.init();
  return lab;
}
const input = workflow => createInputSchema.parse({ task: 'Review fixture', mode: 'demo', materials: [material], workflow,
  settings: { repeats: 1, maxIterations: 1, userModes: ['static'] } });

test('semantic answer preview grades both examples, preserves the run and rejects invented evidence', async t => {
  const lab = await labFixture(t, runtime([card()]));
  const created = await lab.create(input('evaluate')); await lab.waitForIdle();
  const record = await lab.get(created.id);
  const original = JSON.stringify(record);
  let calls = 0;
  const judge = { ...runtime([]), async assess({ trial }, ctx) {
    ctx.beforeCall(); ctx.addUsage({ inputTokens: 5, outputTokens: 2, costUsd: 0.01 }); calls++;
    return [{ metricId: 'correctness', result: trial.events.at(-1).text === 'Correct' ? 'pass' : 'fail', evidence: [1], rationale: 'Check the supplied answer.' }];
  } };
  const result = await previewCriteria(record, 'card_0', { good: 'Correct', bad: 'Wrong' }, { directory: lab.store.directory, runtime: judge });
  assert.deepEqual(result.results.map(r => r.matchesExpected), [true, true]);
  assert.equal(calls, 2); assert.equal(result.usage.costUsd, 0.02);
  assert.equal(JSON.stringify(await lab.get(record.id)), original);
  assert.equal(JSON.parse(await readFile(result.file, 'utf8')).criteriaHash, result.criteriaHash);
  const invalid = await previewCriteria(record, 'card_0', { good: 'Correct', bad: 'Wrong' }, { directory: lab.store.directory,
    runtime: { ...judge, async assess() { return [{ metricId: 'correctness', result: 'pass', evidence: [99], rationale: 'Invented event.' }]; } } });
  assert.ok(invalid.results.every(r => r.result === 'unknown' && /nonexistent/.test(r.error)));
  await assert.rejects(previewCriteria(record, 'card_0', { good: 'same', bad: 'same' }, { directory: lab.store.directory, runtime: judge }), /должны отличаться/);
});

test('external LLM adapter commits tools in SQLite, isolates history, attests prompt and accounts calls', async t => {
  const { createSession } = await import('../examples/llm-stateful-agent.mjs');
  const initialState = { records: { A: { time: '09:00', owner: 'Alex' } }, writableFields: ['time'], transientFailures: 0 };
  const prompt = 'Manage appointments.';
  const fake = { async openTarget(_spec, _sources, tools, ctx) {
    let selected;
    return { async respond(message) {
      ctx.beforeCall(); ctx.addUsage({ inputTokens: 7, outputTokens: 3, costUsd: 0.01 });
      if (message === 'remember A') { selected = 'A'; return 'Remembered'; }
      if (!selected) return 'Which record?';
      const read = await tools.find(t => t.name === 'lookup_record').execute({ recordId: selected });
      if (message === 'move') await tools.find(t => t.name === 'update_record').execute({ recordId: selected, changes: { time: '11:00' } });
      return read.record.time;
    }, async close() {} };
  } };
  const a = await createSession({ initialState, sessionId: 'first', prompt, promptHash: fingerprint(prompt) }, fake);
  const b = await createSession({ initialState, sessionId: 'second', prompt, promptHash: fingerprint(prompt) }, fake);
  t.after(async () => { await a.close(); await b.close(); });
  await a.respond('remember A');
  const changed = await a.respond('move');
  assert.equal(changed.records.A.time, '11:00'); assert.equal(changed.records.A.owner, 'Alex');
  assert.equal(changed.promptHash, fingerprint(prompt)); assert.equal(changed.resetConfirmed, true);
  assert.equal(changed.events.length, 2); assert.equal(changed.usage.calls, 1); assert.equal(changed.usage.costUsd, 0.01);
  const reset = await b.respond('move');
  assert.equal(reset.reply, 'Which record?'); assert.equal(reset.records.A.time, '09:00');
  assert.equal((await a.respond('read')).reply, '11:00'); assert.equal(changed.version, reset.version);
  assert.equal(initialState.records.A.time, '09:00');
  await assert.rejects(createSession({ initialState, sessionId: 'bad', prompt, promptHash: 'wrong' }, fake), /verified prompt/);
});

test('external state must not pass when the adapter never reported it', async t => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify('No backend observation was made.'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const scenario = { ...card(), split: 'dev', metrics: [],
    initialState: { records: { A: { time: '09:00' } }, writableFields: [], transientFailures: 0 },
    checks: [{ id: 'state', kind: 'state_equals', description: 'The backend record is unchanged', recordId: 'A', field: 'time', value: '09:00' }] };
  const trial = await evaluateTrial({ runtime: runtime([]), revision: { id: fingerprint(spec), parentId: null, spec, hypothesis: 'Fixture', createdAt: new Date().toISOString() },
    scenario, repeat: 0, manifestHash: 'review', sources: [], settings: settingsSchema.parse({}), userMode: 'static',
    target: { kind: 'http', url: `http://127.0.0.1:${server.address().port}`, headersEnv: {}, timeoutMs: 1000 },
    ctx: { signal: AbortSignal.timeout(5000), timeoutMs: 1000, beforeCall() {}, addUsage() {} } });
  t.diagnostic(JSON.stringify({ outcome: trial.outcome, reason: trial.reason, checks: trial.checks }));
  assert.notEqual(trial.outcome, 'pass', 'Absent backend evidence must not become a passing state check');
});

test('sandbox optimizer must consider semantic agent failures', async t => {
  let improvements = 0;
  const lab = await labFixture(t, runtime(Array.from({ length: 4 }, (_, i) => card(i)), () => improvements++));
  const draft = await lab.create(input('compare')); await lab.waitForIdle();
  await lab.start(draft.id, { approved: true, reviewer: 'automated' }); await lab.waitForIdle();
  const record = await lab.get(draft.id);
  assert.equal(record.phase, 'complete', record.error ?? 'Run failed');
  assert(record.trials.every(trial => trial.outcome === 'pass'));
  assert(record.trials.every(trial => trial.assessments.some(assessment => assessment.result === 'fail')));
  t.diagnostic(JSON.stringify({ trials: record.trials.length, semanticFailures: record.trials.length, improvements, finalVerdict: record.comparisons.at(-1)?.verdict }));
  assert(improvements > 0, 'Every semantic rubric failed, but the optimizer never requested a candidate');
});

test('generated cards cannot claim owner-curated provenance', async t => {
  const generated = { ...card(), provenance: 'curated', requirementIds: [] };
  const lab = await labFixture(t, runtime([generated]));
  // Exercise the live preparation boundary with deterministic generated output; no provider is called.
  const draft = await lab.create({ ...input('evaluate'), mode: 'live' }); await lab.waitForIdle();
  const record = await lab.get(draft.id);
  t.diagnostic(JSON.stringify({ phase: record.phase, provenance: record.scenarios[0]?.provenance, suppliedGoldenCases: record.goldenCases.length, suppliedDialogues: record.dialogues.length }));
  assert(record.phase === 'error' || record.scenarios.every(scenario => scenario.provenance === 'synthetic'),
    'The preparation boundary accepted a generated card as curated without any owner golden cases');
});

import { doctor, readConnection, listSuites, rememberedConnection } from '../src/connection.js';
import { proposePrompt, promptVersion } from '../src/prompt-edit.js';
import { compareRuns, pilotSummary } from '../src/comparison.js';
import { previewAnswer } from '../src/evaluation.js';
import { readData } from '../src/imports.js';

test('portable connection checks actual SQLite history/reset; a prompt version repeats the same regression suite', async t => {
  const lab = await labFixture(t, runtime([{ ...card(), metrics: [] }]));
  const directory = lab.store.directory;
  const connection = await readConnection(resolve('examples/connection.json'));
  const checked = await doctor(connection);
  assert.equal(checked.passed, true, JSON.stringify(checked));
  assert.equal(checked.trials[0].finalState.records.A.time, '14:00');
  assert.equal(checked.trials[1].finalState.records.A.time, '09:00');
  assert.notEqual(checked.trials[0].id, checked.trials[1].id);
  const brokenProbe = await doctor({ ...connection, probe: { ...connection.probe, read: { ...connection.probe.read, reply: 'Wrong remembered value' } } });
  assert.equal(brokenProbe.passed, false);

  const prompt = join(directory, 'prompt.md'); await writeFile(prompt, 'Updates disabled.');
  const draft = await lab.create({ ...input('evaluate'), target: { ...connection.target, promptFile: prompt } });
  await lab.waitForIdle();
  let prepared = await lab.get(draft.id);
  const move = { ...prepared.scenarios[0], initialState: { records: { A: { time: '09:00' } }, writableFields: ['time'], transientFailures: 0 },
    user: { ...prepared.scenarios[0].user, opening: 'Move A to 14:00' }, successCriteria: 'Move the record',
    checks: [{ id: 'moved', kind: 'state_equals', recordId: 'A', field: 'time', value: '14:00', description: 'Move the record' }] };
  const guard = { ...move, id: 'read_only', familyId: 'read_only', title: 'Read-only guard', user: { ...move.user, opening: 'What time is A?' },
    successCriteria: 'Preserve the record', checks: [{ ...move.checks[0], id: 'preserve', value: '09:00', description: 'Preserve the record' }] };
  prepared = await lab.updateDraft(prepared.id, draftHash(prepared), { scenarios: [move, guard] });
  await lab.start(prepared.id, { approved: true, expectedHash: draftHash(prepared) }); await lab.waitForIdle();
  const before = await lab.get(prepared.id);
  assert.deepEqual(before.trials.map(t => t.outcome), ['fail', 'pass']);
  assert.equal((await rememberedConnection(directory)).target.promptFile, prompt);
  await assert.rejects(proposePrompt(directory, before, { candidate: 'Allow updates after lookup.', hypothesis: 'Enable tested update', trialIds: [before.trials[0].id] }), /подтверждённые/);
  const reviewed = await lab.addHumanReview(before.id, { trialId: before.trials[0].id, verdict: 'fail', note: 'Test fixture review: SQLite did not change. Not a real owner review.', durationMs: 25 });
  const proposal = await proposePrompt(directory, reviewed, { candidate: 'Allow updates after lookup.', hypothesis: 'Enable updates with lookup', trialIds: [before.trials[0].id] });
  assert.match(proposal.diff, /-Updates disabled/); assert.match(proposal.diff, /\+Allow updates after lookup/);
  const candidate = await promptVersion(lab, proposal.file, proposal.reviewHash);
  assert.deepEqual(candidate.scenarios, before.scenarios);
  assert.notEqual(candidate.target.promptFile, prompt); assert.equal(await readFile(prompt, 'utf8'), 'Updates disabled.');
  await lab.start(candidate.id, { approved: true, expectedHash: draftHash(candidate) }); await lab.waitForIdle();
  const after = await lab.get(candidate.id);
  assert.deepEqual(after.trials.map(t => t.outcome), ['pass', 'pass']);
  assert.equal(compareRuns(before, after).fixed.length, 1);
  assert.equal(compareRuns(before, after).regressed.length, 0);
  const suite = await lab.saveSuite(after.id, join(directory, '.evals', 'regression.json'));
  const listing = await listSuites(dirname(suite)); assert.equal(listing[0].sourceTrials, 2);
  const stored = JSON.parse(await readFile(suite, 'utf8'));
  assert.equal(stored.definition.sourceEvidence.trials[0].id, after.trials[0].id);
  assert.ok(!stored.definition.target.cwd.startsWith('/'));
  // Even a suite with a stale absolute adapter path can be loaded with this machine's connection.
  stored.definition.target = { kind: 'module', path: '/no/such/machine/agent.mjs', exportName: 'createSession' };
  const stale = join(directory, 'stale.json'); await writeFile(stale, JSON.stringify(stored));
  const loaded = await lab.loadSuite(stale, undefined, connection);
  assert.deepEqual(loaded.target, connection.target);
  assert.equal(loaded.sourceEvidence.runId, after.id);
  assert.deepEqual(loaded.humanReviews, []);
  const cli = spawnSync(process.execPath, [resolve('dist/cli.js'), 'evaluate', '--input', stale, '--connection', resolve('examples/connection.json'), '--yes', '--data-dir', join(directory, 'ci')], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).verdict.execution.completed, 2);
});

test('reassessment never opens the target, preserves original evidence, versions criteria and validates citations', async t => {
  let opens = 0;
  const adapter = runtime([card()]);
  const originalOpen = adapter.openTarget;
  adapter.openTarget = async (...args) => { opens++; return originalOpen(...args); };
  const lab = await labFixture(t, adapter);
  const draft = await lab.create(input('evaluate')); await lab.waitForIdle();
  const prepared = await lab.get(draft.id);
  await lab.start(prepared.id, { approved: true, expectedHash: draftHash(prepared) }); await lab.waitForIdle();
  const original = await lab.get(prepared.id);
  adapter.assess = async ({ scenario }) => scenario.metrics.map(m => ({ metricId: m.id, result: 'pass', rationale: 'Changed rubric fixture', evidence: [1] }));
  const scoring = await lab.reassess(original.id, { criteria: [{ scenarioId: 'card_0', metrics: [{ ...card().metrics[0], passCriteria: 'The answer is explicitly incorrect' }] }] });
  await lab.waitForIdle();
  const revised = await lab.get(scoring.id);
  assert.equal(revised.phase, 'results_review', revised.error);
  assert.equal(opens, 1, 'Only the original run opened a target session');
  assert.deepEqual(await lab.get(original.id), original, 'No original facts or scores are overwritten');
  assert.equal(revised.assessmentOf, original.id);
  assert.deepEqual(revised.trials[0].events, original.trials[0].events);
  assert.equal(revised.trials[0].assessments[0].result, 'pass');
  assert.equal(original.trials[0].assessments[0].result, 'fail');
  assert.equal(compareRuns(original, revised).comparable, false);
  const codeOnly = await lab.reassess(original.id, { codeOnly: true }); await lab.waitForIdle();
  assert.equal((await lab.get(codeOnly.id)).usage.calls, 0);
  adapter.assess = async () => [{ metricId: 'correctness', result: 'pass', rationale: 'Bad citation', evidence: [999] }];
  const invalid = await lab.reassess(original.id); await lab.waitForIdle();
  assert.match((await lab.get(invalid.id)).trials[0].assessmentError, /nonexistent/);
  assert.equal(opens, 1);
  const judged = await lab.reassess(original.id, { judge: { provider: 'fixture', model: 'other-judge' } }); await lab.waitForIdle();
  assert.notEqual((await lab.get(judged.id)).evaluatorVersion, original.evaluatorVersion);
});

test('rejudged version pairs remain comparable and calibration refers to unchanged original human labels', async t => {
  const adapter = runtime([card()]);
  const lab = await labFixture(t, adapter);
  const created = await lab.create(input('evaluate')); await lab.waitForIdle();
  await lab.start(created.id, { approved: true, expectedHash: draftHash(await lab.get(created.id)) }); await lab.waitForIdle();
  let original = await lab.get(created.id);
  await lab.addHumanReview(original.id, { trialId: original.trials[0].id, metricId: 'correctness', verdict: 'pass', note: 'Explicit test fixture label, not a real human verdict.' });
  original = await lab.get(original.id);
  adapter.assess = async () => [{ metricId: 'correctness', result: 'pass', rationale: 'Changed evaluator fixture', evidence: [1] }];
  const first = await lab.reassess(original.id); await lab.waitForIdle();
  const before = await lab.get(first.id);
  const bundle = await evidenceBundle(before, lab.store);
  assert.equal(bundle.calibrationComparison.reviewIds.length, 1);
  assert.equal(bundle.calibrationComparison.before.find(c => c.key === 'correctness').agreement, 0);
  assert.equal(bundle.calibrationComparison.after.find(c => c.key === 'correctness').agreement, 1);
  assert.deepEqual(before.humanReviews, [], 'Referenced labels do not become new human approvals');
  const changed = await lab.reassess(original.id, { criteria: [{ scenarioId: 'card_0', metrics: [{ ...card().metrics[0], passCriteria: 'A different criterion' }] }] });
  await lab.waitForIdle();
  assert.equal((await evidenceBundle(await lab.get(changed.id), lab.store)).calibrationComparison.reviewIds.length, 0);
  const next = await lab.repeat(original.id);
  await lab.start(next.id, { approved: true, expectedHash: draftHash(next) }); await lab.waitForIdle();
  const second = await lab.reassess(next.id); await lab.waitForIdle();
  const after = await lab.get(second.id);
  assert.equal(after.sourceEvidence.parentRunId, original.id);
  assert.equal(compareRuns(before, after).comparable, true);
  assert.equal(compareRuns(original, after).comparable, false);
  assert.equal(compareRuns(before, { ...after, evaluatorVersion: 'other' }).comparable, false);
});

test('good/bad previews and local JSONL imports validate actual criteria without fabricating state or provenance', async t => {
  const lab = await labFixture(t, runtime([card()]));
  const good = previewAnswer({ ...card(), split: 'dev' }, 'Answer');
  const bad = previewAnswer({ ...card(), split: 'dev' }, 'internal_key');
  assert.equal(good.checks[0].passed, true); assert.equal(bad.checks[0].passed, false);
  assert.deepEqual(good.unmeasured, ['Correct answer']);
  const file = join(lab.store.directory, 'dialogues.jsonl');
  await writeFile(file, JSON.stringify({ id: 'real', messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }] }) + '\n');
  const imported = await readData(file, 'dialogues'); assert.equal(imported[0].id, 'real');
  await writeFile(file, '{bad}\n'); await assert.rejects(readData(file, 'dialogues'), /строке 1/);
});

test('draft edits cannot launder provenance; clarification keeps the old questions and records owner answers as a source', async t => {
  const adapter = runtime([card()]);
  const prepare = adapter.prepare;
  adapter.prepare = async args => ({ ...await prepare(args), questions: args.sources.length === 1 ? ['Which answer is correct?'] : [] });
  const lab = await labFixture(t, adapter);
  const created = await lab.create(input('evaluate')); await lab.waitForIdle();
  const original = await lab.get(created.id);
  await assert.rejects(lab.updateDraft(original.id, draftHash(original), { scenarios: [{ ...original.scenarios[0], provenance: 'curated' }] }), /Происхождение/);
  await assert.rejects(lab.clarify(original.id, [{ question: 'Wrong question', answer: '42' }]), /каждый вопрос/);
  const next = await lab.clarify(original.id, [{ question: original.questions[0], answer: '42, according to the owner.' }]);
  assert.equal(next.phase, 'review'); assert.equal(next.parentRunId, original.id);
  assert.equal(next.clarifications[0].answer, '42, according to the owner.');
  assert.match(next.sources.at(-1).content, /Ответ владельца: 42/);
  assert.deepEqual(await lab.get(original.id), original);
});

test('partial external observations, unreported costs and out-of-scope tools cannot look like complete measurements', async t => {
  let responseFor;
  let requests = 0;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); requests++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(responseFor(input, requests)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const scenario = { ...card(), metrics: [], split: 'dev', user: { ...card().user, opening: 'Read', script: ['Read again'], maxFollowUps: 1 },
    initialState: { records: { A: { time: '09:00' } }, writableFields: [], transientFailures: 0 },
    checks: [{ id: 'state', kind: 'state_equals', recordId: 'A', field: 'time', value: '09:00', description: 'Unchanged' }] };
  const run = (s = scenario) => evaluateTrial({ runtime: runtime([]), revision: { id: fingerprint(spec), parentId: null, spec, hypothesis: 'fixture', createdAt: new Date().toISOString() },
    scenario: s, repeat: 0, manifestHash: 'fixture', sources: [], settings: settingsSchema.parse({}), userMode: 'scripted',
    target: { kind: 'http', url: `http://127.0.0.1:${server.address().port}`, headersEnv: {}, timeoutMs: 1000 },
    ctx: { signal: AbortSignal.timeout(5000), timeoutMs: 1000, beforeCall() {}, addUsage() {} } });
  const reply = (input, turn) => ({ reply: 'OK', records: { A: { time: '09:00' } }, eventsComplete: true, resetConfirmed: true,
    sessionId: input.sessionId, turn, version: 'v1', usage: { calls: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.1 } });
  responseFor = (input, turn) => turn === 1 ? reply(input, turn) : 'No snapshot';
  let result = await run(); assert.equal(result.outcome, 'invalid'); assert.equal(result.externalUsage.costUsd, null);
  requests = 0; responseFor = (input, turn) => ({ ...reply(input, turn), records: { A: {} } });
  result = await run(); assert.equal(result.outcome, 'invalid'); assert.match(result.reason, /Не наблюдалось поле/);
  requests = 0; responseFor = (input, turn) => ({ ...reply(input, turn), eventScope: ['read_*'] });
  result = await run({ ...scenario, checks: [{ id: 'no_write', kind: 'tool_not_called', tool: 'update_record', description: 'No writes' }] });
  assert.equal(result.outcome, 'invalid'); assert.match(result.reason, /область событий/);
  requests = 0; responseFor = (input, turn) => ({ ...reply(input, turn), sessionId: 'wrong-session' });
  result = await run(); assert.equal(result.outcome, 'invalid'); assert.match(result.reason, /идентификатор/);
  requests = 0; responseFor = (input, turn) => ({ ...reply(input, turn), version: `v${turn}` });
  result = await run(); assert.equal(result.outcome, 'invalid'); assert.match(result.reason, /Версия.*изменилась/);
});

test('a partially scored candidate cannot be accepted, and pilot statistics require real human annotations', async t => {
  const adapter = runtime(Array.from({ length: 4 }, (_, i) => card(i)));
  adapter.assess = async ({ scenario }) => [{ metricId: scenario.metrics[0].id, result: 'unknown', rationale: 'Insufficient evidence', evidence: [] }];
  const lab = await labFixture(t, adapter);
  const created = await lab.create(input('compare')); await lab.waitForIdle();
  await lab.start(created.id, { approved: true }); await lab.waitForIdle();
  const incomplete = await lab.get(created.id); assert.equal(incomplete.phase, 'error'); assert.match(incomplete.error, /assessment is incomplete/);
  const record = structuredClone(incomplete); record.workflow = 'evaluate'; record.settings.userModes = ['static', 'reactive']; record.scenarios = [record.scenarios[0]];
  const base = { ...record.trials[0], userMode: 'static', outcome: 'pass', assessments: [{ metricId: 'correctness', result: 'pass', rationale: 'fixture', evidence: [1] }] };
  const reactive = { ...base, id: 'reactive_trial', userMode: 'reactive', outcome: 'fail' };
  record.trials = [base, reactive]; record.humanReviews = [];
  assert.equal(pilotSummary(record).modes[1].exclusiveConfirmed.length, 0);
  record.humanReviews = [{ id: 'fixture_review', createdAt: record.createdAt, trialId: reactive.id, verdict: 'fail', note: 'Synthetic test annotation, not owner evidence.', durationMs: 500 }];
  const summary = pilotSummary(record);
  assert.equal(summary.modes[1].exclusiveConfirmed.length, 1); assert.equal(summary.modes[1].reviewMs, 500);
  record.humanReviews.push({ ...record.humanReviews[0], id: 'invalid_review', verdict: 'invalid', createdAt: '2099-01-01' });
  assert.equal(pilotSummary(record).modes[1].exclusiveConfirmed.length, 0);
});
