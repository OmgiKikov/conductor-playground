import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { ExperimentLab, draftHash, resultHash } from '../src/experiment.js';
import { createDemoRuntime, demoEvaluationInput } from '../src/demo.js';
import { draftPatchSchema, scriptIssue } from '../src/contracts.js';
import { awaitingVerdict, compareRuns, compareUserModes, verdictSummary } from '../src/comparison.js';
import { evaluateTrial } from '../src/evaluation.js';
import { htmlReport } from '../src/report.js';

test('a failed case becomes a reusable regression test without changing provenance or inventing review', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-product-'));
  const lab = new ExperimentLab(join(directory, 'runs'), createDemoRuntime());
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await lab.init();
  let draft = await lab.create(demoEvaluationInput()); await lab.waitForIdle(); draft = await lab.get(draft.id);
  const originalSettings = { ...draft.settings, provider: 'fixture', model: 'fixture', maxCalls: 20, maxDurationMs: 180000 };
  draft = await lab.updateDraft(draft.id, draftHash(draft), { settings: originalSettings });
  const patch = draftPatchSchema.parse({ settings: { userModes: ['reactive'] } });
  assert.deepEqual(patch.settings, { userModes: ['reactive'] });
  draft = await lab.updateDraft(draft.id, draftHash(draft), patch);
  assert.deepEqual(draft.settings, originalSettings);
  const scenario = draft.scenarios[0]!;
  await assert.rejects(lab.updateDraft(draft.id, draftHash(draft), { scenarios: [{ ...scenario, successCriteria: 'Now require 18:00' }] }), /исполняемые проверки остались прежними/);
  const malformed = { ...scenario, user: { ...scenario.user, maxFollowUps: 1, script: [scenario.user.opening, 'Now 18:00'] } };
  assert.match(scriptIssue(malformed.user, 4)!, /только реплики после opening/);
  let calls = 0;
  const invalid = await evaluateTrial({ runtime: createDemoRuntime(), revision: draft.revisions[0]!, scenario: malformed, repeat: 0, userMode: 'scripted',
    manifestHash: 'test', sources: draft.sources, settings: draft.settings, target: draft.target,
    ctx: { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() { calls++; }, addUsage() {} } });
  assert.equal(invalid.outcome, 'invalid'); assert.equal(calls, 0);
  assert.deepEqual(invalid.events.filter(e => e.type === 'user'), []);
  await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const before = await lab.get(draft.id);
  assert.equal(before.trials.length, 3);
  assert.equal(before.trials.filter(t => t.outcome === 'pass').length, 1, 'demo includes a passing read-only regression guard');
  assert.equal(before.reviewMode, 'automated'); assert.deepEqual(before.humanReviews, []);
  const failure = before.trials.find(t => t.outcome === 'fail')!;
  let reviewed = await lab.addHumanReview(before.id, { trialId: failure.id, verdict: 'invalid', note: 'Synthetic test of invalid classification; not owner review.' });
  assert.equal(awaitingVerdict(reviewed).has(failure.id), false);
  assert.equal(verdictSummary(reviewed).review.invalid, 1);
  assert.equal(verdictSummary(reviewed).review.reviewed, 1);
  assert.match(verdictSummary(reviewed).headline, /Качество агента по ним не установлено/);
  for (const id of awaitingVerdict(reviewed)) reviewed = await lab.addHumanReview(before.id, { trialId: id, verdict: 'fail', note: 'Synthetic fixture: missing update tool.' });
  reviewed = await lab.reviewResults(before.id, resultHash(reviewed));
  assert.deepEqual(reviewed.trials, before.trials, 'classification never rewrites original evidence');

  const file = await lab.saveSuite(before.id, join(directory, '.evals', 'regression.json'));
  await assert.rejects(lab.saveSuite(before.id, file), /EEXIST/);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(stored.definition.trials, []); assert.equal(stored.definition.reviewMode, null);
  let loaded = await lab.loadSuite(file, [scenario.id]);
  assert.equal(loaded.scenarios.length, 1); assert.equal(loaded.scenarios[0]!.provenance, scenario.provenance);
  assert.equal(loaded.usage.calls, 0, 'loading a test does not call a model');
  loaded = await lab.updateDraft(loaded.id, draftHash(loaded), { agent: { ...loaded.revisions[0]!.spec, tools: ['search_materials', 'lookup_record', 'update_record'] } });
  await lab.start(loaded.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(loaded) }); await lab.waitForIdle();
  const after = await lab.get(loaded.id);
  const comparison = compareRuns(before, after);
  assert.equal(comparison.comparable, true); assert.equal(comparison.fixed.length, 1);
  assert.match(comparison.headline, /Выбранные тесты \(1\/3\)/);
  assert.ok(comparison.notes.some(note => /Остальной.*не проверен/.test(note)));
  const rejectedTest = compareRuns(reviewed, after);
  assert.equal(rejectedTest.comparable, false, 'a human-invalidated test cannot establish an agent fix');
  assert.equal(rejectedTest.coverage.invalidBefore, 1); assert.deepEqual(rejectedTest.fixed, []);
  const invalidAfter = await lab.addHumanReview(after.id, { trialId: after.trials[0]!.id, verdict: 'invalid', note: 'Synthetic fixture: invalid measurement after the change.' });
  assert.equal(compareRuns(before, invalidAfter).coverage.invalidAfter, 1);
  assert.deepEqual(compareRuns(before, invalidAfter).fixed, []);
  assert.equal(verdictSummary({ ...reviewed, trials: reviewed.trials.filter(t => t.id !== failure.id) }).review.invalid, 0, 'a selected subset ignores reviews of other attempts');
  const missingBaseline = { ...after, settings: { ...after.settings, userModes: ['static', 'reactive'] as const as ['static', 'reactive'] }, trials: [{ ...failure, userMode: 'reactive' as const }] };
  assert.deepEqual(compareUserModes(missingBaseline).find(m => m.userMode === 'reactive')!.uniqueFailedChecks, []);

  const failedCLI = spawnSync(process.execPath, [resolve('dist/cli.js'), 'evaluate', '--input', file, '--yes', '--case', scenario.id, '--data-dir', join(directory, 'ci-fail')], { encoding: 'utf8' });
  assert.equal(failedCLI.status, 1, failedCLI.stderr);
  const fixedFile = await lab.saveSuite(after.id, join(directory, '.evals', 'fixed.json'));
  const passedCLI = spawnSync(process.execPath, [resolve('dist/cli.js'), 'evaluate', '--input', fixedFile, '--yes', '--data-dir', join(directory, 'ci-pass')], { encoding: 'utf8' });
  assert.equal(passedCLI.status, 0, passedCLI.stderr);
  assert.equal(JSON.parse(passedCLI.stdout).verdict.execution.completed, 1);
});

test('Python reference adapter retains state within a dialogue and resets in a new process', () => {
  const initialState = { records: { A101: { time: '09:00' } } };
  const requests = ['Move A101 to 14:00', 'Thank you.'].map(message => JSON.stringify({ type: 'respond', message, initialState })).join('\n') + '\n';
  for (let i = 0; i < 2; i++) {
    const run = spawnSync('python3', ['examples/echo-agent.py'], { input: requests, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const replies = run.stdout.trim().split('\n').map(s => JSON.parse(s));
    assert.deepEqual(replies.map(r => r.records.A101.time), ['14:00', '14:00']);
    assert.equal(replies[0].events[0].result.record.time, '09:00');
  }
});

test('report links reveal their dialogue and event with only the fixed CSP-authorized script', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-navigation-'));
  const lab = new ExperimentLab(directory, createDemoRuntime());
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await lab.init();
  const created = await lab.create(demoEvaluationInput()); await lab.waitForIdle();
  const record = await lab.get(created.id);
  record.task = '<script>evil()</script>';
  const html = htmlReport(record);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const code = scripts[0]![1]!;
  assert.ok(html.includes(`script-src 'sha256-${createHash('sha256').update(code).digest('base64')}'`));
  assert.ok(html.includes('&lt;script&gt;evil()&lt;/script&gt;'));
  const handlers: Record<string, () => void> = {};
  const details = { tagName: 'DETAILS', open: false, parentElement: null };
  let scrolled = false;
  const event = { tagName: 'DIV', parentElement: details, scrollIntoView() { scrolled = true; } };
  runInNewContext(code, { location: { hash: '#example' }, document: { getElementById: () => event, addEventListener() {} }, addEventListener: (name: string, handler: () => void) => { handlers[name] = handler; } });
  handlers.hashchange!();
  assert.equal(details.open, true); assert.equal(scrolled, true);
});
