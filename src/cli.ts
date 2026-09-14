#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { ExperimentLab, draftHash } from './experiment.js';
import { demoInput } from './demo.js';
import { createInputSchema, DEFAULT_JUDGE } from './contracts.js';
import { compareRuns, evidenceSummary, evaluationExitCode } from './comparison.js';
import { doctor, listSuites, readConnection, rememberedConnection, rememberConnection } from './connection.js';
import { inspectPrompt, promptVersion, proposePrompt } from './prompt-edit.js';
import { readData } from './imports.js';
import { previewCriteria } from './preview.js';
import { getPiStatus } from './pi.js';
import { auditJudge } from './judge-audit.js';
import { htmlReport, jsonReport, markdownReport } from './report.js';
import { ExperimentStore } from './store.js';
import { evidenceBundle, exportArtifacts } from './artifacts.js';

const percent = (value: number | null) => value === null ? 'нет данных' : `${Math.round(value * 100)}%`;

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'chat' || (!args.length && process.stdin.isTTY)) {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
    const child = spawn(process.execPath, [resolve(piRoot, 'dist/bundle/cli.js'), '--no-extensions', '--no-skills', '-e', resolve(root, 'extensions/agent-lab.ts'),
      '--skill', resolve(root, 'skills/agent-builder/SKILL.md'), ...args.slice(args[0] === 'chat' ? 1 : 0)],
    { stdio: 'inherit', env: { ...process.env, AGENT_LAB_SESSION: '1' } });
    process.exitCode = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1))); });
    return;
  }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'data-dir': { type: 'string' }, input: { type: 'string' }, id: { type: 'string' }, output: { type: 'string' },
    before: { type: 'string' }, after: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    format: { type: 'string', default: 'json' }, json: { type: 'boolean' },
    connection: { type: 'string' }, directory: { type: 'string' }, 'code-only': { type: 'boolean' },
    'golden-file': { type: 'string' }, 'dialogues-file': { type: 'string' }, candidate: { type: 'string' },
    hypothesis: { type: 'string' }, trial: { type: 'string', multiple: true }, scenario: { type: 'string' },
    yes: { type: 'boolean' }, repeats: { type: 'string' }, case: { type: 'string', multiple: true },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write('  agent-lab audit-judge --id RUN --output NEW_DIRECTORY --repeats 10 --yes\n');
    process.stdout.write('  agent-lab preview --id RUN --scenario CASE --input examples.json --yes\n');
    process.stdout.write('Agent Lab — проверьте, что сломала правка вашего агента.\n\n  agent-lab                         Диалог в текущем проекте\n  agent-lab chat [опции Pi]          Напишите задачу обычными словами\n  agent-lab save-suite --id RUN --output .evals/regression.json [--case ID]\n  agent-lab evaluate --input .evals/regression.json --yes [--case ID]\n\nevaluate: 0 — все оценки пройдены; 1 — зарегистрирован провал; 2 — ошибка теста/среды или неполные данные.\n--yes разрешает расход в пределах сохранённых лимитов; ручной оценкой ожиданий это не считается.\n\n');
    process.stdout.write('  agent-lab doctor --connection connection.json --yes\n  agent-lab suites --directory .evals\n  agent-lab reassess --id RUN [--input criteria.json] --yes\n  agent-lab reassess --id RUN --code-only\n  agent-lab prompt-propose --id RUN --candidate prompt.md --hypothesis TEXT --trial TRIAL\n  agent-lab prompt-apply --input proposal.json --yes\n  agent-lab pilot --id RUN\n  evaluate принимает --connection; build — --golden-file и --dialogues-file (JSON/JSONL).\n\n');
    process.stdout.write('Дополнительно: clarify --id RUN --input answers.json · run --id RUN --yes · build --input task.json · repeat --id RUN · diff --before RUN --after RUN · export --id RUN --format html --output report.html · status.\nКонтракты подключения: docs/REFERENCE.md.\n'); return;
  }
  if (command === 'status') { process.stdout.write(`${JSON.stringify(await getPiStatus(), null, 2)}\n`); return; }
  const directory = values['data-dir'] ?? resolve('.agent-lab');
  if (command === 'preview') {
    if (!values.id || !values.scenario || !values.input || !values.yes && !values['code-only']) throw new Error('Укажите --id RUN --scenario CASE --input examples.json и --yes (судья) или --code-only. Формат: {good, bad}.');
    const record = await new ExperimentStore(directory).get(values.id);
    const output = await previewCriteria(record, values.scenario, JSON.parse(await readFile(values.input, 'utf8')), { directory, codeOnly: values['code-only'] });
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    process.exitCode = output.results.some(r => r.result === 'unknown') ? 2 : output.results.every(r => r.matchesExpected) ? 0 : 1;
    return;
  }
  if (command === 'suites') { process.stdout.write(JSON.stringify(await listSuites(values.directory ?? '.evals'), null, 2) + '\n'); return; }
  if (command === 'doctor') {
    const connection = values.connection ? await readConnection(values.connection) : await rememberedConnection(directory);
    if (!connection?.probe) throw new Error('Укажите --connection с probe.write/read/reset и initialState.');
    if (!values.yes) { process.stdout.write(JSON.stringify({ target: connection.target, probe: connection.probe, requests: 3 }, null, 2) + '\n'); throw new Error('Для трёх пробных запросов укажите --yes.'); }
    const result = await doctor(connection);
    if (result.passed) await rememberConnection(directory, connection);
    if (values.output) await writeFile(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.passed ? 0 : 2; return;
  }
  if (command === 'pilot') {
    if (!values.id) throw new Error('Укажите --id RUN');
    const record = await new ExperimentStore(directory).get(values.id);
    process.stdout.write(JSON.stringify(evidenceSummary(record).pilot, null, 2) + '\n'); return;
  }
  if (command === 'audit-judge') {
    if (!values.id || !values.output || !values.yes) throw new Error('audit-judge --id RUN --output NEW_DIRECTORY --yes [--repeats 10]. Используются сохранённые лимиты; агент не вызывается.');
    const record = await new ExperimentStore(directory).get(values.id);
    if (record.mode !== 'live') throw new Error('Для измерения модели нужен сохранённый живой прогон.');
    const trials = record.trials.filter(t => ['pass', 'fail', 'ungraded'].includes(t.outcome) && (!values.case || values.case.includes(t.scenarioId)));
    const inputs = trials.flatMap(trial => {
      const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
      return scenario?.metrics?.length ? [{ scenario, sources: record.sources, trial }] : [];
    });
    await auditJudge(inputs, { ...record.settings, judge: record.settings.judge ?? DEFAULT_JUDGE }, resolve(values.output), Number(values.repeats ?? '10'));
    const result = JSON.parse(await readFile(resolve(values.output, 'statistics.json'), 'utf8'));
    process.stdout.write(JSON.stringify({ output: resolve(values.output), ...result }, null, 2) + '\n');
    process.exitCode = !result.complete || result.statistics.pending ? 2 : result.ready ? 0 : 1;
    return;
  }
  // Reading an atomic snapshot must not take the writer lock or mark another process interrupted.
  if (command === 'export' || command === 'diff') {
    const store = new ExperimentStore(directory);
    if (command === 'export') {
      if (!values.id) throw new Error('Укажите прогон: --id EXPERIMENT_ID');
      if (!['json', 'html', 'markdown'].includes(values.format!)) throw new Error('Формат экспорта: json, html или markdown.');
      const bundle = await evidenceBundle(await store.get(values.id), store, values.before);
      const content = values.format === 'html' ? htmlReport(bundle) : values.format === 'markdown' ? markdownReport(bundle) : jsonReport(bundle);
      if (values.output) await writeFile(values.output, content, { mode: 0o600 }); else process.stdout.write(`${content}\n`);
    } else {
      if (!values.before || !values.after) throw new Error('Укажите два прогона: --before RUN_ID --after RUN_ID');
      const [before, after] = await Promise.all([store.get(values.before), store.get(values.after)]);
      const diff = compareRuns(before, after);
      if (values.json) process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
      else process.stdout.write([
        diff.headline, '',
        ...(diff.regressed.length ? ['Сломалось:', ...diff.regressed.map(r => `  - [${r.tier}] ${r.title} (${r.scenarioId})`), ''] : []),
        ...(diff.fixed.length ? ['Исправлено:', ...diff.fixed.map(r => `  + [${r.tier}] ${r.title} (${r.scenarioId})`), ''] : []),
        ...(diff.stages.length ? ['По этапам работы агента:', ...diff.stages.map(st => `  ${st.stage}: ${percent(st.before)} → ${percent(st.after)}`), ''] : []),
        'По ступеням:', ...diff.tiers.filter(t => t.before.graded || t.after.graded).map(t => `  ${t.tier}: ${t.before.passed}/${t.before.graded} → ${t.after.passed}/${t.after.graded}`), '',
        ...(diff.notes.length ? ['Оговорки:', ...diff.notes.map(n => `  · ${n}`), ''] : []),
      ].join('\n') + '\n');
      if (!diff.comparable) process.exitCode = 2;
    }
    return;
  }
  if (!['demo', 'prepare', 'build', 'repeat', 'run', 'save-suite', 'evaluate', 'reassess', 'clarify', 'prompt-propose', 'prompt-apply'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === 'evaluate' && (!values.input || !values.yes)) throw new Error('Для запуска сохранённых тестов укажите --input suite.json --yes. Лимиты и подключение берутся из файла.');
  const lab = new ExperimentLab(directory);
  await lab.init();
  const cancel = () => { void lab.close().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    let id = values.id;
    if (command === 'clarify') {
      if (!id || !values.input) throw new Error('Укажите --id RUN --input answers.json с массивом question/answer.');
      process.stdout.write(JSON.stringify(await lab.clarify(id, JSON.parse(await readFile(values.input, 'utf8'))), null, 2) + '\n'); return;
    }
    if (command === 'prompt-propose') {
      if (!id || !values.candidate || !values.hypothesis || !values.trial?.length) throw new Error('Укажите --id RUN --candidate prompt.md --hypothesis TEXT --trial TRIAL.');
      const result = await proposePrompt(directory, await lab.get(id), { candidate: await readFile(values.candidate, 'utf8'), hypothesis: values.hypothesis, trialIds: values.trial });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return;
    }
    if (command === 'prompt-apply') {
      if (!values.input) throw new Error('Укажите --input proposal.json.');
      const proposal = await inspectPrompt(values.input);
      process.stdout.write(proposal.diff + '\n');
      if (!values.yes) throw new Error('Для подготовки отдельной версии укажите --yes после просмотра diff.');
      const draft = await promptVersion(lab, values.input, proposal.reviewHash);
      process.stdout.write(JSON.stringify({ id: draft.id, phase: draft.phase, target: draft.target,
        nextStep: `agent-lab run --id ${draft.id} --yes` }, null, 2) + '\n'); return;
    }
    if (command === 'reassess') {
      if (!id || (!values.yes && !values['code-only'])) throw new Error('Укажите --id RUN и --yes (модель) или --code-only (без модели).');
      const patch = values.input ? JSON.parse(await readFile(values.input, 'utf8')) : {};
      const draft = await lab.reassess(id, { ...patch, ...(values.trial ? { trialIds: values.trial } : {}), ...(values['code-only'] ? { codeOnly: true } : {}) });
      await lab.waitForIdle();
      const record = await lab.get(draft.id);
      const bundle = await evidenceBundle(record, lab.store);
      process.stdout.write(JSON.stringify({ id: record.id, phase: record.phase, assessmentOf: record.assessmentOf,
        evaluatorVersion: record.evaluatorVersion, artifacts: await exportArtifacts(bundle, directory), evidence: bundle.evidence }, null, 2) + '\n');
      process.exitCode = record.phase === 'results_review' && !record.trials.some(t => t.assessmentError || ['invalid', 'cancelled'].includes(t.outcome)) ? 0 : 2; return;
    }
    if (command === 'save-suite') {
      if (!id || !values.output) throw new Error('Укажите --id RUN --output .evals/regression.json.');
      process.stdout.write(`${await lab.saveSuite(id, values.output, values.case)}\n`); return;
    }
    if (command === 'evaluate') {
      const draft = await lab.loadSuite(values.input!, values.case, values.connection ? await readConnection(values.connection) : undefined);
      await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) });
      await lab.waitForIdle();
      const record = await lab.get(draft.id);
      const bundle = await evidenceBundle(record, lab.store, values.before);
      const artifacts = await exportArtifacts(bundle, lab.store.directory);
      const v = evidenceSummary(record).verdict;
      process.exitCode = evaluationExitCode(record);
      process.stdout.write(JSON.stringify({ id: record.id, exitCode: process.exitCode, verdict: v, comparison: bundle.comparison, artifacts }, null, 2) + '\n');
      return;
    }
    if (command === 'demo' || command === 'prepare' || command === 'build') {
      if (command !== 'demo' && !values.input) throw new Error('Provide --input task.json');
      const raw = command === 'demo' ? demoInput() : JSON.parse(await readFile(values.input!, 'utf8'));
      const connection = command === 'demo' ? undefined : values.connection ? await readConnection(values.connection) : !raw.target ? await rememberedConnection(directory) : undefined;
      const input = createInputSchema.parse({ ...raw, ...(connection ? { target: connection.target, targetVersion: connection.targetVersion } : {}),
        ...(values['golden-file'] ? { goldenCases: await readData(values['golden-file'], 'golden') } : {}),
        ...(values['dialogues-file'] ? { dialogues: await readData(values['dialogues-file'], 'dialogues') } : {}) });
      const prepared = await lab.create(input); id = prepared.id; await lab.waitForIdle();
      const current = await lab.get(id);
      if (current.phase !== 'review') throw new Error(current.error ?? 'Preparation failed');
      if (command === 'prepare' || command === 'build') { process.stdout.write(`${JSON.stringify(current, null, 2)}\n`); return; }
    }
    if (!id) throw new Error('Укажите прогон: --id EXPERIMENT_ID');
    if (command === 'repeat') {
      const record = await lab.repeat(id, values.case);
      process.stdout.write(`${JSON.stringify({ id: record.id, phase: record.phase, parentRunId: record.parentRunId, targetVersion: record.targetVersion, nextStep: 'Откройте /agent-lab в Pi, проверьте версию агента и подтвердите запуск.' }, null, 2)}\n`);
    } else if (command === 'run' || command === 'demo') {
      const draft = await lab.get(id);
      if (command === 'run' && !values.yes) throw new Error('Для запуска согласованных тестов укажите --yes.');
      await lab.start(id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
      const result = await lab.get(id);
      process.stdout.write(`${JSON.stringify({ id, phase: result.phase, mode: result.mode, reviewMode: result.reviewMode, ...(result.workflow === 'evaluate' ? { verdict: evidenceSummary(result).verdict, exitCode: evaluationExitCode(result) } : {}), comparison: result.comparisons.at(-1), artifact: resolve(lab.store.directory, `${id}.json`) }, null, 2)}\n`);
      if (result.workflow === 'evaluate') process.exitCode = evaluationExitCode(result);
      if (!['complete', 'results_review'].includes(result.phase)) throw new Error(result.error ?? 'Experiment did not complete');
    } else throw new Error(`Unknown command: ${command}`);
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await lab.close();
  }
}
void main().catch(error => { process.stderr.write(`Agent Lab: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = ['evaluate', 'audit-judge'].includes(process.argv[2] ?? '') ? 2 : 1; });
