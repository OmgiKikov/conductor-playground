import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ExperimentLab, draftHash, measurementHash, resultHash } from '../src/experiment.js';
import { ExperimentStore } from '../src/store.js';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { createInputSchema, fingerprint, validatePreparation, type Runtime } from '../src/contracts.js';
import { awaitingVerdict } from '../src/comparison.js';

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
  await assert.rejects(lab.start(ready.id, { approved: false }), /после вашего подтверждения/);
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
  await assert.rejects(lab.start(result.id, { approved: true }), /только эксперимент, ожидающий проверки/);
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
  await assert.rejects(lab.create(demoInput()), /другая операция/);
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
  await assert.rejects(lab.create(demoInput()), /не открыта/);
  const next = new ExperimentStore(directory); await next.init(); await next.close();
});

test('one writer, validated atomic saves, stale recovery, and isolated corrupt records on restart', async t => {
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
  const recovered = new ExperimentStore(directory);
  await recovered.init();
  assert.equal(JSON.parse(await readFile(join(directory, '.lock'), 'utf8')).pid, process.pid);
  await recovered.close();
  await writeFile(join(directory, `${record.id}.json`), '{"broken":true}');
  const corrupt = new ExperimentLab(directory);
  await corrupt.init();
  assert.deepEqual(await corrupt.list(), []);
  assert.equal(corrupt.store.diagnostics[0]?.id, record.id);
  assert.equal(await readFile(join(directory, `${record.id}.json`), 'utf8'), '{"broken":true}');
  await corrupt.close();
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
  await assert.rejects(lab.create(demoInput()), /не открыта/);
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

test('провалы прогона получают имена, а сорванная кластеризация не теряет прогон', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-modes-'));
  // Агент, который только обещает: состояние не меняется, значит проверки падают и есть что кластеризовать.
  const base = { ...createDemoRuntime(), async openTarget() { return { respond: async () => 'Готово, перенёс.', close: async () => {} }; } };
  const seen: unknown[] = [];
  const named = {
    ...base,
    async failureModes(input: { task: string; failures: { trialId: string }[] }) {
      seen.push(input);
      return [{ id: 'no_action', name: 'Пообещал перенос и не сделал его', description: 'Ответ утверждает изменение, которого нет в состоянии.', stage: 'действие', trialIds: input.failures.map(f => f.trialId) }];
    },
  };
  const lab = new ExperimentLab(directory, named as never);
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await lab.init();
  const draft = await lab.create({ ...demoInput(), workflow: 'evaluate' as const });
  await lab.waitForIdle();
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(await lab.get(draft.id)) });
  await lab.waitForIdle();
  const done = await lab.get(draft.id);
  assert.ok(done.trials.filter(t => t.outcome === 'fail').length >= 2, 'в демо-прогоне есть что кластеризовать');
  assert.equal(done.failureModes?.length, 1);
  assert.match(done.failureModes![0]!.name, /Пообещал/);
  assert.deepEqual(done.failureModes![0]!.trialIds.sort(), done.trials.filter(t => t.outcome === 'fail').map(t => t.id).sort());
  // Кластеризатору дают только провалившиеся диалоги и их трассы.
  const passed = new Set(done.trials.filter(t => t.outcome !== 'fail').map(t => t.id));
  assert.equal((seen[0] as { failures: { trialId: string }[] }).failures.some(f => passed.has(f.trialId)), false);

  // Сорванный разбор — это оговорка в записи, а не потерянный прогон.
  const brokenDir = await mkdtemp(join(tmpdir(), 'agent-lab-modes-broken-'));
  const broken = new ExperimentLab(brokenDir, { ...base, async failureModes() { throw new Error('судья недоступен'); } } as never);
  t.after(async () => { await broken.close(); await rm(brokenDir, { recursive: true, force: true }); });
  await broken.init();
  const second = await broken.create({ ...demoInput(), workflow: 'evaluate' as const });
  await broken.waitForIdle();
  await broken.start(second.id, { approved: true, reviewer: 'human', expectedHash: draftHash(await broken.get(second.id)) });
  await broken.waitForIdle();
  const survived = await broken.get(second.id);
  assert.equal(survived.phase, 'results_review');
  assert.equal(survived.failureModes, undefined);
  assert.ok(survived.limitations.some(l => /Не удалось назвать типы провалов.*судья недоступен/.test(l)));
});

test('unresolved business questions block approval until new materials produce a new experiment', async t => {
  const runtime = createDemoRuntime(); const prepare = runtime.prepare;
  runtime.prepare = async (...args) => ({ ...await prepare(...args), questions: ['Which timezone applies?'] });
  const { lab } = await setup(t, runtime);
  const record = await lab.create(demoInput()); await lab.waitForIdle();
  await assert.rejects(lab.start(record.id, { approved: true }), /ответьте на бизнес-вопросы/);
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
  await assert.rejects(lab.start(draft.id, { approved: false, reviewer: 'automated', expectedHash: originalHash }), /подтверждения/);
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: 'stale' }), /подтверждение.*версии/);
  const cards = structuredClone(draft.scenarios);
  cards[0]!.user.persona = 'A busy customer with one appointment';
  const edited = await lab.updateDraft(draft.id, originalHash, { scenarios: cards });
  assert.notEqual(draftHash(edited), originalHash); assert.equal(edited.reviewedAt, null);
  await assert.rejects(lab.updateDraft(draft.id, originalHash, { scenarios: cards }), /Черновик изменился/);
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: originalHash }), /подтверждение.*версии/);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(edited) }); await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'results_review', result.error ?? ''); assert.equal(result.reviewMode, 'human');
  assert.equal(result.revisions.length, 1); assert.equal(result.comparisons.length, 0); assert.equal(improvements, 0);
  assert.equal(targets, 1); assert.equal(result.trials.length, 1); assert.ok(result.trials[0]!.assessments?.length);
  assert.equal(result.manifestHash, measurementHash(result));
  await assert.rejects(lab.updateDraft(draft.id, draftHash(result), { scenarios: cards }), /незапущенный черновик/);
  const originalTrial = structuredClone(result.trials[0]!);
  const priorResultHash = resultHash(result);
  await assert.rejects(lab.addHumanReview(result.id, { trialId: 'missing', verdict: 'invalid', note: 'Wrong user.' }), /Такого диалога/);
  await assert.rejects(lab.addHumanReview(result.id, { trialId: originalTrial.id, metricId: 'missing', verdict: 'fail', note: 'Wrong metric.' }), /Такой рубрики/);
  const annotated = await lab.addHumanReview(result.id, {
    trialId: originalTrial.id, metricId: result.scenarios[0]!.metrics![0]!.id, verdict: 'unknown', note: 'Need the real pilot before accepting this estimate.',
  });
  assert.deepEqual(annotated.trials[0], originalTrial); assert.equal(annotated.humanReviews!.length, 1);
  await assert.rejects(lab.reviewResults(result.id, priorResultHash), /Результаты изменились/);
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
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }), /другая операция/);
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
    await assert.rejects(lab.updateDraft(draft.id, draftHash(draft), { scenarios }), /другая операция/);
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
  await assert.rejects(lab.create(compare), /в одном режиме пользователя/);
  await assert.rejects(lab.create(createInputSchema.parse({ ...demoInput(), target: { kind: 'http', url: 'http://localhost:1' } })), /внешнего агента/);
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

test('a missing target yields a recoverable explanation and a rejected connection edit leaves the draft intact', async t => {
  const { lab, directory } = await setup(t);
  const input = createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1, target: { kind: 'module', path: join(directory, 'missing.mjs') } });
  const created = await lab.create(input); await lab.waitForIdle();
  const failed = await lab.get(created.id);
  assert.equal(failed.phase, 'error'); assert.match(failed.error!, /Не найден файл агента/); assert.doesNotMatch(failed.error!, /ENOENT|stat '/);
  assert.equal(failed.usage.calls, 0);
  const next = await lab.create(createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1 })); await lab.waitForIdle();
  const draft = await lab.get(next.id);
  await assert.rejects(lab.updateDraft(draft.id, draftHash(draft), { target: input.target }), /Не найден файл агента/);
  assert.equal(draftHash(await lab.get(draft.id)), draftHash(draft));
});

test('profile edits preserve evidence, update linked cards, invalidate approval and survive a run and repeat', async t => {
  const runtime = createDemoRuntime();
  const users: unknown[] = []; const userTurn = runtime.userTurn;
  runtime.userTurn = async (input, ctx) => { users.push(structuredClone(input.user)); return userTurn(input, ctx); };
  const { lab } = await setup(t, runtime);
  const created = await lab.create(createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 2, settings: { repeats: 1 },
    dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'move A101 to 14:00 pls' }] }],
  }));
  await lab.waitForIdle();
  const draft = await lab.get(created.id); assert.equal(draft.phase, 'review', draft.error ?? '');
  const original = structuredClone(draft.profiles[0]!);
  const id = original.id;
  const edit = { id, override: { persona: null, characteristics: ['Answers only the question asked'] } };
  const edited = await lab.updateDraft(draft.id, draftHash(draft), { profileEdits: [edit] });
  assert.deepEqual(edited.profiles[0], { ...original, draftOverride: edit.override });
  assert.ok(edited.scenarios.some(s => s.provenance === 'production'));
  assert.ok(edited.scenarios.every(s => s.profileId === id && !s.user.persona));
  assert.ok(edited.scenarios.every(s => s.user.characteristics?.[0] === edit.override.characteristics[0]));
  assert.notEqual(draftHash(edited), draftHash(draft)); assert.notEqual(measurementHash(edited), measurementHash(draft));
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }), /подтверждение.*версии/);
  for (const profileEdits of [[{ id: 'unknown', override: null }], [edit, edit], [{ id, override: { source: 'owner' } }]]) {
    await assert.rejects(lab.updateDraft(draft.id, draftHash(edited), { profileEdits } as never));
    assert.deepEqual(await lab.get(draft.id), JSON.parse(JSON.stringify(edited)), 'a rejected edit must leave the saved draft intact');
  }
  const silentEdit = structuredClone(edited.scenarios); silentEdit[0]!.user.persona = 'Would be overwritten';
  await assert.rejects(lab.updateDraft(draft.id, draftHash(edited), { scenarios: silentEdit }), /profileEdits/);
  const restored = await lab.updateDraft(draft.id, draftHash(edited), { profileEdits: [{ id, override: null }] });
  assert.deepEqual(restored.profiles[0], original); assert.deepEqual(restored.scenarios, draft.scenarios);
  const cleared = await lab.updateDraft(draft.id, draftHash(restored), { profileEdits: [{ id, override: { persona: null, characteristics: [] } }] });
  // Scripted fixture consent: exercise the same freeze/run boundary used by the human Pi UI.
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(cleared) }); await lab.waitForIdle();
  const result = await lab.get(draft.id); assert.equal(result.phase, 'results_review', result.error ?? '');
  assert.ok(users.length); assert.ok(users.every(u => !(u as { persona?: string }).persona));
  await assert.rejects(lab.updateDraft(draft.id, draftHash(result), { profileEdits: [{ id, override: null }] }), /незапущенный черновик/);
  const repeated = await lab.repeat(result.id);
  assert.deepEqual(repeated.profiles, cleared.profiles); assert.deepEqual(repeated.scenarios, cleared.scenarios);
  assert.equal(repeated.phase, 'review'); assert.equal(repeated.reviewMode, null); assert.equal(repeated.trials.length, 0);
});

test('logs yield production goals even when no meaningful profile can be extracted', async t => {
  const runtime = createDemoRuntime(); runtime.profiles = async () => [];
  const prepare = runtime.prepare;
  runtime.prepare = async (input, ctx) => {
    const result = await prepare(input, ctx);
    for (const scenario of result.scenarios) { delete scenario.user.persona; delete scenario.user.characteristics; }
    return result;
  };
  const { lab } = await setup(t, runtime);
  const created = await lab.create(createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1,
    dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'move A101 to 14:00 pls' }] }],
  }));
  await lab.waitForIdle(); const draft = await lab.get(created.id);
  assert.equal(draft.phase, 'review', draft.error ?? ''); assert.deepEqual(draft.profiles, []);
  assert.equal(draft.scenarios.length, 2); assert.ok(draft.scenarios.every(s => !s.profileId && !s.user.persona));
  assert.equal(draft.scenarios.find(s => s.provenance === 'production')!.user.opening, 'move A101 to 14:00 pls');
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
  const edited = await lab.updateDraft(draft.id, draftHash(draft), { settings: { repeats: 2 } });
  assert.equal(edited.scenarios[0]!.profileId, 'hurried_owner');
  assert.equal(edited.settings.repeats, 2);
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

test('repeat keeps the approved suite, discards results and requires fresh approval; target drift blocks execution', async t => {
  const { lab, directory } = await setup(t);
  const path = join(directory, 'target.mjs');
  await writeFile(path, 'export function createSession() { return { respond: () => "hello" }; }');
  const input = createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1,
    target: { kind: 'module', path }, targetVersion: 'v1', settings: { ...demoInput().settings, repeats: 1, userModes: ['static'] } });
  const created = await lab.create(input); await lab.waitForIdle();
  let draft = await lab.get(created.id);
  await assert.rejects(lab.repeat(draft.id), /утверждёнными/);
  await writeFile(path, 'export function createSession() { return { respond: () => "new answer" }; }');
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }), /изменил/);
  draft = await lab.updateDraft(draft.id, draftHash(draft), { targetVersion: 'v2' });
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const before = await lab.get(draft.id);
  assert.equal(before.phase, 'results_review', before.error ?? '');
  const after = await lab.repeat(before.id);
  assert.notEqual(after.id, before.id); assert.equal(after.parentRunId, before.id);
  assert.deepEqual(after.scenarios, before.scenarios); assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(after.trials, []); assert.deepEqual(after.humanReviews, []); assert.equal(after.reviewedAt, null);
  assert.equal(after.targetVersion, 'v2'); assert.equal(after.phase, 'review');
  assert.deepEqual((await lab.get(before.id)).trials, before.trials);
  await assert.rejects(lab.start(after.id, { approved: false, reviewer: 'automated', expectedHash: draftHash(after) }), /подтверждения/);
});

test('rubric-only agent failures reach clustering', async t => {
  const runtime = createDemoRuntime();
  const prepare = runtime.prepare;
  runtime.prepare = async (...args) => { const p = await prepare(...args); p.scenarios.forEach(s => { s.checks = []; }); return p; };
  runtime.assess = async ({ scenario }) => scenario.metrics!.map(m => ({ metricId: m.id, result: m.subject === 'agent' ? 'fail' : 'pass', rationale: 'evidence', evidence: [0] }));
  runtime.failureModes = async ({ failures }) => [{ id: 'goal_failed', name: 'Цель не достигнута', description: 'Рубрика зафиксировала провал цели.', trialIds: failures.map(f => f.trialId) }];
  const { lab } = await setup(t, runtime);
  const created = await lab.create({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1 }); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.ok(result.trials.every(t => t.outcome === 'ungraded'));
  assert.deepEqual(result.failureModes?.[0]?.trialIds, result.trials.map(t => t.id));
});

test('one-card edits preserve neighbours; only explicit removals delete and invalid changes save nothing', async t => {
  const { lab } = await setup(t);
  const created = await lab.create({ ...demoInput(), workflow: 'evaluate', scenarioCount: 5 }); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  const changed = { ...draft.scenarios[1]!, title: 'Только вторая карточка' };
  const edited = await lab.updateDraft(draft.id, draftHash(draft), { scenarios: [changed] });
  assert.equal(edited.scenarios.length, 5);
  assert.deepEqual(edited.scenarios.map(s => s.id), draft.scenarios.map(s => s.id));
  assert.deepEqual(edited.scenarios.filter(s => s.id !== changed.id), draft.scenarios.filter(s => s.id !== changed.id));
  assert.match(edited.message, /изменено 1, добавлено 0, удалено 0/);
  const extra = { ...changed, id: 'new_card', title: 'Новая карточка' };
  const updated = await lab.updateDraft(draft.id, draftHash(edited), { scenarios: [extra], removeScenarioIds: [draft.scenarios[0]!.id] });
  assert.equal(updated.scenarios.length, 5);
  assert.equal(updated.scenarios.at(-1)!.id, extra.id);
  assert.equal(updated.scenarios.some(s => s.id === draft.scenarios[0]!.id), false);
  assert.match(updated.message, /изменено 0, добавлено 1, удалено 1/);
  const hash = draftHash(updated);
  const saved = await lab.get(draft.id);
  for (const patch of [
    { removeScenarioIds: ['missing'] }, { removeScenarioIds: updated.scenarios.map(s => s.id) },
    { scenarios: [{ ...changed, user: { ...changed.user, maxFollowUps: -1 } }] },
    { scenarios: [{ ...changed, profileId: 'missing_profile' }] },
    { scenarios: [changed], settings: { repeats: 0 } },
  ]) {
    await assert.rejects(lab.updateDraft(draft.id, hash, patch));
    assert.deepEqual(await lab.get(draft.id), saved);
  }
  await assert.rejects(lab.updateDraft(draft.id, draftHash(draft), { scenarios: [changed] }), /Черновик изменился/);
  assert.deepEqual(await lab.get(draft.id), saved);
});

test('finalizing requires decisive failure review and preserves original evidence', async t => {
  const { lab } = await setup(t);
  const input = createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 2, settings: { repeats: 1 } });
  const created = await lab.create(input); await lab.waitForIdle();
  let draft = await lab.get(created.id);
  draft = await lab.updateDraft(draft.id, draftHash(draft), { agent: { ...draft.revisions[0]!.spec, tools: ['search_materials', 'lookup_record'] } });
  assert.match(draft.message, /Агент обновлён/);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  let result = await lab.get(draft.id);
  const original = structuredClone(result.trials);
  assert.equal(awaitingVerdict(result).size, 2);
  await assert.rejects(lab.reviewResults(result.id, resultHash(result)), /2.*без решения/);
  result = await lab.addHumanReview(result.id, { trialId: result.trials[0]!.id, verdict: 'unknown', note: 'Нужен разбор.' });
  await assert.rejects(lab.reviewResults(result.id, resultHash(result)), /без решения/);
  for (const trial of result.trials) {
    for (const check of trial.checks.filter(c => !c.passed)) result = await lab.addHumanReview(result.id, { trialId: trial.id, checkId: check.id, verdict: 'fail', note: 'Проверено по состоянию.' });
    for (const assessment of trial.assessments?.filter(a => a.result === 'fail') ?? []) result = await lab.addHumanReview(result.id, { trialId: trial.id, metricId: assessment.metricId, verdict: 'fail', note: 'Проверено по трассе.' });
  }
  assert.equal(awaitingVerdict(result).size, 0);
  const completed = await lab.reviewResults(result.id, resultHash(result));
  assert.equal(completed.phase, 'complete');
  assert.deepEqual(completed.trials, original);
  const reopened = await lab.addHumanReview(result.id, { trialId: result.trials[0]!.id, checkId: result.trials[0]!.checks.find(c => !c.passed)!.id, verdict: 'unknown', note: 'Предыдущее решение пересмотрено.' });
  assert.equal(reopened.phase, 'results_review');
  await assert.rejects(lab.reviewResults(result.id, resultHash(reopened)), /без решения/);
});

test('the active snapshot names the current card and target wait before a trial finishes', async t => {
  const runtime = createDemoRuntime();
  const entered = deferred(); const release = deferred();
  const grading = deferred(); const releaseGrading = deferred();
  const assess = runtime.assess!;
  runtime.openTarget = async () => ({ async respond() { entered.resolve(); await release.promise; return 'Ответ'; }, async close() {} });
  runtime.assess = async (...args) => { grading.resolve(); await releaseGrading.promise; return assess(...args); };
  const { lab } = await setup(t, runtime);
  const created = await lab.create(createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1, settings: { repeats: 1 } })); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) });
  await entered.promise;
  try {
    const active = await lab.get(draft.id);
    assert.equal(active.trials.length, 0);
    assert.ok(active.message.includes(draft.scenarios[0]!.title));
    assert.match(active.message, /диалог 1\/1.*ответ агента/);
    const journal = await lab.store.traceJournal(draft.id);
    assert.match(journal, /"type":"user"/);
    release.resolve(); await grading.promise;
    assert.match((await lab.get(draft.id)).message, /диалог 1\/1.*оценка критериев/);
  } finally { release.resolve(); releaseGrading.resolve(); await lab.waitForIdle(); }
});

test('static connection failures precede model work and a vanished target cannot receive approval', async t => {
  const { lab, directory } = await setup(t);
  const entry = join(directory, 'agent.mjs'); await writeFile(entry, '// local target fixture');
  const input = createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1,
    target: { kind: 'command', command: 'agent-lab-no-such-executable-fixture', args: [entry] } });
  const created = await lab.create(input); await lab.waitForIdle();
  const failed = await lab.get(created.id);
  assert.equal(failed.phase, 'error'); assert.equal(failed.usage.calls, 0); assert.equal(failed.trials.length, 0);
  const next = await lab.create({ ...input, target: { kind: 'command', command: process.execPath, args: [entry], timeoutMs: 1000 } }); await lab.waitForIdle();
  const draft = await lab.get(next.id); assert.equal(draft.phase, 'review');
  await rm(entry);
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }), /Не найден файл агента/);
  assert.deepEqual(await lab.get(draft.id), draft);
});
