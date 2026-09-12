import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ExperimentLab, draftHash } from '../src/experiment.js';
import { demoEvaluationInput, demoInput } from '../src/demo.js';
import { evidenceBundle, exportArtifacts } from '../src/artifacts.js';
import { htmlReport, jsonReport, markdownReport } from '../src/report.js';

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-artifacts-'));
  const lab = new ExperimentLab(directory); await lab.init();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  return { lab, directory };
}
async function twoRuns(t: TestContext) {
  const { lab, directory } = await setup(t);
  const input = demoEvaluationInput(); input.scenarioCount = 1; input.targetVersion = 'before-v1';
  const created = await lab.create(input); await lab.waitForIdle();
  const ready = await lab.get(created.id);
  await lab.start(ready.id, { approved: true, reviewer: 'human', expectedHash: draftHash(ready) }); await lab.waitForIdle();
  const before = await lab.get(ready.id);
  assert.equal(before.trials[0]?.outcome, 'fail');
  const repeated = await lab.repeat(before.id);
  const edited = await lab.updateDraft(repeated.id, draftHash(repeated), {
    agent: { ...repeated.revisions[0]!.spec, tools: [...repeated.revisions[0]!.spec.tools, 'update_record'] }, targetVersion: 'after-v2',
  });
  await lab.start(edited.id, { approved: true, reviewer: 'human', expectedHash: draftHash(edited) }); await lab.waitForIdle();
  const after = await lab.get(edited.id);
  assert.equal(after.trials[0]?.outcome, 'pass');
  return { lab, directory, before, after };
}

test('navigation-independent snapshots export matching comparisons and paired evidence in every format', async t => {
  const { lab, directory, before, after } = await twoRuns(t);
  const reopened = await evidenceBundle(after, lab.store);
  const visited = await evidenceBundle(after, lab.store, before.id);
  assert.deepEqual(visited, reopened);
  assert.equal(reopened.comparisonSource?.kind, 'parent');
  assert.equal(reopened.comparison?.fixed.length, 1);
  assert.deepEqual(reopened.comparison?.pairs.map(p => [p.beforeTrialId, p.afterTrialId]), [[before.trials[0]!.id, after.trials[0]!.id]]);
  const a = await exportArtifacts(reopened, directory);
  const b = await exportArtifacts(visited, directory);
  for (const name of ['report', 'htmlReport', 'snapshot'] as const) {
    assert.equal(await readFile(a[name], 'utf8'), await readFile(b[name], 'utf8'));
    assert.equal((await stat(a[name])).mode & 0o777, 0o600);
  }
  const snapshot = JSON.parse(await readFile(a.snapshot, 'utf8'));
  assert.deepEqual(snapshot.comparison, reopened.comparison);
  assert.deepEqual(snapshot.before, before);
  assert.equal(JSON.parse(await readFile(a.evidence, 'utf8')).id, after.id, 'canonical evidence remains a raw Experiment');
  assert.ok(snapshot.traceJournal.includes(after.trials[0]!.id));
  const html = await readFile(a.htmlReport, 'utf8');
  const markdown = await readFile(a.report, 'utf8');
  for (const text of [html, markdown]) {
    assert.match(text, /before-v1/); assert.match(text, /after-v2/);
    assert.match(text, /cannot update/); assert.match(text, /has been moved/);
    assert.match(text, new RegExp(before.trials[0]!.id)); assert.match(text, new RegExp(after.trials[0]!.id));
  }
  const anchors = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, anchors.size, 'HTML anchors must be unique');
  for (const href of html.matchAll(/href="#([^"]+)"/g)) assert.ok(anchors.has(href[1]), `missing target: ${href[1]}`);
  const different = { ...before, id: 'manually-selected-baseline' }; await lab.store.save(different);
  const explicit = await evidenceBundle(after, lab.store, different.id);
  assert.equal(explicit.comparisonSource?.kind, 'selected');
  assert.match(htmlReport(explicit), /База выбрана вручную/);
});

test('missing parents and journals remain explicit without losing current evidence', async t => {
  const { lab, after } = await twoRuns(t);
  const record = { ...after, parentRunId: 'missing-parent' };
  const bundle = await evidenceBundle(record, {
    get: id => lab.store.get(id),
    traceJournal: async () => { throw new Error('fixture journal unavailable'); },
  });
  assert.equal(bundle.before, undefined); assert.equal(bundle.comparison, undefined);
  assert.equal(bundle.warnings.length, 2);
  assert.equal(bundle.record.trials[0]?.id, after.trials[0]?.id);
  for (const content of [htmlReport(bundle), markdownReport(bundle), jsonReport(bundle)]) {
    assert.match(content, /missing-parent/); assert.match(content, /fixture journal unavailable/);
    assert.match(content, /has been moved/);
  }
});

test('HTML is self-contained, escapes evidence, exposes event anchors and labels whole-dialogue verdicts precisely', async t => {
  const { lab, after } = await twoRuns(t);
  const bundle = await evidenceBundle(after, lab.store);
  bundle.record.task = '<script>alert("x")</script>\n' + 'Long task '.repeat(80);
  bundle.record.trials[0]!.events[0]!.text = '<img src=x onerror=alert(1)>\u001b[31m';
  const html = htmlReport(bundle);
  assert.match(html, /&lt;script&gt;alert/); assert.match(html, /&lt;img src=x/);
  assert.doesNotMatch(html, /<script|<iframe|<img|<link|<form|\u001b\[/i);
  assert.match(html, /default-src 'none'/); assert.match(html, /summary:|:focus-visible/);
  assert.match(html, /Исходная задача и подключение/);
  assert.match(html, /Вердикт на весь диалог/); assert.match(html, /Человек: вердикта нет/);
  assert.doesNotMatch(html, /Человек: не разбирал/);
  const h1 = html.match(/<h1>(.*?)<\/h1>/)?.[1] ?? '';
  assert.ok(h1.length < 180, h1);
  assert.match(html, /Long task/);
});

test('unmeasured code checks and simulator criticism cannot masquerade as absent checks or an agent failure', async t => {
  const { after } = await twoRuns(t);
  const invalid = { ...after, trials: after.trials.map(trial => ({ ...trial, outcome: 'invalid' as const, reason: 'fixture unavailable', checks: [], assessments: [] })) };
  assert.match(htmlReport(invalid), /Проверки заданы, измерений нет/);
  assert.doesNotMatch(htmlReport(invalid), /Кодовых проверок не задано/);
  const rubric = { ...after, scenarios: after.scenarios.map(s => ({ ...s, checks: [] })), trials: after.trials.map(trial => ({ ...trial, outcome: 'ungraded' as const, checks: [], assessments: [
    { metricId: 'demo_follow_ups', result: 'fail' as const, rationale: 'SIMULATOR_CRITICISM', evidence: [0] },
    { metricId: 'demo_task_state', result: 'fail' as const, rationale: 'AGENT_FAILURE', evidence: [0] },
  ] })) };
  const html = htmlReport(rubric);
  const attention = html.match(/<section id="attention">([\s\S]*?)<\/section>/)?.[1] ?? '';
  assert.match(attention, /AGENT_FAILURE/); assert.doesNotMatch(attention, /SIMULATOR_CRITICISM/);
});

test('legacy reports lead with selected control evidence and retain explicit revision and split labels', async t => {
  const { lab } = await setup(t);
  const created = await lab.create(demoInput()); await lab.waitForIdle();
  await lab.start(created.id, { approved: true, reviewer: 'automated' }); await lab.waitForIdle();
  const record = await lab.get(created.id);
  assert.equal(record.phase, 'complete', record.error ?? '');
  const bundle = await evidenceBundle(record, lab.store);
  assert.equal(bundle.evidence.verdict.passed, 8); assert.equal(bundle.evidence.verdict.graded, 8);
  const html = htmlReport(bundle);
  assert.match(html, /Итог по контрольным карточкам выбранной версии/);
  assert.match(html, /Исходная версия: 4\/8 → выбранная версия: 8\/8/);
  assert.match(html, /Исходная версия/); assert.match(html, /Выбранная версия/); assert.match(html, /Карточки разработки/);
  assert.doesNotMatch(html, /Пройдено 24 из 40/);
});

test('a human failure on a green dialogue reaches every export and keeps original results', async t => {
  const { lab, after } = await twoRuns(t);
  const trial = after.trials[0]!;
  const measured = JSON.stringify(trial);
  const reviewed = await lab.addHumanReview(after.id, { trialId: trial.id, verdict: 'fail', note: 'QA: missed requirement <script>not executable</script>' });
  const bundle = await evidenceBundle(reviewed, lab.store);
  assert.equal(bundle.evidence.verdict.review.disagreements, 1);
  assert.equal(JSON.stringify(reviewed.trials[0]), measured);
  const html = htmlReport(bundle);
  assert.match(html, /Человек отметил проблемы: 1/);
  assert.match(html, /Расхождение оценок/);
  assert.match(html, /missed requirement &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>not executable/);
  assert.match(html, new RegExp(`href="#trial-${after.id}-${trial.id}"`));
  assert.match(markdownReport(bundle), /Расхождение оценок/);
  assert.match(jsonReport(bundle), /inspect_human_findings/);
});
