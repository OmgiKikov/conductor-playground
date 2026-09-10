import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ExperimentLab, draftHash, measurementHash, resultHash } from '../src/experiment.js';
import { ExperimentStore } from '../src/store.js';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { createInputSchema, fingerprint, validatePreparation, type Runtime } from '../src/contracts.js';

async function setup(t: TestContext, runtime?: Runtime) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-experiment-'));
  const lab = new ExperimentLab(directory, runtime);
  t.after(async () => { try { await lab.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  await lab.init();
  return { lab, directory };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test('complete experiment freezes measurement, restricts builder feedback, persists actual evidence and exports the selected agent', async t => {
  const runtime = createDemoRuntime();
  const improve = runtime.improve;
  let feedbackSeen = false;
  runtime.improve = async (input, ctx) => {
    assert.ok(input.feedback.length > 0);
    assert.ok(input.feedback.every(f => f.scenario.split === 'dev' && f.trials.every(trial => trial.split === 'dev')));
    feedbackSeen = true;
    const proposal = await improve(input, ctx);
    // A proposal must never acquire a mutable reference to frozen source/check data.
    input.sources[0]!.content = 'mutated by builder';
    input.feedback[0]!.scenario.checks = [];
    return proposal;
  };
  const { lab } = await setup(t, runtime);
  const created = await lab.create(demoInput());
  await lab.waitForIdle();
  const ready = await lab.get(created.id);
  assert.equal(ready.phase, 'review');
  await assert.rejects(lab.start(ready.id, { approved: false }), /approval/);
  await lab.start(ready.id, { approved: true });
  await lab.waitForIdle();
  const result = await lab.get(ready.id);
  assert.equal(result.phase, 'complete', result.error ?? '');
  assert.equal(feedbackSeen, true);
  assert.equal(result.manifestHash, measurementHash(result));
  assert.equal(result.sources[0]!.hash, fingerprint(result.sources[0]!.content));
  assert.deepEqual(result.scenarios, ready.scenarios);
  assert.ok(result.reviewedAt && result.controlConsumedAt);
  assert.ok(result.revisions.find(r => r.id === result.selectedRevisionId)!.spec.tools.includes('update_record'));
  const final = result.comparisons.at(-1)!;
  assert.equal(final.split, 'control');
  assert.deepEqual([final.baselinePasses, final.candidatePasses, final.fixed, final.regressed, final.validPairs, final.families], [4, 8, 4, 0, 8, 2]);
  assert.equal(final.verdict, 'insufficient');
  const journal = (await lab.store.traceJournal(result.id)).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(journal.length, result.trials.reduce((sum, trial) => sum + trial.events.length, 0));
  assert.ok(journal.some(row => row.event.type === 'tool_result' && row.event.tool === 'update_record'));
  assert.deepEqual(await lab.store.get(result.id), result);
  assert.notEqual(measurementHash({ ...result, task: 'different task' }), result.manifestHash);
  const changed = structuredClone(result);
  changed.revisions[0]!.spec.instructions += ' changed';
  assert.notEqual(measurementHash(changed), result.manifestHash);
  await assert.rejects(lab.start(result.id, { approved: true }), /Only an experiment awaiting review/);
});

test('candidate infrastructure failures retain the baseline and remain visible rather than becoming improvement', async t => {
  const runtime = createDemoRuntime();
  const openTarget = runtime.openTarget;
  runtime.openTarget = async (agent, ...args) => {
    if (agent.tools.includes('update_record')) throw new Error('Candidate provider unavailable');
    return openTarget(agent, ...args);
  };
  const { lab } = await setup(t, runtime);
  const input = demoInput(); input.settings.repeats = 1;
  const record = await lab.create(input); await lab.waitForIdle();
  await lab.start(record.id, { approved: true }); await lab.waitForIdle();
  const result = await lab.get(record.id);
  assert.equal(result.phase, 'complete');
  assert.equal(result.selectedRevisionId, result.revisions[0]!.id);
  assert.equal(result.iterations[0]!.accepted, false);
  assert.ok(result.trials.some(trial => trial.outcome === 'invalid'));
  assert.equal(result.comparisons.at(-1)!.verdict, 'no_change');
});

test('call budget stops the run, preserving partial trials without a final success claim', async t => {
  const { lab } = await setup(t);
  const input = demoInput(); input.settings.maxCalls = 5;
  const record = await lab.create(input); await lab.waitForIdle();
  await lab.start(record.id, { approved: true }); await lab.waitForIdle();
  const result = await lab.get(record.id);
  assert.equal(result.phase, 'error');
  assert.match(result.error!, /call budget/);
  assert.equal(result.usage.calls, 5);
  assert.ok(result.trials.length > 0);
  assert.equal(result.controlConsumedAt, null);
  assert.equal(result.comparisons.length, 0);
});

test('task-only execution records automated review and labels expectations provisional', async t => {
  const { lab } = await setup(t);
  const record = await lab.create(demoInput()); await lab.waitForIdle();
  await lab.start(record.id, { approved: true, reviewer: 'automated' }); await lab.waitForIdle();
  const result = await lab.get(record.id);
  assert.equal(result.phase, 'complete');
  assert.equal(result.reviewMode, 'automated');
  assert.match(result.limitations.join(' '), /without human validation/);
  assert.match(result.comparisons.at(-1)!.reasons.join(' '), /provisional/);
  assert.notEqual(result.comparisons.at(-1)!.verdict, 'improved');
});

test('shutdown during the initial checkpoint waits, keeps the lock, and never starts model work', async t => {
  const runtime = createDemoRuntime(); let calls = 0;
  const prepare = runtime.prepare;
  runtime.prepare = async (...args) => { calls++; return prepare(...args); };
  const { lab, directory } = await setup(t, runtime);
  const entered = deferred(); const release = deferred();
  const save = lab.store.save.bind(lab.store); let first = true;
  lab.store.save = async record => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    await save(record);
  };
  const creating = lab.create(demoInput());
  await entered.promise;
  await assert.rejects(lab.create(demoInput()), /Another experiment/);
  let closed = false;
  const closing = lab.close().then(() => { closed = true; });
  try {
    await assert.rejects(new ExperimentStore(directory).init(), /already open/);
    assert.equal(closed, false);
  } finally { release.resolve(); }
  const record = await creating;
  await closing;
  assert.equal(calls, 0);
  assert.equal((await lab.store.get(record.id)).phase, 'cancelled');
  await assert.rejects(lab.create(demoInput()), /not open/);
  const next = new ExperimentStore(directory); await next.init(); await next.close();
});

test('one writer, validated atomic saves, fail-closed stale locks, and interrupted restart', async t => {
  const { lab, directory } = await setup(t);
  const record = await lab.create(demoInput()); await lab.waitForIdle();
  const ready = await lab.get(record.id);
  await assert.rejects(new ExperimentStore(directory).init(), /already open/);
  await assert.rejects(lab.store.get('../outside'), /Invalid experiment ID/);
  await assert.rejects(lab.store.save({ ...ready, phase: 'fabricated' } as never));
  assert.equal((await lab.store.get(record.id)).phase, 'review');
  await lab.store.save({ ...ready, phase: 'baseline' });
  await writeFile(join(directory, `${record.id}.agent.json`), JSON.stringify(ready.revisions[0]!.spec));
  await lab.close();
  const restarted = new ExperimentLab(directory);
  await restarted.init();
  assert.equal((await restarted.get(record.id)).phase, 'interrupted');
  assert.equal((await restarted.get(record.id)).usage.costUsd, null);
  await restarted.close();
  await writeFile(join(directory, '.lock'), JSON.stringify({ pid: 2147483647, token: 'stale' }));
  await assert.rejects(new ExperimentStore(directory).init(), /Verify no other instance/);
  assert.equal(JSON.parse(await readFile(join(directory, '.lock'), 'utf8')).token, 'stale');
  await rm(join(directory, '.lock'));
  await writeFile(join(directory, `${record.id}.json`), '{"broken":true}');
  const corrupt = new ExperimentLab(directory);
  await assert.rejects(corrupt.init());
  await assert.rejects(readFile(join(directory, '.lock')), { code: 'ENOENT' });
});

test('shutdown waits for in-flight initialization and cannot reopen a closed lab or leak its lock', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-init-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lab = new ExperimentLab(directory);
  const entered = deferred(); const release = deferred();
  const init = lab.store.init.bind(lab.store);
  lab.store.init = async () => { entered.resolve(); await release.promise; await init(); };
  const opening = lab.init();
  await entered.promise;
  let closed = false;
  const closing = lab.close().then(() => { closed = true; });
  assert.equal(closed, false);
  release.resolve();
  await opening; await closing;
  await assert.rejects(lab.create(demoInput()), /not open/);
  await assert.rejects(lab.init(), /closing/);
  await assert.rejects(readFile(join(directory, '.lock')), { code: 'ENOENT' });
});

test('preparation rejects invented sources, uncovered critical requirements, and contradictory or unreachable checks', async () => {
  const input = demoInput();
  const sources = input.materials.map((m, i) => ({ ...m, id: `source-${i}`, hash: fingerprint(m.content) }));
  const raw = await createDemoRuntime().prepare({ task: input.task, sources }, {
    signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {},
  });
  const check = (mutate: (p: typeof raw) => void, message: RegExp) => {
    const p = structuredClone(raw); mutate(p); assert.throws(() => validatePreparation(p, sources), message);
  };
  check(p => { p.requirements[0]!.quote = 'Fabricated source fact'; }, /ungrounded/);
  check(p => { p.requirements.push({ ...p.requirements[0]!, id: 'uncovered' }); }, /no test coverage/);
  check(p => { p.scenarios[0]!.checks.push({ id: 'opposite', kind: 'state_equals', description: 'conflict', recordId: 'A101', field: 'time', value: '20:00' }); }, /Contradictory state/);
  check(p => { p.scenarios[0]!.checks.push({ id: 'no_lookup', kind: 'tool_not_called', description: 'conflict', tool: 'lookup_record' }); }, /Contradictory tool/);
  check(p => { p.scenarios[0]!.checks.push({ id: 'no_update', kind: 'tool_not_called', description: 'conflict', tool: 'update_record' }); }, /Contradictory update/);
  check(p => { p.scenarios[0]!.checks.push({ id: 'bad_count', kind: 'tool_count', description: 'conflict', tool: 'lookup_record', min: 3, max: 2 }); }, /Contradictory tool/);
  check(p => { p.scenarios[0]!.checks.push({ id: 'zero_lookups', kind: 'tool_count', description: 'conflict', tool: 'lookup_record', min: 0, max: 0 }); }, /Contradictory tool/);
  check(p => {
    p.scenarios[0]!.checks.push({ id: 'wants_time', kind: 'answer_contains', description: 'conflict', value: '14:00' });
    p.scenarios[0]!.checks.push({ id: 'forbids_time', kind: 'answer_omits', description: 'conflict', value: '14:00' });
  }, /Contradictory answer/);
  check(p => { p.scenarios[0]!.checks.push({ id: 'forbidden', kind: 'state_equals', description: 'unreachable', recordId: 'A101', field: 'owner', value: 'Other' }); p.scenarios[0]!.checks = p.scenarios[0]!.checks.filter(c => c.id !== 'owner'); }, /Unreachable/);
  check(p => { p.scenarios.forEach(s => { s.familyId = 'same'; }); }, /four distinct/);
});

test('unresolved business questions block approval until new materials produce a new experiment', async t => {
  const runtime = createDemoRuntime(); const prepare = runtime.prepare;
  runtime.prepare = async (...args) => ({ ...await prepare(...args), questions: ['Which timezone applies?'] });
  const { lab } = await setup(t, runtime);
  const record = await lab.create(demoInput()); await lab.waitForIdle();
  await assert.rejects(lab.start(record.id, { approved: true }), /Resolve the listed business questions/);
  assert.equal((await lab.get(record.id)).phase, 'review');
});

test('one user card requires exact human approval, runs one unchanged agent, then preserves separate human result review', async t => {
  const runtime = createDemoRuntime();
  let targets = 0; let improvements = 0;
  const openTarget = runtime.openTarget;
  runtime.openTarget = async (...args) => { targets++; return openTarget(...args); };
  runtime.improve = async () => { improvements++; throw new Error('Evaluation must not optimize'); };
  const { lab } = await setup(t, runtime);
  const input = demoInput(); input.workflow = 'evaluate'; input.scenarioCount = 1; input.settings.repeats = 1;
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  assert.equal(draft.phase, 'review'); assert.equal(draft.scenarios.length, 1); assert.equal(targets, 0);
  assert.ok(draft.scenarios[0]!.user.persona); assert.ok(draft.scenarios[0]!.metrics?.length);
  const originalHash = draftHash(draft);
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: originalHash }), /Human confirmation/);
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: 'stale' }), /Human confirmation/);
  const cards = structuredClone(draft.scenarios);
  cards[0]!.user.persona = 'A busy customer with one appointment';
  const edited = await lab.updateDraft(draft.id, originalHash, { scenarios: cards });
  assert.notEqual(draftHash(edited), originalHash); assert.equal(edited.reviewedAt, null);
  await assert.rejects(lab.updateDraft(draft.id, originalHash, { scenarios: cards }), /draft changed/);
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: originalHash }), /Human confirmation/);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(edited) }); await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'results_review', result.error ?? ''); assert.equal(result.reviewMode, 'human');
  assert.equal(result.revisions.length, 1); assert.equal(result.comparisons.length, 0); assert.equal(improvements, 0);
  assert.equal(targets, 1); assert.equal(result.trials.length, 1); assert.ok(result.trials[0]!.assessments?.length);
  assert.equal(result.manifestHash, measurementHash(result));
  await assert.rejects(lab.updateDraft(draft.id, draftHash(result), { scenarios: cards }), /unstarted draft/);
  const originalTrial = structuredClone(result.trials[0]!);
  const priorResultHash = resultHash(result);
  await assert.rejects(lab.addHumanReview(result.id, { trialId: 'missing', verdict: 'invalid', note: 'Wrong user.' }), /Trial not found/);
  await assert.rejects(lab.addHumanReview(result.id, { trialId: originalTrial.id, metricId: 'missing', verdict: 'fail', note: 'Wrong metric.' }), /Metric not found/);
  const annotated = await lab.addHumanReview(result.id, {
    trialId: originalTrial.id, metricId: result.scenarios[0]!.metrics![0]!.id, verdict: 'unknown', note: 'Need the real pilot before accepting this estimate.',
  });
  assert.deepEqual(annotated.trials[0], originalTrial); assert.equal(annotated.humanReviews!.length, 1);
  await assert.rejects(lab.reviewResults(result.id, priorResultHash), /results changed/);
  const reviewed = await lab.reviewResults(result.id, resultHash(annotated));
  assert.equal(reviewed.phase, 'complete'); assert.ok(reviewed.resultsReviewedAt); assert.equal(reviewed.resultsReviewHash, resultHash(annotated));
  const reopened = await lab.addHumanReview(result.id, { trialId: originalTrial.id, verdict: 'pass', note: 'Checked the stored action and transcript.' });
  assert.equal(reopened.phase, 'results_review'); assert.equal(reopened.resultsReviewedAt, undefined);
  assert.equal(reopened.humanReviews!.length, 2); assert.deepEqual(reopened.trials[0], originalTrial);
});

test('closing during a draft edit keeps the writer lock until the edit checkpoint finishes', async t => {
  const { lab, directory } = await setup(t);
  const input = demoInput(); input.workflow = 'evaluate'; input.scenarioCount = 1;
  const created = await lab.create(input); await lab.waitForIdle(); const draft = await lab.get(created.id);
  const entered = deferred(); const release = deferred(); const save = lab.store.save.bind(lab.store);
  lab.store.save = async record => { entered.resolve(); await release.promise; await save(record); };
  const editing = lab.updateDraft(draft.id, draftHash(draft), { settings: { repeats: 1 } });
  await entered.promise;
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }), /Another experiment operation/);
  let closed = false; const closing = lab.close().then(() => { closed = true; });
  await assert.rejects(new ExperimentStore(directory).init(), /already open/); assert.equal(closed, false);
  release.resolve(); await editing; await closing;
  assert.equal((await lab.store.get(draft.id)).settings.repeats, 1);
  const next = new ExperimentStore(directory); await next.init(); await next.close();
});

test('approval reserves its draft while reading so a concurrent edit cannot be overwritten by a stale start snapshot', async t => {
  const { lab } = await setup(t);
  const input = demoInput(); input.workflow = 'evaluate'; input.scenarioCount = 1; input.settings.repeats = 1;
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  const entered = deferred(); const release = deferred();
  const get = lab.store.get.bind(lab.store); let first = true;
  lab.store.get = async id => {
    const snapshot = await get(id);
    if (first) { first = false; entered.resolve(); await release.promise; }
    return snapshot;
  };
  const starting = lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) });
  await entered.promise;
  const scenarios = structuredClone(draft.scenarios);
  scenarios[0]!.user.persona = 'A newer draft that has not been approved';
  try {
    await assert.rejects(lab.updateDraft(draft.id, draftHash(draft), { scenarios }), /Another experiment operation/);
  } finally { release.resolve(); }
  await starting; await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  assert.deepEqual(result.scenarios, draft.scenarios);
  assert.equal(result.trials.length, 1);
});

test('a large malformed assessor response preserves the completed trial with a persistable assessment error', async t => {
  const runtime = createDemoRuntime();
  runtime.assess = async () => Array.from({ length: 8 }, () => ({})) as never;
  const { lab } = await setup(t, runtime);
  const input = demoInput(); input.workflow = 'evaluate'; input.scenarioCount = 1; input.settings.repeats = 1;
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) });
  await lab.waitForIdle();
  const saved = await lab.store.get(draft.id);
  assert.equal(saved.phase, 'results_review', saved.error ?? '');
  assert.equal(saved.trials.length, 1);
  assert.equal(saved.trials[0]!.outcome, 'pass');
  assert.equal(saved.trials[0]!.finalState.records.A101!.time, '14:00');
  assert.equal(saved.trials[0]!.assessments, undefined);
  assert.match(saved.trials[0]!.assessmentError!, /invalid_type/);
  assert.ok(saved.trials[0]!.assessmentError!.length <= 4000);
});

test('evaluation runs every user mode, skips scripted cards without a script, and rejects multi-mode comparison', async t => {
  const { lab } = await setup(t);
  const input = demoInput(); input.workflow = 'evaluate'; input.scenarioCount = 3; input.settings.repeats = 1; input.settings.userModes = ['static', 'scripted', 'reactive'];
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  const withScript = draft.scenarios.filter(s => s.user.script?.length).length;
  assert.ok(withScript >= 1 && withScript < draft.scenarios.length, `scripted cards: ${withScript}`);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  const byMode = (mode: string) => result.trials.filter(tr => tr.userMode === mode).length;
  assert.deepEqual([byMode('static'), byMode('scripted'), byMode('reactive')], [3, withScript, 3]);
  assert.ok(result.limitations.some(l => /Scripted mode skipped/.test(l)));
  assert.ok(result.trials.filter(tr => tr.userMode === 'static').every(tr => tr.events.filter(e => e.type === 'user').length === 1));
  const compare = demoInput(); compare.settings.userModes = ['static', 'reactive'];
  await assert.rejects(lab.create(compare), /exactly one user mode/);
});

test('golden cases and real dialogues enter the draft as curated cards and grounded profiles', async t => {
  const { lab } = await setup(t);
  const input = createInputSchema.parse({
    ...demoInput(), workflow: 'evaluate', scenarioCount: 2, settings: { ...demoInput().settings, repeats: 1 },
    goldenCases: [{ id: 'gold_move', goal: 'Move appointment A101 to 14:00', opening: 'Please move appointment A101 to 14:00.', successCriteria: 'A101 is at 14:00',
      initialState: { records: { A101: { time: '09:00', owner: 'Sample customer', status: 'booked' } }, writableFields: ['time'], transientFailures: 0 },
      checks: [{ id: 'time', kind: 'state_equals', description: 'moved', recordId: 'A101', field: 'time', value: '14:00' }] }],
    dialogues: [
      { id: 'd1', messages: [{ role: 'user', content: 'move A101 to 14:00 pls' }, { role: 'assistant', content: 'Done.' }], outcome: 'success' },
      { id: 'd2', messages: [{ role: 'user', content: 'can you move my appt? not sure of the id' }, { role: 'assistant', content: 'Which appointment?' }], outcome: 'abandoned' },
    ],
  });
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  assert.equal(draft.phase, 'review', draft.error ?? '');
  assert.equal(draft.profiles.length, 1);
  assert.deepEqual(draft.profiles[0]!.evidenceDialogueIds, ['d1', 'd2']);
  const golden = draft.scenarios.find(s => s.id === 'gold_move')!;
  assert.equal(golden.provenance, 'curated'); assert.equal(golden.checks.length, 1); assert.deepEqual(golden.requirementIds, []);
  const synthetic = draft.scenarios.filter(s => s.provenance === 'synthetic');
  assert.equal(synthetic.length, 2);
  assert.ok(synthetic.every(s => s.profileId === draft.profiles[0]!.id && s.user.persona === draft.profiles[0]!.persona));
  assert.notEqual(measurementHash(draft), measurementHash({ ...draft, dialogues: [] }));
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  const goldenTrial = result.trials.find(tr => tr.scenarioId === 'gold_move')!;
  assert.equal(goldenTrial.outcome, 'pass', goldenTrial.reason);
});

test('profiles with evidence outside the supplied dialogues fail preparation instead of grounding cards', async t => {
  const runtime = createDemoRuntime();
  runtime.profiles = async () => [{ id: 'bad', persona: 'x', characteristics: ['y'], observedStyle: 'z', evidenceDialogueIds: ['nope'] }];
  const { lab } = await setup(t, runtime);
  const input = createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1, dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'hi' }] }] });
  const created = await lab.create(input); await lab.waitForIdle();
  const failed = await lab.get(created.id);
  assert.equal(failed.phase, 'error');
  assert.match(failed.error ?? '', /evidence/i);
});

test('owner notes and owner profiles are first-class inputs: cards may cite an owner profile and the runtime sees the notes', async t => {
  const runtime = createDemoRuntime();
  const prepare = runtime.prepare;
  let seen: { notes?: string; profiles?: { id: string; source: string }[] } = {};
  runtime.prepare = async (input, ctx) => { seen = { notes: input.notes, profiles: input.profiles?.map(p => ({ id: p.id, source: p.source })) }; return prepare(input, ctx); };
  const { lab } = await setup(t, runtime);
  const input = createInputSchema.parse({
    ...demoInput(), workflow: 'evaluate', scenarioCount: 1, notes: 'Most users are in a hurry and do not know their appointment ID.',
    profiles: [{ id: 'hurried_owner', persona: 'A customer in a hurry', characteristics: ['Terse', 'Impatient'] }],
    dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'move A101 to 14:00' }], outcome: 'success' }],
  });
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  assert.equal(draft.phase, 'review', draft.error ?? '');
  assert.equal(seen.notes, input.notes);
  assert.deepEqual(seen.profiles, [{ id: 'hurried_owner', source: 'owner' }, { id: 'observed_1', source: 'observed' }]);
  assert.equal(draft.notes, input.notes);
  assert.deepEqual(draft.profiles.map(p => p.source), ['owner', 'observed']);
  assert.equal(draft.scenarios[0]!.profileId, 'hurried_owner');
  assert.equal(draft.scenarios[0]!.user.persona, 'A customer in a hurry');
});

test('real dialogues also yield production cards: observed goals with verbatim openings that cite supplied dialogues', async t => {
  const { lab } = await setup(t);
  const input = createInputSchema.parse({
    ...demoInput(), workflow: 'evaluate', scenarioCount: 1, settings: { ...demoInput().settings, repeats: 1 },
    dialogues: [
      { id: 'd1', messages: [{ role: 'user', content: 'move A101 to 14:00 pls' }, { role: 'assistant', content: 'Done.' }], outcome: 'success' },
      { id: 'd2', messages: [{ role: 'user', content: 'hi, what time is my appointment A102?' }, { role: 'assistant', content: '09:00.' }], outcome: 'success' },
    ],
  });
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  assert.equal(draft.phase, 'review', draft.error ?? '');
  const production = draft.scenarios.filter(s => s.provenance === 'production');
  assert.equal(production.length, 2);
  assert.deepEqual(production.map(s => s.user.opening).sort(), ['hi, what time is my appointment A102?', 'move A101 to 14:00 pls']);
  assert.ok(production.every(s => s.profileId === 'observed_1' && s.user.persona === draft.profiles[0]!.persona));
  assert.equal(draft.scenarios.filter(s => s.provenance === 'synthetic').length, 1);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  assert.equal(result.trials.filter(tr => production.some(s => s.id === tr.scenarioId)).length, 2);
});

test('an observed goal whose opening is not a real user message fails preparation', async t => {
  const runtime = createDemoRuntime();
  runtime.goals = async () => [{ id: 'g', goal: 'x', opening: 'never said this', profileId: 'observed_1', evidenceDialogueIds: ['d1'], successCriteria: 'y', facts: 'f', outcome: 'unknown' }];
  const { lab } = await setup(t, runtime);
  const input = createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1, dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'hello' }] }] });
  const created = await lab.create(input); await lab.waitForIdle();
  const failed = await lab.get(created.id);
  assert.equal(failed.phase, 'error');
  assert.match(failed.error ?? '', /opening/i);
});
