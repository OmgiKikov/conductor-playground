import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { fingerprint, type Experiment } from './contracts.js';
import { humanFindings } from './comparison.js';
import { draftHash, type ExperimentLab } from './experiment.js';
import { targetFingerprint } from './target-version.js';
import { readPrompt } from './targets.js';

const proposalSchema = z.strictObject({ format: z.literal('agent-lab-prompt-1'), runId: z.string().uuid(),
  createdAt: z.string(), sourceFile: z.string(), sourceHash: z.string(), candidateHash: z.string(),
  hypothesis: z.string().trim().min(1).max(3000), trialIds: z.array(z.string()).min(1).max(40), draftHash: z.string() });

/** Propose exactly one prompt. Candidate bytes live separately; the original file is never changed. */
export async function proposePrompt(directory: string, record: Experiment, input: { candidate: string; hypothesis: string; trialIds: string[] }) {
  if (record.workflow !== 'evaluate' || record.assessmentOf || !['results_review', 'complete'].includes(record.phase)) throw new Error('Нужен законченный прогон внешнего агента.');
  if (record.target.kind === 'sandbox' || !record.target.promptFile) throw new Error('Укажите target.promptFile; адаптер должен применять переданный prompt и подтверждать promptHash.');
  if (!input.candidate.trim() || Buffer.byteLength(input.candidate) > 96000 || input.candidate.includes('\0')) throw new Error('Кандидат должен быть текстовым промптом до 96 КБ.');
  const findings = humanFindings(record);
  const eligible = new Set(findings.filter(f => f.verdict === 'fail' && f.subject !== 'simulator' && f.subject !== 'test'
    && !findings.some(x => x.trialId === f.trialId && x.subject === 'test' && x.verdict === 'invalid')).map(f => f.trialId));
  if (new Set(input.trialIds).size !== input.trialIds.length || input.trialIds.some(id => !eligible.has(id) || record.trials.find(t => t.id === id)?.split !== 'dev')) {
    throw new Error('Гипотеза должна ссылаться только на подтверждённые человеком ошибки агента из dev. Невалидные тесты и control не подходят.');
  }
  if (record.targetFingerprint && await targetFingerprint(record.target) !== record.targetFingerprint) throw new Error('Агент изменился после исходного прогона. Сначала проверьте текущую версию.');
  const sourceFile = await realpath(record.target.promptFile);
  const source = await readPrompt(sourceFile);
  if (source === input.candidate) throw new Error('Промпт не изменился.');
  const proposal = proposalSchema.parse({ format: 'agent-lab-prompt-1', runId: record.id, sourceFile, sourceHash: fingerprint(source),
    candidateHash: fingerprint(input.candidate), hypothesis: input.hypothesis, trialIds: input.trialIds, createdAt: new Date().toISOString(), draftHash: draftHash(record) });
  const folder = resolve(directory, 'prompt-proposals', randomUUID());
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(resolve(folder, 'original.md'), source, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(folder, 'candidate.md'), input.candidate, { flag: 'wx', mode: 0o600 });
  const file = resolve(folder, 'proposal.json');
  await writeFile(file, JSON.stringify(proposal, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { file, ...await inspectPrompt(file) };
}

export async function inspectPrompt(file: string) {
  const proposal = proposalSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const folder = dirname(resolve(file));
  const original = await readPrompt(resolve(folder, 'original.md'));
  const candidate = await readPrompt(resolve(folder, 'candidate.md'));
  if (fingerprint(original) !== proposal.sourceHash || fingerprint(candidate) !== proposal.candidateHash) throw new Error('Файлы предложения изменились. Создайте и просмотрите новый diff.');
  let diff: string;
  try { diff = (await promisify(execFile)('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', 'original.md', 'candidate.md'], { cwd: folder, timeout: 5000, maxBuffer: 400000 })).stdout; }
  catch (error) {
    if ((error as { code?: number }).code !== 1 || typeof (error as { stdout?: string }).stdout !== 'string') throw error;
    diff = (error as { stdout: string }).stdout;
  }
  return { proposal, reviewHash: fingerprint(proposal), diff, candidateFile: resolve(folder, 'candidate.md') };
}

/** Apply to an isolated test version, retaining every capability and regression card. */
export async function promptVersion(lab: ExperimentLab, file: string, expectedHash: string) {
  const { proposal, candidateFile, reviewHash } = await inspectPrompt(file);
  if (reviewHash !== expectedHash) throw new Error('Diff изменился после просмотра. Откройте предложение заново.');
  const original = await lab.get(proposal.runId);
  if (draftHash(original) !== proposal.draftHash || fingerprint(await readPrompt(proposal.sourceFile)) !== proposal.sourceHash) throw new Error('Исходный агент или набор изменился после предложения. Сначала подготовьте новый diff.');
  if (original.targetFingerprint && await targetFingerprint(original.target) !== original.targetFingerprint) throw new Error('Исходная версия изменилась после прогона.');
  if (original.target.kind === 'sandbox') throw new Error('Нужен внешний агент.');
  const draft = await lab.repeat(original.id);
  return lab.updateDraft(draft.id, draftHash(draft), { target: { ...original.target, promptFile: candidateFile },
    targetVersion: `prompt-${proposal.candidateHash.slice(0, 16)}` });
}
