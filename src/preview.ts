import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { emptyUsage, fingerprint, type Experiment, type Runtime, type Trial } from './contracts.js';
import { assessTrial, previewAnswer } from './evaluation.js';
import { createPiRuntime, evaluatorVersion } from './pi.js';

export const answerExamplesSchema = z.strictObject({
  good: z.string().min(1).max(20000), bad: z.string().min(1).max(20000),
}).refine(v => v.good !== v.bad, 'Хороший и плохой ответы должны отличаться.');

/** Check the criterion, not the target: supplied answers never become measured agent trials or human verdicts. */
export async function previewCriteria(record: Experiment, scenarioId: string, raw: z.infer<typeof answerExamplesSchema>,
  options: { directory: string; signal?: AbortSignal; runtime?: Runtime; codeOnly?: boolean }) {
  const examples = answerExamplesSchema.parse(raw);
  const original = record.scenarios.find(s => s.id === scenarioId);
  if (!original) throw new Error('Неизвестная карточка.');
  const scenario = { ...original, metrics: (original.metrics ?? []).filter(m => m.subject === 'agent') };
  const usage = emptyUsage();
  const signal = AbortSignal.any([AbortSignal.timeout(record.settings.maxDurationMs), ...(options.signal ? [options.signal] : [])]);
  const ctx = { signal, timeoutMs: record.settings.timeoutMs,
    beforeCall() { signal.throwIfAborted(); if (usage.calls >= Math.min(record.settings.maxCalls, 6 * scenario.metrics.length)) throw new Error('Лимит вызовов предпросмотра.'); usage.calls++; },
    addUsage(value: Omit<typeof usage, 'calls'>) {
      usage.inputTokens += value.inputTokens; usage.outputTokens += value.outputTokens;
      usage.costUsd = value.costUsd === null || usage.costUsd === null ? null : usage.costUsd + value.costUsd;
    },
  };
  const results = [];
  let runtime = options.runtime;
  for (const label of ['good', 'bad'] as const) {
    const answer = examples[label];
    const exact = previewAnswer({ ...scenario, metrics: options.codeOnly ? scenario.metrics : [] }, answer);
    const trial: Trial = { id: label, revisionId: 'preview', scenarioId, familyId: scenario.familyId, userMode: 'static',
      repeat: 0, split: 'dev', manifestHash: 'preview', outcome: 'ungraded', reason: 'Предоставленный пример ответа; агент не запускался.',
      checks: exact.checks, events: [{ seq: 0, type: 'user', text: scenario.user.opening }, { seq: 1, type: 'assistant', text: answer }],
      initialState: scenario.initialState, finalState: scenario.initialState, observation: { state: 'missing', tools: 'partial' }, usage: emptyUsage(), elapsedMs: 0 };
    try {
      signal.throwIfAborted();
      if (scenario.metrics.length && !options.codeOnly) {
        runtime ??= await createPiRuntime(record.settings);
        trial.assessments = await assessTrial(runtime, scenario, record.sources, trial, ctx);
      }
    } catch (error) { trial.assessmentError = error instanceof Error ? error.message : 'Оценщик недоступен'; }
    const scores = [...exact.checks.map(c => c.passed ? 'pass' : 'fail'), ...(trial.assessments ?? []).map(a => a.result)];
    const result = trial.assessmentError ? 'unknown' : scores.includes('fail') ? 'fail' : exact.unmeasured.length ? 'unknown'
      : scores.length && scores.every(s => s === 'pass') ? 'pass' : 'unknown';
    results.push({ label, answer, expected: label === 'good' ? 'pass' : 'fail', result,
      matchesExpected: result === 'unknown' ? null : result === (label === 'good' ? 'pass' : 'fail'),
      checks: exact.checks, assessments: trial.assessments ?? [], error: trial.assessmentError, unmeasured: exact.unmeasured });
  }
  const preview = { format: 'agent-lab-preview-1', id: randomUUID(), createdAt: new Date().toISOString(), runId: record.id, scenarioId,
    evaluatorVersion: evaluatorVersion(record.settings), criteriaHash: fingerprint({ checks: scenario.checks, metrics: scenario.metrics }),
    scenario, sources: record.sources, models: { provider: record.settings.provider, model: record.settings.model, judge: record.settings.roles.judge },
    usage, results, limitations: ['Примеры предоставлены для проверки критериев. Это не ответы запущенного агента и не человеческая разметка его трасс.',
      'Без наблюдённой трассы состояние и действия не измерены; рубрики о них должны возвращать unknown. Поведение симулятора здесь не оценивается.'] };
  const directory = resolve(options.directory, 'previews');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, `${preview.id}.json`);
  await writeFile(file, JSON.stringify(preview, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...preview, file };
}
