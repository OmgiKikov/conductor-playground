#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { ExperimentLab } from './experiment.js';
import { demoInput } from './demo.js';
import { createInputSchema } from './contracts.js';
import { compareRuns, evidenceSummary } from './comparison.js';
import { getPiStatus } from './pi.js';
import { htmlReport } from './report.js';

const percent = (value: number | null) => value === null ? 'нет данных' : `${Math.round(value * 100)}%`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'data-dir': { type: 'string' }, input: { type: 'string' }, id: { type: 'string' }, output: { type: 'string' },
    before: { type: 'string' }, after: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    format: { type: 'string', default: 'json' }, json: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write('Agent Lab — goals, user cards, dialogues and human-reviewed metrics in Pi\n\nPrepare a draft, then use /agent-lab in Pi to edit, approve, run and review its cards.\n\nOptional CLI:\n  agent-lab build --input task.json [--data-dir .agent-lab]\n  agent-lab prepare --input task.json\n  agent-lab export --id EXPERIMENT_ID [--output evidence.json]   (includes the evidence summary: modes, judge calibration, simulator fidelity)\n  agent-lab diff --before RUN_ID --after RUN_ID                  (same cards, two runs: what got fixed, what broke)\n  agent-lab repeat --id RUN_ID                                (copy the suite into a new draft)\n  agent-lab export --id RUN_ID --format html --output report.html\n  agent-lab status\n\ntask.json fields: task, materials, mode, settings (userModes: static|scripted|reactive), target (sandbox | http | module | command), targetVersion, goldenCases, dialogues, existingAgent.\n\nLegacy scripted comparison smoke:\n  agent-lab demo [--data-dir .agent-lab]\n  agent-lab run --id LEGACY_COMPARISON_ID\n\nbuild/prepare only save drafts. Human approval is given through the native Pi interface.\n'); return;
  }
  if (command === 'status') { process.stdout.write(`${JSON.stringify(await getPiStatus(), null, 2)}\n`); return; }
  const lab = new ExperimentLab(values['data-dir'] ?? resolve('.agent-lab'));
  await lab.init();
  const cancel = () => { void lab.close().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    let id = values.id;
    if (command === 'demo' || command === 'prepare' || command === 'build') {
      if (command !== 'demo' && !values.input) throw new Error('Provide --input task.json');
      const input = command === 'demo' ? demoInput() : createInputSchema.parse(JSON.parse(await readFile(values.input!, 'utf8')));
      const prepared = await lab.create(input); id = prepared.id; await lab.waitForIdle();
      const current = await lab.get(id);
      if (current.phase !== 'review') throw new Error(current.error ?? 'Preparation failed');
      if (command === 'prepare' || command === 'build') { process.stdout.write(`${JSON.stringify(current, null, 2)}\n`); return; }
    }
    if (!id && command !== 'diff') throw new Error('Укажите прогон: --id EXPERIMENT_ID');
    id ??= '';
    if (command === 'repeat') {
      const record = await lab.repeat(id);
      process.stdout.write(`${JSON.stringify({ id: record.id, phase: record.phase, parentRunId: record.parentRunId, targetVersion: record.targetVersion, nextStep: 'Откройте /agent-lab в Pi, проверьте версию агента и подтвердите запуск.' }, null, 2)}\n`);
    } else if (command === 'run' || command === 'demo') {
      await lab.start(id, { approved: true, reviewer: command === 'run' ? 'human' : 'automated' }); await lab.waitForIdle();
      const result = await lab.get(id);
      process.stdout.write(`${JSON.stringify({ id, phase: result.phase, mode: result.mode, reviewMode: result.reviewMode, comparison: result.comparisons.at(-1), artifact: resolve(lab.store.directory, `${id}.json`) }, null, 2)}\n`);
      if (result.phase !== 'complete') throw new Error(result.error ?? 'Experiment did not complete');
    } else if (command === 'diff') {
      if (!values.before || !values.after) throw new Error('Укажите два прогона: --before RUN_ID --after RUN_ID');
      const [before, after] = await Promise.all([lab.get(values.before), lab.get(values.after)]);
      const diff = compareRuns(before, after);
      if (values.json) { process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`); if (!diff.comparable) process.exitCode = 2; return; }
      const lines = [
        '',
        `${diff.headline}`,
        '',
        ...(diff.regressed.length ? ['Сломалось:', ...diff.regressed.map(r => `  - [${r.tier}] ${r.title} (${r.scenarioId})`), ''] : []),
        ...(diff.fixed.length ? ['Исправлено:', ...diff.fixed.map(r => `  + [${r.tier}] ${r.title} (${r.scenarioId})`), ''] : []),
        ...(diff.stages.length ? ['По этапам работы агента:',
          ...diff.stages.map(st => `  ${st.stage}: ${percent(st.before)} → ${percent(st.after)}`), ''] : []),
        'По ступеням:',
        ...diff.tiers.filter(t => t.before.graded || t.after.graded)
          .map(t => `  ${t.tier}: ${t.before.passed}/${t.before.graded} → ${t.after.passed}/${t.after.graded}`),
        '',
        ...(diff.notes.length ? ['Оговорки:', ...diff.notes.map(n => `  · ${n}`), ''] : []),
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
      if (!diff.comparable) process.exitCode = 2;
    } else if (command === 'export') {
      const record = await lab.get(id);
      if (!['json', 'html'].includes(values.format!)) throw new Error('Формат экспорта: json или html.');
      const comparison = record.parentRunId ? compareRuns(await lab.get(record.parentRunId), record) : undefined;
      const content = values.format === 'html' ? htmlReport(record, comparison) : JSON.stringify({ experiment: record, evidence: evidenceSummary(record), comparison, traceJournal: await lab.store.traceJournal(id) }, null, 2);
      if (values.output) await writeFile(values.output, content, { mode: 0o600 }); else process.stdout.write(`${content}\n`);
    } else throw new Error(`Unknown command: ${command}`);
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await lab.close();
  }
}
void main().catch(error => { process.stderr.write(`Agent Lab: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
