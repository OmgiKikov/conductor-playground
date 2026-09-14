import { mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyUsage, metricApplies, type JudgeAudit, type Runtime, type Settings } from './contracts.js';
import { createPiRuntime } from './pi.js';

type Input = Parameters<NonNullable<Runtime['assess']>>[0];
export function repeatability(audits: JudgeAudit[]) {
  const groups = new Map<string, { inputHash: string; metricId: string; verdicts: string[] }>();
  let errors = 0, pending = 0;
  for (const audit of audits) for (const attempt of audit.attempts) {
    if (attempt.error) errors++;
    else if (!attempt.assessments) pending++;
    for (const a of attempt.assessments ?? []) {
      const key = `${audit.protocolHash}/${audit.provider}/${audit.model}/${audit.inputHash}/${a.metricId}`;
      const group = groups.get(key) ?? { inputHash: audit.inputHash, metricId: a.metricId, verdicts: [] };
      group.verdicts.push(a.result); groups.set(key, group);
    }
  }
  return { errors, pending, groups: [...groups.values()].map(({ verdicts, ...group }) => {
    const counts = { pass: 0, fail: 0, unknown: 0 };
    for (const v of verdicts) counts[v as keyof typeof counts]++;
    const n = verdicts.length, pairs = n * (n - 1) / 2;
    const disagreed = pairs - Object.values(counts).reduce((sum, k) => sum + k * (k - 1) / 2, 0);
    const disjointPairs = Math.floor(n / 2);
    let disjointFlips = 0;
    for (let i = 1; i < n; i += 2) if (verdicts[i] !== verdicts[i - 1]) disjointFlips++;
    return { ...group, n, counts, pairs, disagreed, disagreement: pairs ? disagreed / pairs : null, disjointPairs, disjointFlips,
      zeroFlipUpper95: disjointPairs && !disjointFlips ? 1 - Math.pow(0.05, 1 / disjointPairs) : null };
  }) };
}

/** Reassess frozen dialogues; never run the target, change rubrics, or overwrite the source experiment. */
export async function auditJudge(inputs: Input[], settings: Settings, directory: string, repeats: number, runtime?: Runtime) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 1500) throw new Error('Judge repeats must be between 1 and 1500');
  if (!inputs.length) throw new Error('No saved dialogues to assess');
  await mkdir(directory, { recursive: false, mode: 0o700 }); // Existing artifacts are never overwritten.
  const usage = emptyUsage(), audits: JudgeAudit[] = [];
  const manifest = { startedAt: new Date().toISOString(), settings, repeats, inputs, humanLabelsUsed: false,
    repetitionsAreConsensusBatches: true, requestsPerMetric: 2,
    requestsPerBatch: inputs.map(i => ({ trialId: i.trial.id, requests: 2 * (i.scenario.metrics ?? []).filter(m => metricApplies(m, i.trial)).length })),
    sampling: `temperature=0 for non-reasoning models, provider default otherwise; thinking=medium when supported, off otherwise; seed unset; upstream=${!settings.roles?.judge && settings.judge?.upstream || 'provider default'}` };
  await writeFile(join(directory, 'inputs.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const actor = runtime ?? await createPiRuntime(settings.judge ? { ...settings, provider: settings.judge.provider, model: settings.judge.model } : settings);
  const signal = AbortSignal.timeout(settings.maxDurationMs);
  const failures: { trialId: string; repeat: number; error: string }[] = [];
  let completedBatches = 0;
  let consecutiveFailures = 0;
  let stoppedBecause: string | undefined;
  try {
    for (const input of inputs) for (let repeat = 0; repeat < repeats; repeat++) {
      signal.throwIfAborted();
      let latest: JudgeAudit | undefined;
      let persistenceError: unknown;
      try {
        await actor.assess!(structuredClone(input), {
          signal, timeoutMs: settings.timeoutMs,
          beforeCall() { signal.throwIfAborted(); if (usage.calls >= settings.maxCalls) throw new Error('Judge audit call budget exhausted'); usage.calls++; },
          addUsage(u) { usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens; usage.costUsd = usage.costUsd === null || u.costUsd === null ? null : usage.costUsd + u.costUsd; },
          onJudgment(trialId, audit) {
            latest = audit;
            try { appendFileSync(join(directory, 'responses.jsonl'), JSON.stringify({ trialId, repeat, audit }) + '\n', { mode: 0o600, flush: true }); }
            catch (error) { persistenceError = error; throw error; }
          },
        });
        consecutiveFailures = 0;
      } catch (error) {
        if (persistenceError) throw persistenceError;
        failures.push({ trialId: input.trial.id, repeat, error: error instanceof Error ? error.message : 'Judge failed' });
        consecutiveFailures++;
      } finally { if (latest) audits.push(latest); }
      completedBatches++;
      // A failed request consumes its planned slot. No success-only retry selection.
      if (consecutiveFailures >= 3) { stoppedBecause = 'Three consecutive assessment batches failed'; return; }
      if (usage.calls >= settings.maxCalls && completedBatches < inputs.length * repeats) { stoppedBecause = 'Call budget reached'; return; }
    }
  } finally {
    const statistics = repeatability(audits);
    const contrasts = new Set(inputs.flatMap(i => (i.scenario.metrics ?? []).filter(m => metricApplies(m, i.trial)).map(m => `${i.scenario.id}/${m.id}`))).size;
    const noiseCeiling = contrasts ? 0.05 / contrasts : null;
    const complete = completedBatches === inputs.length * repeats && failures.length === 0;
    const rubricDecisions = statistics.groups.map(g => {
      // ponytail: exact zero-flip bound only; nonzero flips need a binomial interval before certification.
      const simultaneousUpper95 = g.disjointPairs && !g.disjointFlips ? 1 - Math.pow(0.05 / statistics.groups.length, 1 / g.disjointPairs) : null;
      return { inputHash: g.inputHash, metricId: g.metricId, simultaneousUpper95,
      status: g.counts.unknown ? 'resolve_criteria' : g.disagreement !== null && noiseCeiling !== null && g.disagreement > noiseCeiling ? 'unstable'
        : simultaneousUpper95 !== null && noiseCeiling !== null && simultaneousUpper95 <= noiseCeiling ? 'below_chosen_noise_ceiling' : 'insufficient_repeats' };
    });
    const result = { finishedAt: new Date().toISOString(), usage, failures, statistics, noiseCeiling,
      plannedBatches: inputs.length * repeats, completedBatches, complete, stoppedBecause,
      rubricDecisions, ready: complete && rubricDecisions.length > 0 && rubricDecisions.every(r => r.status === 'below_chosen_noise_ceiling'),
      noisePolicy: 'Chosen maximum 5% chance of any spurious rubric flip across the declared card/metric contrasts, by union bound. Not a universal effect-size or power threshold.',
      conclusion: 'Descriptive repeatability only. Agreement of two votes is not evidence of correctness. Zero observed flips is not zero noise; confidence bounds assume independent requests for each fixed input. Provider routing can violate that assumption.' };
    await writeFile(join(directory, 'statistics.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    await writeFile(join(directory, 'report.md'), [
      '# Воспроизводимость судьи', '', `Вызовов: ${usage.calls}. Ошибок оценивания: ${failures.length}; незавершённых ответов: ${statistics.pending}. Разметка человека не использовалась.`, '',
      ...(stoppedBecause ? [`Остановка: ${stoppedBecause}. Невыполненные оценки не заменяются успешными и не входят в измеренный шум.`, ''] : []),
      '| Вход | Рубрика | pass/fail/unknown | Различающиеся пары | Шум | Непересекающиеся пары без совпадения |',
      '|---|---|---|---|---|---|',
      ...statistics.groups.map(g => `| ${g.inputHash.slice(0, 12)} | ${g.metricId} | ${g.counts.pass}/${g.counts.fail}/${g.counts.unknown} | ${g.disagreed}/${g.pairs} | ${g.disagreement === null ? 'нет данных' : (g.disagreement * 100).toFixed(2) + '%'} | ${g.disjointFlips}/${g.disjointPairs} |`), '',
      `Выбранный потолок шума для ${contrasts} сравнений карточка × применимая рубрика: ${noiseCeiling === null ? 'не определён' : (noiseCeiling * 100).toFixed(2) + '%'}. Это ограничение риска хотя бы одного ложного изменения в 5%, а не универсальный порог мощности эксперимента.`, '',
      `Полнота: ${completedBatches}/${inputs.length * repeats} запланированных оценок; ${complete ? 'без ошибок' : 'есть ошибки или пропуски'}. Готовность по выбранному порогу: ${result.ready ? 'достаточно повторов при принятых допущениях' : 'не подтверждена'}.`, '',
      ...rubricDecisions.map(r => `- ${r.inputHash.slice(0, 12)} / ${r.metricId}: ${r.status === 'resolve_criteria' ? 'есть unknown — требуется разбор условий и достаточности данных' : r.status === 'unstable' ? 'наблюдаемый шум выше выбранного потолка — разбор рубрики до эксперимента' : r.status === 'insufficient_repeats' ? 'повторов недостаточно для выбранного потолка' : 'ниже выбранного потолка при допущении независимости запросов'}.`), '',
      'Все пары перекрываются; они не являются независимыми наблюдениями. В statistics.json отдельно посчитаны непересекающиеся пары и точная односторонняя верхняя граница 95% при отсутствии расхождений. Для ready используется дополнительная поправка Бонферрони на все измеренные сочетания вход × рубрика (simultaneousUpper95). Это предполагает независимые запросы на каждом фиксированном входе. Стабильный unknown означает отсутствие решения, а не готовность рубрики к эксперименту.', '',
      'Исходные входы и настройки: inputs.json. Неизменённые ответы, ошибки и промежуточные записи: responses.jsonl. Повтор с ошибкой не заменяется удачным. При обрыве процесса журнал содержит незавершённый запрос. Совпадение повторов не доказывает правильность; сравнение с человеком не проводилось.', '',
    ].join('\n'), { mode: 0o600 });
  }
}
