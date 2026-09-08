#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { ExperimentLab } from './experiment.js';
import { demoInput } from './demo.js';
import { createInputSchema } from './contracts.js';
import { getPiStatus } from './pi.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'data-dir': { type: 'string' }, input: { type: 'string' }, id: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write('Agent Lab — goals, user cards, dialogues and human-reviewed metrics in Pi\n\nPrepare a draft, then use /agent-lab in Pi to edit, approve, run and review its cards.\n\nOptional CLI:\n  agent-lab build --input task.json [--data-dir .agent-lab]\n  agent-lab prepare --input task.json\n  agent-lab export --id EXPERIMENT_ID [--output evidence.json]\n  agent-lab status\n\nLegacy scripted comparison smoke:\n  agent-lab demo [--data-dir .agent-lab]\n  agent-lab run --id LEGACY_COMPARISON_ID\n\nbuild/prepare only save drafts. Human approval is given through the native Pi interface.\n'); return;
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
    if (!id) throw new Error('Provide --id EXPERIMENT_ID');
    if (command === 'run' || command === 'demo') {
      await lab.start(id, { approved: true, reviewer: command === 'run' ? 'human' : 'automated' }); await lab.waitForIdle();
      const result = await lab.get(id);
      process.stdout.write(`${JSON.stringify({ id, phase: result.phase, mode: result.mode, reviewMode: result.reviewMode, comparison: result.comparisons.at(-1), artifact: resolve(lab.store.directory, `${id}.json`) }, null, 2)}\n`);
      if (result.phase !== 'complete') throw new Error(result.error ?? 'Experiment did not complete');
    } else if (command === 'export') {
      const record = await lab.get(id);
      const content = JSON.stringify({ experiment: record, traceJournal: await lab.store.traceJournal(id) }, null, 2);
      if (values.output) await writeFile(values.output, content, { mode: 0o600 }); else process.stdout.write(`${content}\n`);
    } else throw new Error(`Unknown command: ${command}`);
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await lab.close();
  }
}
void main().catch(error => { process.stderr.write(`Agent Lab: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
