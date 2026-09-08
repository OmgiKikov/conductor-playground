import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { z } from 'zod';
import { ExperimentLab, draftHash, resultHash } from '../dist/experiment.js';
import { agentSchema, createInputSchema, draftPatchSchema, settingsSchema, type DraftPatch, type Experiment, type HumanReviewInput } from '../dist/contracts.js';
import { demoInput } from '../dist/demo.js';
import { activePhases, safeText, showBoard, verdicts, type BoardAction } from './cards.ts';

function summary(record: Experiment, directory: string) {
  const comparison = record.comparisons.findLast(c => c.split === 'control');
  return {
    id: record.id, phase: record.phase, mode: record.mode, workflow: record.workflow,
    reviewMode: record.reviewMode, resultsReviewedAt: record.resultsReviewedAt,
    draftHash: draftHash(record), resultHash: record.trials.length ? resultHash(record) : undefined,
    message: record.message, error: record.error, questions: record.questions,
    scenarioCount: record.scenarios.length, revisionCount: record.revisions.length,
    trialCount: record.trials.length, humanReviews: record.humanReviews ?? [], usage: record.usage,
    comparison: comparison && {
      baselineId: comparison.baselineId, candidateId: comparison.candidateId,
      baselinePasses: comparison.baselinePasses, candidatePasses: comparison.candidatePasses,
      verdict: comparison.verdict, fixed: comparison.fixed, regressed: comparison.regressed,
      validPairs: comparison.validPairs, plannedPairs: comparison.plannedPairs,
      scenarioFamilies: comparison.families, delta: comparison.delta, interval: comparison.interval, reasons: comparison.reasons,
    },
    limitations: record.limitations,
    nextStep: record.phase === 'review' ? 'Human: open /agent-lab to review cards, edit the draft and approve its exact version.'
      : record.phase === 'results_review' ? 'Human: open /agent-lab to inspect dialogues and audit model assessments.' : undefined,
    artifacts: { evidence: resolve(directory, `${record.id}.json`),
      ...(record.trials.length ? { traceJournal: resolve(directory, `${record.id}.trace.jsonl`) } : {}) },
  };
}

async function exportArtifacts(record: Experiment, directory: string) {
  const exportDir = resolve(directory, 'exports');
  await mkdir(exportDir, { recursive: true, mode: 0o700 });
  const stem = `${record.id}.${randomUUID().slice(0, 8)}`;
  const report = resolve(exportDir, `${stem}.report.md`);
  const selected = record.revisions.find(r => r.id === record.selectedRevisionId)?.spec;
  const agent = selected ? resolve(exportDir, `${stem}.agent.json`) : undefined;
  const text = [
    `# Agent Lab: ${record.id}`, '', safeText(record.task), '',
    `Phase: ${record.phase}. Mode: ${record.mode}. Workflow: ${record.workflow ?? 'compare'}.`,
    `Draft review: ${record.reviewMode ?? 'pending'}. Result review: ${record.resultsReviewedAt ?? 'pending'}.`, '',
    safeText(record.message), '',
    `Scenarios: ${record.scenarios.length}. Trials: ${record.trials.length}. Human annotations: ${record.humanReviews?.length ?? 0}.`,
    `${record.mode === 'demo' ? 'Scripted role calls' : 'Model calls'}: ${record.usage.calls}. Observed cost: ${record.usage.costUsd === null ? 'unknown' : `$${record.usage.costUsd.toFixed(4)}`}.`, '',
    ...record.trials.flatMap(t => [
      `## ${t.id} · ${safeText(record.scenarios.find(s => s.id === t.scenarioId)?.title ?? t.scenarioId)}`, '',
      `Objective outcome: ${t.outcome}. ${safeText(t.reason)}`,
      ...t.checks.map(c => `- ${c.passed ? 'PASS' : 'FAIL'} ${safeText(c.description)}: ${safeText(c.evidence)}`),
      ...(t.assessments ?? []).map(a => `- ${record.mode === 'demo' ? 'Scripted demo assessment' : 'Model estimate'} [${a.metricId}]: ${a.result}. ${safeText(a.rationale)}. Evidence: ${a.evidence.map(n => `#${n}`).join(', ') || 'none'}`),
      ...(t.assessmentError ? [`- Assessment error: ${safeText(t.assessmentError)}`] : []),
      ...(record.humanReviews ?? []).filter(r => r.trialId === t.id).map(r => `- Human [${r.metricId ?? r.checkId ?? 'dialogue'}]: ${r.verdict}. ${safeText(r.note)}`), '',
    ]),
    ...record.limitations.map(v => `- ${safeText(v)}`), '',
    'Full transcripts, states and original assessments are in the evidence JSON and trace journal.',
    'The exported AgentSpec is a configuration for this trusted record sandbox; it is not a separately installed production agent.', '',
  ].join('\n');
  await writeFile(report, text, { mode: 0o600, flag: 'wx' });
  if (agent && selected) await writeFile(agent, JSON.stringify(selected, null, 2), { mode: 0o600, flag: 'wx' });
  return { ...summary(record, directory).artifacts, report, ...(agent ? { agent } : {}) };
}

async function editDraft(ctx: ExtensionContext, action: Extract<BoardAction, { record: Experiment }>): Promise<DraftPatch | undefined> {
  const { record } = action;
  const editJSON = async (title: string, value: unknown) => {
    const text = await ctx.ui.editor(title, safeText(JSON.stringify(value, null, 2)));
    return text === undefined ? undefined : JSON.parse(text);
  };
  if (action.type === 'settings') {
    const settings = await editJSON('Лимиты · JSON (repeats, maxTurns, maxCalls, timeoutMs)', record.settings);
    return settings === undefined ? undefined : { settings };
  }
  if (action.section === 'cards' && record.scenarios[action.selected]) {
    const scenarios = structuredClone(record.scenarios);
    const scenario = scenarios[action.selected]!;
    const fields = [
      ['title', 'Название'], ['persona', 'Персона'], ['characteristics', 'Характеристики · по одной в строке'],
      ['goal', 'Цель пользователя'], ['behavior', 'Поведение'], ['facts', 'Факты, известные пользователю'],
      ['opening', 'Первая реплика'], ['maxFollowUps', 'Максимум ответов после первой реплики'],
      ['successCriteria', 'Критерий успеха'], ['assumptions', 'Допущения · по одному в строке'],
      ['metrics', 'Метрики · JSON'], ['checks', 'Точные проверки · JSON'], ['initialState', 'Начальное состояние · JSON'],
      ['all', 'Все карточки · JSON'],
    ] as const;
    const choice = await ctx.ui.select('Что изменить в карточке?', fields.map(([, label]) => label));
    const entry = fields.find(([, label]) => label === choice);
    if (!entry) return;
    const [field, title] = entry;
    if (field === 'all') {
      const changed = await editJSON(title, scenarios);
      return changed === undefined ? undefined : { scenarios: changed };
    }
    const userFields = new Set(['persona', 'characteristics', 'goal', 'behavior', 'facts', 'opening', 'maxFollowUps']);
    const object = (userFields.has(field) ? scenario.user : scenario) as unknown as Record<string, unknown>;
    if (['metrics', 'checks', 'initialState'].includes(field)) {
      const changed = await editJSON(title, object[field] ?? []);
      if (changed === undefined) return;
      object[field] = changed;
    } else {
      const array = field === 'characteristics' || field === 'assumptions';
      const before = object[field];
      const changed = await ctx.ui.editor(title, safeText(array ? (before as string[] | undefined)?.join('\n') ?? '' : before ?? ''));
      if (changed === undefined) return;
      object[field] = array ? changed.split('\n').map(v => v.trim()).filter(Boolean) : field === 'maxFollowUps' ? Number(changed) : changed;
    }
    return { scenarios };
  }
  const agent = record.revisions.find(r => r.id === record.selectedRevisionId)?.spec;
  if (!agent) throw new Error('Агент ещё не подготовлен.');
  const choice = await ctx.ui.select('Что изменить?', ['Инструкции агента', 'Агент целиком · JSON', 'Все карточки · JSON']);
  if (choice === 'Инструкции агента') {
    const instructions = await ctx.ui.editor('Инструкции агента', safeText(agent.instructions));
    return instructions === undefined ? undefined : { agent: { ...agent, instructions } };
  }
  if (choice === 'Агент целиком · JSON') {
    const changed = await editJSON(choice, agent);
    return changed === undefined ? undefined : { agent: changed };
  }
  if (choice === 'Все карточки · JSON') {
    const changed = await editJSON(choice, record.scenarios);
    return changed === undefined ? undefined : { scenarios: changed };
  }
}

async function humanAnnotation(ctx: ExtensionContext, record: Experiment, selected: number): Promise<HumanReviewInput | undefined> {
  const trial = record.trials[selected];
  if (!trial) return;
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  const targets = [
    { label: 'Весь диалог', ids: {} },
    ...(scenario?.metrics ?? []).map(m => ({ label: `Метрика · ${safeText(m.name)} [${m.id}]`, ids: { metricId: m.id } })),
    ...trial.checks.map(c => ({ label: `Проверка · ${safeText(c.description)} [${c.id}]`, ids: { checkId: c.id } })),
  ];
  const choice = await ctx.ui.select('Область вашей оценки', targets.map(t => t.label));
  const target = targets.find(t => t.label === choice);
  if (!target) return;
  const choices = ['pass', 'fail', 'unknown', 'invalid'] as const;
  const answer = await ctx.ui.select('Ваш вердикт · исходная оценка сохранится', choices.map(v => verdicts[v]!));
  const verdict = choices.find(v => verdicts[v] === answer);
  if (!verdict) return;
  const note = await ctx.ui.editor('Пояснение · укажите реплики # и причину согласия или ошибки', '');
  if (note === undefined) return;
  return { trialId: trial.id, ...target.ids, verdict, note };
}

/** Model tools only prepare/read/edit. Consent exists exclusively in the native command handler. */
export default function agentLab(pi: ExtensionAPI) {
  let activeClose: (() => Promise<void>) | undefined;
  const open = (cwd: string) => {
    if (activeClose) throw new Error('Another Agent Lab operation is active. Finish it or cancel it first.');
    const lab = new ExperimentLab(resolve(cwd, '.agent-lab'));
    let closing: Promise<void> | undefined;
    const close = () => closing ??= lab.close().finally(() => { activeClose = undefined; });
    activeClose = close;
    return { lab, close };
  };
  pi.registerTool({
    name: 'agent_lab_build', label: 'Prepare agent and dialogue cards',
    description: 'Prepare an agent and a small editable set of user simulation cards from task/material contents. Uses current Pi model unless settings override. Stops before all dialogue evaluation: only a human in /agent-lab can review and approve the exact draft. Does not run, improve or approve the agent. mode=demo prepares the built-in scripted example without model calls. Native workflow is evaluation, with 5 cards and 1 repeat by default.',
    parameters: Type.Object({
      task: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      materials: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 180 }), content: Type.String({ minLength: 1, maxLength: 120000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 12 })),
      existingAgent: Type.Optional(Type.Unsafe(z.toJSONSchema(agentSchema))),
      settings: Type.Optional(Type.Unsafe(z.toJSONSchema(settingsSchema, { io: 'input' }))),
      scenarioCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      mode: Type.Optional(Type.Union([Type.Literal('live'), Type.Literal('demo')])),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, toolSignal, onUpdate, ctx) {
      const mode = params.mode ?? 'live';
      const supplied = (params.settings ?? {}) as Partial<z.infer<typeof settingsSchema>>;
      const input = createInputSchema.parse({
        ...(mode === 'demo' ? demoInput() : {}), ...params, mode, workflow: 'evaluate',
        settings: { ...(mode === 'demo' ? demoInput().settings : {}), repeats: 1, ...supplied,
          provider: supplied.provider || ctx.model?.provider || '', model: supplied.model || ctx.model?.id || '' },
      });
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
      signal.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      let id: string | undefined;
      let polling: Promise<void> = Promise.resolve();
      let timer: ReturnType<typeof setInterval> | undefined;
      let lastProgress = '';
      const progress = async () => {
        if (!id || !onUpdate) return;
        const record = await lab.get(id);
        const text = safeText(`${record.phase}: ${record.message} (${record.scenarios.length} cards; ${record.usage.calls} ${record.mode === 'demo' ? 'scripted role' : 'model'} calls)`);
        if (text !== lastProgress) { lastProgress = text; onUpdate({ content: [{ type: 'text', text }], details: { id, phase: record.phase } }); }
      };
      const cancel = () => { void (id ? lab.cancel(id) : close()).catch(() => {}); };
      try {
        await lab.init(); signal.addEventListener('abort', cancel, { once: true }); signal.throwIfAborted();
        id = (await lab.create(input)).id;
        if (signal.aborted) cancel();
        await progress();
        timer = setInterval(() => { polling = polling.then(progress).catch(() => {}); }, 750);
        await lab.waitForIdle(); await progress();
        const record = await lab.get(id);
        const output = { ...summary(record, lab.store.directory), artifacts: await exportArtifacts(record, lab.store.directory), ...(signal.aborted ? { cancelled: true } : {}) };
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
      } finally { clearInterval(timer); signal.removeEventListener('abort', cancel); await polling; await close(); }
    },
  });
  pi.registerTool({
    name: 'agent_lab_inspect', label: 'Inspect agent cards and evidence',
    description: 'Read a saved draft and its hash, or a full trial transcript/state using trialId. export=true creates a local Markdown report and AgentSpec snapshot. This tool never approves a draft or result. Legacy comparison control traces remain hidden until the control phase stops.',
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), trialId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' })), export: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      try {
        await lab.init();
        const record = await lab.get(params.id);
        const controlVisible = record.workflow === 'evaluate' || !!record.controlConsumedAt && !activePhases.has(record.phase);
        const trial = params.trialId ? record.trials.find(t => t.id === params.trialId) : undefined;
        if (params.trialId && !trial) throw new Error('Trial not found in this experiment.');
        if (trial?.split === 'control' && !controlVisible) throw new Error('Control evidence stays hidden until the final control phase stops.');
        const output = trial ?? {
          ...summary(record, lab.store.directory), agent: record.revisions.find(r => r.id === record.selectedRevisionId)?.spec,
          settings: record.settings, requirements: record.requirements,
          scenarios: record.scenarios.filter(s => s.split === 'dev' || controlVisible), revisions: record.revisions, iterations: record.iterations,
          trials: record.trials.filter(t => t.split === 'dev' || controlVisible).map(t => ({ id: t.id, revisionId: t.revisionId, scenarioId: t.scenarioId, split: t.split, outcome: t.outcome, reason: t.reason })),
          ...(params.export ? { artifacts: await exportArtifacts(record, lab.store.directory) } : {}),
        };
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: { id: record.id } };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    name: 'agent_lab_edit', label: 'Edit an unapproved agent draft',
    description: 'Edit draft scenarios, AgentSpec or settings after inspecting the current draftHash. Preserves human approval as pending. Cannot change started experiments, run dialogues, record human verdicts, or approve results.',
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), expectedHash: Type.String({ pattern: '^[a-f0-9]{64}$' }), patch: Type.Unsafe(z.toJSONSchema(draftPatchSchema, { io: 'input' })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      try {
        await lab.init();
        const record = await lab.updateDraft(params.id, params.expectedHash, draftPatchSchema.parse(params.patch));
        const output = summary(record, lab.store.directory);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
      } finally { await close(); }
    },
  });
  pi.registerCommand('agent-lab', {
    description: 'Карточки → проверка человеком → диалоги → аудит результатов',
    async handler(args, ctx) {
      if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Human review requires the native Pi terminal. Start interactive Pi and open /agent-lab. Headless tools only prepare and edit drafts.');
      const { lab, close } = open(ctx.cwd);
      try {
        await lab.init();
        let id = args.trim() || undefined;
        let section: 'agent' | 'cards' | 'results' | undefined;
        let selected = 0;
        while (true) {
          const record = id ? await lab.get(id) : undefined;
          const action = await showBoard(ctx, record ? { record, section, selected, load: () => lab.get(record.id) } : { records: await lab.list() });
          if (action.type === 'open') { id = action.id; section = undefined; selected = 0; continue; }
          if (action.type === 'close' || action.type === 'back') {
            const latest = id ? await lab.get(id) : undefined;
            if (latest && activePhases.has(latest.phase)) {
              if (!await ctx.ui.confirm('Остановить диалоги и выйти?', 'Текущий запуск будет остановлен. Уже записанные доказательства сохранятся.')) continue;
              await lab.cancel(latest.id); await lab.waitForIdle();
            }
            if (action.type === 'close') break;
            id = undefined; section = undefined; selected = 0; continue;
          }
          section = action.section; selected = action.selected;
          try {
            if (action.type === 'edit' || action.type === 'settings') {
              if (action.record.workflow !== 'evaluate') throw new Error('Legacy comparison records are read-only in this board.');
              const patch = await editDraft(ctx, action);
              if (patch) await lab.updateDraft(action.record.id, draftHash(action.record), draftPatchSchema.parse(patch));
            } else if (action.type === 'run') {
              const r = action.record;
              if (r.workflow !== 'evaluate') throw new Error('Legacy comparison records cannot run from the evaluation board.');
              const hash = draftHash(r);
              const message = `Я проверил агента, материалы, цели, пользователей и метрики всех ${r.scenarios.length} карточек.\nЗапуск: ${r.scenarios.length * r.settings.repeats} диалогов, ${r.settings.repeats} повтор(а), до ${r.settings.maxTurns} ходов, лимит ${r.settings.maxCalls} вызовов.\n${r.mode === 'demo' ? 'Сценарный демо: без модели.' : `Модель: ${safeText(r.settings.provider)}/${safeText(r.settings.model)}. Стоимость заранее неизвестна.`}\nВерсия: ${hash}\nПодтвердить эту версию и запустить?`;
              if (await ctx.ui.confirm('Проверка карточек человеком', message)) {
                await lab.start(r.id, { approved: true, reviewer: 'human', expectedHash: hash }); section = 'results'; selected = 0;
              }
            } else if (action.type === 'cancel') {
              await lab.cancel(action.record.id); await lab.waitForIdle();
            } else if (action.type === 'annotate') {
              const review = await humanAnnotation(ctx, action.record, action.selected);
              if (review) await lab.addHumanReview(action.record.id, review);
            } else if (action.type === 'finalize') {
              const r = action.record;
              const hash = resultHash(r);
              const invalid = r.trials.filter(t => t.outcome === 'invalid' || t.outcome === 'cancelled').length;
              const ungraded = r.trials.filter(t => t.outcome === 'ungraded').length;
              if (await ctx.ui.confirm('Завершить человеческий аудит?', `Я проверил диалоги, основания оценок и поведение симуляторов.\nДиалогов: ${r.trials.length}; невалидных/остановленных: ${invalid}; без объективной оценки: ${ungraded}.\nОтдельных заметок человека: ${r.humanReviews?.length ?? 0}. ${r.mode === 'demo' ? 'Сценарные оценки демо останутся отдельными от моих.' : 'Оценки модели останутся отдельными от моих.'}\nВерсия результатов: ${hash}\nПодтвердить проверку всего набора?`)) {
                const reviewed = await lab.reviewResults(r.id, hash);
                const artifacts = await exportArtifacts(reviewed, lab.store.directory);
                ctx.ui.notify(`Аудит сохранён. Отчёт: ${safeText(artifacts.report)}`, 'info');
              }
            } else if (action.type === 'export') {
              const artifacts = await exportArtifacts(action.record, lab.store.directory);
              ctx.ui.notify(safeText(`Отчёт: ${artifacts.report}\nДоказательства: ${artifacts.evidence}${artifacts.agent ? `\nАгент: ${artifacts.agent}` : ''}`), 'info');
            }
          } catch (error) { ctx.ui.notify(safeText(error instanceof Error ? error.message : error), 'error'); }
        }
      } finally { await close(); }
    },
  });
  pi.on('session_shutdown', async () => { await activeClose?.(); });
}
