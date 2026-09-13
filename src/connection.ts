import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { checkSchema, emptyUsage, experimentSchema, fingerprint, settingsSchema, targetSchema, worldSchema, type Experiment, type Runtime, type Scenario, type Target } from './contracts.js';
import { evaluateTrial } from './evaluation.js';
import { preflightTarget } from './targets.js';

const step = z.strictObject({ message: z.string().trim().min(1).max(3000), reply: z.string().min(1).max(8000) });
export const probeSchema = z.strictObject({
  initialState: worldSchema, write: step, read: step, reset: step,
  checks: z.array(checkSchema).max(10).default([]),
}).refine(p => p.read.reply !== p.reset.reply, 'Проверка должна различать сохранённую историю и новую сессию.');
const connectionSchema = z.strictObject({ format: z.literal('agent-lab-connection-1'), target: targetSchema,
  targetVersion: z.string().trim().min(1).max(200).optional(), probe: probeSchema.optional(), verifiedAt: z.string().optional() });
export type Connection = z.infer<typeof connectionSchema>;

/** Only paths have a base directory. Arguments and environment variable names remain literal. */
export function resolveTarget(raw: unknown, base: string): Target {
  if (!raw || typeof raw !== 'object') return targetSchema.parse(raw);
  const target = { ...raw } as Record<string, unknown>;
  if (typeof target.promptFile === 'string') target.promptFile = resolve(base, target.promptFile);
  if (target.kind === 'module' && typeof target.path === 'string') target.path = resolve(base, target.path);
  if (target.kind === 'command') {
    target.cwd = resolve(base, typeof target.cwd === 'string' ? target.cwd : '.');
    if (typeof target.command === 'string' && target.command.includes('/')) target.command = resolve(target.cwd as string, target.command);
  }
  return targetSchema.parse(target);
}

export function portableTarget(target: Target, base: string): unknown {
  const path = (file: string) => relative(base, file) || '.';
  const executable = (cwd: string, file: string) => { const value = relative(cwd, file); return value.includes('/') ? value : `./${value}`; };
  const prompt = target.kind !== 'sandbox' && target.promptFile ? { promptFile: path(target.promptFile) } : {};
  if (target.kind === 'module') return { ...target, ...prompt, path: path(target.path) };
  if (target.kind !== 'command') return { ...target, ...prompt };
  const cwd = target.cwd ?? process.cwd();
  return { ...target, ...prompt, cwd: path(cwd), command: isAbsolute(target.command) ? executable(cwd, target.command) : target.command,
    args: target.args.map(arg => isAbsolute(arg) && /\.(?:[cm]?js|ts|py|sh)$/.test(arg) ? relative(cwd, arg) : arg) };
}

export async function readConnection(file: string): Promise<Connection> {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  return connectionSchema.parse({ ...raw, target: resolveTarget(raw.target, dirname(resolve(file))) });
}
export async function rememberedConnection(directory: string): Promise<Connection | undefined> {
  try { return await readConnection(resolve(directory, 'connection.local.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
export async function rememberConnection(directory: string, connection: Connection): Promise<void> {
  if (connection.target.kind === 'sandbox') return;
  const previous = await rememberedConnection(directory);
  if (!connection.probe && previous?.probe && fingerprint(previous.target) === fingerprint(connection.target)) connection = { ...connection, probe: previous.probe };
  const path = resolve(directory, 'connection.local.json');
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(connectionSchema.parse({ ...connection, verifiedAt: new Date().toISOString() }), null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

export async function listSuites(directory: string) {
  const files = await readdir(directory);
  return Promise.all(files.filter(file => file.endsWith('.json')).sort().map(async file => {
    const path = resolve(directory, file);
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      if (raw.format !== 'agent-lab-suite-1') return { file: path, error: 'Не является набором Agent Lab.' };
      const record = experimentSchema.parse({ ...raw.definition, target: resolveTarget(raw.definition.target, dirname(path)) });
      return { file: path, task: record.task, cases: record.scenarios.map(s => ({ id: s.id, title: s.title, tier: s.tier })),
        sourceRunId: record.sourceEvidence?.runId ?? record.parentRunId, sourceTrials: record.sourceEvidence?.trials.length ?? 0 };
    } catch (error) { return { file: path, error: error instanceof Error ? error.message : String(error) }; }
  }));
}

/** An explicit three-request probe exercises history and reset, using the real adapter path. */
export async function doctor(connection: Connection, signal = new AbortController().signal) {
  const probe = probeSchema.parse(connection.probe);
  if (connection.target.kind === 'sandbox') throw new Error('Doctor проверяет внешнее подключение.');
  await preflightTarget(connection.target);
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(new Error('Connection probe exceeded 180 seconds')), 180000);
  const usage = emptyUsage();
  const unused = async (): Promise<never> => { throw new Error('Doctor never calls a model or generates a user'); };
  const runtime: Runtime = { prepare: unused, improve: unused, openTarget: unused, userTurn: unused };
  const settings = settingsSchema.parse({ repeats: 1, maxTurns: 2, maxCalls: 5, userModes: ['scripted'], maxDurationMs: 180000 });
  const spec = { name: 'Connection probe', instructions: 'Use the external connection.', tools: [] };
  const revision = { id: fingerprint(spec), spec, parentId: null, hypothesis: 'Connection probe', createdAt: new Date().toISOString() };
  const makeCard = (reset: boolean): Scenario => ({ id: reset ? 'probe-reset' : 'probe-history', familyId: 'probe', split: 'dev',
    title: reset ? 'Новая сессия и сброс состояния' : 'Два хода с сохранением истории', tier: 'smoke', provenance: 'curated', requirementIds: [],
    user: { goal: 'Проверить подключение', facts: 'Заданы владельцем адаптера', behavior: 'Следовать сценарию',
      opening: reset ? probe.reset.message : probe.write.message, script: reset ? [] : [probe.read.message], maxFollowUps: reset ? 0 : 1 },
    initialState: probe.initialState,
    checks: [{ id: 'reply', kind: 'answer_equals', description: 'Ожидаемый ответ проверки подключения', value: reset ? probe.reset.reply : probe.read.reply },
      ...(reset ? Object.entries(probe.initialState.records).flatMap(([recordId, fields]) => Object.entries(fields).map(([field, value], i) =>
        ({ id: `reset-${recordId}-${i}`, kind: 'state_equals' as const, description: 'Новая сессия восстановила исходное состояние', recordId, field, value }))) : probe.checks)],
  });
  try {
    const trials = [];
    for (const reset of [false, true]) trials.push(await evaluateTrial({ runtime, revision, scenario: makeCard(reset), sources: [], repeat: 0,
      manifestHash: fingerprint(probe), settings, userMode: 'scripted', target: connection.target,
      ctx: { signal: combined, timeoutMs: 60000, beforeCall() { combined.throwIfAborted(); if (++usage.calls > 3) throw new Error('Probe call limit exceeded'); },
        addUsage(u) { usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens; usage.costUsd = u.costUsd === null || usage.costUsd === null ? null : usage.costUsd + u.costUsd; } } }));
    const firstReply = trials[0]!.events.find(e => e.type === 'assistant')?.text;
    const passed = trials.every(t => t.outcome === 'pass') && firstReply === probe.write.reply
      && trials.every(t => t.observation?.resetConfirmed === true && t.observation.tools === 'complete' && !!t.observation.version)
      && trials[0]!.observation?.version === trials[1]!.observation?.version;
    return { format: 'agent-lab-doctor-1', passed, createdAt: new Date().toISOString(), target: connection.target, trials,
      message: passed ? 'История и сброс прошли заданную проверку; адаптер сообщил версию и полную трассу в заявленной области инструментов.'
        : 'Проверьте ответы, итоговое состояние, resetConfirmed, eventsComplete и стабильную version.',
      limitation: 'Это проверка заданного поведения. Состояние и полноту событий сообщает адаптер; его реализацию нужно сверять с тестовой системой.' };
  } finally { clearTimeout(timer); }
}

export function suiteEvidence(record: Experiment, scenarioIds: string[]) {
  const trials = scenarioIds.flatMap(id => {
    const candidates = record.trials.filter(t => t.scenarioId === id);
    const reviewed = candidates.find(t => record.humanReviews.some(r => r.trialId === t.id && r.verdict === 'fail'));
    const trial = reviewed ?? candidates.find(t => t.outcome === 'fail' || t.assessments?.some(a => a.result === 'fail')) ?? candidates[0];
    return trial ? [structuredClone(trial)] : [];
  });
  return { runId: record.id, ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}), trials, humanReviews: record.humanReviews.filter(r => trials.some(t => t.id === r.trialId)) };
}
