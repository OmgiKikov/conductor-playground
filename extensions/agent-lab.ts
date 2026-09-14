import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { z } from 'zod';
import { ExperimentLab, draftHash, resultHash } from '../dist/experiment.js';
import { agentSchema, createInputSchema, DEFAULT_JUDGE, describeCheck, dialogueSchema, draftPatchSchema, fingerprint, goldenCaseSchema, clarificationSchema, reassessmentSchema, ownerProfileSchema, settingsSchema, targetSchema, type Experiment, type HumanReviewInput, type Trial } from '../dist/contracts.js';
import { awaitingVerdict, evidenceSummary, plannedTrials } from '../dist/comparison.js';
import { demoEvaluationInput, demoInput } from '../dist/demo.js';
import { evidenceBundle, exportArtifacts } from '../dist/artifacts.js';
import { doctor, listSuites, readConnection, rememberedConnection, rememberConnection } from '../dist/connection.js';
import { inspectPrompt, promptVersion, proposePrompt } from '../dist/prompt-edit.js';
import { readData } from '../dist/imports.js';
import { editDraft, inputError } from './editor.ts';
import { previewCriteria } from '../dist/preview.js';
import { activePhases, reviewOrder, safeText, showBoard, verdicts, type BoardAction, type BoardOptions, type Section } from './cards.ts';

const toolDisplay: Pick<ToolDefinition, 'renderCall' | 'renderResult'> = {
  renderCall: (_args, theme) => new Text(theme.fg('accent', 'Проверка агента'), 0, 0),
  renderResult: (result, options, theme) => {
    const raw = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (options.expanded) return new Text(safeText(raw), 0, 0);
    try {
      const data = JSON.parse(raw);
      const title = data.error ?? (data.phase === 'review' ? data.message ?? `Готово ${data.scenarioCount} сценариев. Посмотрите их перед запуском.`
        : data.evidence?.verdict?.headline ?? data.message ?? 'Доказательства прочитаны.');
      return new Text(theme.fg(data.error ? 'error' : 'text', safeText(title)), 0, 0);
    } catch { return new Text(safeText(raw), 0, 0); }
  },
};
const returnToBoard = (ctx: ExtensionContext, id: string) => {
  if (!ctx.hasUI || ctx.mode !== 'tui') return;
  ctx.ui?.setStatus?.('agent-lab', `Agent Lab · ${id.slice(0, 8)} · /agent-lab ${id} — детали`);
};

function runPlan(record: Experiment): string {
  const target = record.target.kind === 'sandbox' ? 'Учебная песочница' : record.target.kind === 'http' ? record.target.url
    : record.target.kind === 'module' ? record.target.path : `${[record.target.command, ...record.target.args].join(' ')}${record.target.cwd ? ` · ${record.target.cwd}` : ''}`;
  return [
    ...record.scenarios.map(s => [safeText(s.title), `  Запрос: ${safeText(s.user.opening)}`,
      ...(record.settings.userModes.includes('scripted') ? (s.user.script ?? []).map((message, i) => `  Продолжение ${i + 1}: ${safeText(message)}`) : []),
      `  Ожидается: ${safeText(s.successCriteria)}`, ...s.checks.map(c => `  Проверка: ${safeText(describeCheck(c))}`)].join('\n')),
    '', `Диалогов: ${plannedTrials(record)}. Режимы: ${record.settings.userModes.join(', ')}.`,
    `До ${record.settings.maxCalls} вызовов, ${Math.round(record.settings.maxDurationMs / 1000)} секунд, ${record.settings.maxTurns} ходов.`,
    record.mode === 'demo' ? 'Учебный пример: без модели и оплаты.' : `Модель: ${safeText(record.settings.provider)}/${safeText(record.settings.model)}. Стоимость зависит от фактических вызовов.`,
    ...(record.mode === 'live' ? [`Судья: ${safeText(record.settings.judge?.provider ?? record.settings.provider)}/${safeText(record.settings.judge?.model ?? record.settings.model)}; по 2 вызова в свежих сессиях на каждую применимую рубрику.`] : []),
    `Агент: ${safeText(target)}`, `Версия тестов: ${draftHash(record).slice(0, 12)}`,
    'Запуск не означает, что вы вручную проверили все ожидания или оценки.',
  ].join('\n');
}

function summary(record: Experiment, directory: string) {
  const comparison = record.comparisons.findLast(c => c.split === 'control');
  const evidence = evidenceSummary(record);
  return {
    id: record.id, phase: record.phase, mode: record.mode, workflow: record.workflow,
    reviewMode: record.reviewMode, resultsReviewedAt: record.resultsReviewedAt,
    draftHash: draftHash(record), resultHash: record.trials.length ? resultHash(record) : undefined,
    message: record.message, error: record.error, questions: record.questions,
    scenarioCount: record.scenarios.length, revisionCount: record.revisions.length,
    target: record.target, profileCount: record.profiles.length, evidence,
    targetVersion: record.targetVersion, targetFingerprint: record.targetFingerprint, parentRunId: record.parentRunId,
    trialCount: record.trials.length, humanReviews: record.humanReviews ?? [], usage: record.usage, failureModes: record.failureModes ?? [],
    comparison: comparison && {
      baselineId: comparison.baselineId, candidateId: comparison.candidateId,
      baselinePasses: comparison.baselinePasses, candidatePasses: comparison.candidatePasses,
      verdict: comparison.verdict, fixed: comparison.fixed, regressed: comparison.regressed,
      validPairs: comparison.validPairs, plannedPairs: comparison.plannedPairs,
      scenarioFamilies: comparison.families, delta: comparison.delta, interval: comparison.interval, reasons: comparison.reasons,
    },
    limitations: record.limitations,
    nextStep: evidence.verdict.nextSteps[0] ? `Человеку: ${evidence.verdict.nextSteps[0].text}` : undefined,
    artifacts: { evidence: resolve(directory, `${record.id}.json`),
      ...(record.trials.length ? { traceJournal: resolve(directory, `${record.id}.trace.jsonl`) } : {}) },
  };
}

async function humanAnnotation(ctx: ExtensionContext, record: Experiment, selected: number, readingMs = 0, reviewTimes?: Map<string, number>): Promise<HumanReviewInput[] | undefined> {
  const started = performance.now();
  const trial = reviewOrder(record)[selected];
  if (!trial) return;
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  const failedCriteria = (t: Trial) => [
    ...t.checks.filter(c => !c.passed).map(c => `check:${c.id}`),
    ...(record.scenarios.find(s => s.id === t.scenarioId)?.metrics ?? []).filter(m => m.subject === 'agent'
      && t.assessments?.some(a => a.metricId === m.id && a.result === 'fail')).map(m => `metric:${m.id}`),
  ].sort();
  const similar = failedCriteria(trial).length ? record.trials.filter(t => fingerprint(failedCriteria(t)) === fingerprint(failedCriteria(trial))) : [];
  const targets: { label: string; ids: { metricId?: string; checkId?: string }; trialIds: string[] }[] = [
    { label: 'Весь диалог', ids: {}, trialIds: [trial.id] },
    ...(similar.length > 1 ? [{ label: `Такие же сработавшие проверки · ${similar.length} диалогов`, ids: {}, trialIds: similar.map(t => t.id) }] : []),
    ...(scenario?.metrics ?? []).map(m => ({ label: `Метрика · ${safeText(m.name)} [${m.id}]`, ids: { metricId: m.id }, trialIds: [trial.id] })),
    ...trial.checks.map(c => ({ label: `Проверка · ${safeText(c.description)} [${c.id}]`, ids: { checkId: c.id }, trialIds: [trial.id] })),
  ];
  const choice = await ctx.ui.select('Область вашей оценки', targets.map(t => t.label));
  const target = targets.find(t => t.label === choice);
  if (!target) return;
  const choices = [{ value: 'fail', label: 'Ошибся агент' }, { value: 'invalid', label: 'Ошибся тест' }, { value: 'unknown', label: 'Данных недостаточно' }, { value: 'pass', label: 'Агент выполнил задачу' }] as const;
  const answer = await ctx.ui.select(`Диалог ${trial.id} · исходная оценка сохранится`, choices.map(v => v.label));
  const verdict = choices.find(v => v.label === answer)?.value;
  if (!verdict) return;
  const note = await ctx.ui.editor('Пояснение · укажите реплики # и причину согласия или ошибки', '');
  if (note === undefined) return;
  if (target.trialIds.length > 1 && !await ctx.ui.confirm(`Применить вердикт к ${target.trialIds.length} диалогам?`,
    similar.map(t => `${safeText(record.scenarios.find(s => s.id === t.scenarioId)?.title)}\n${t.checks.filter(c => !c.passed).map(c => safeText(c.evidence)).join('\n')}`).join('\n\n')
    + `\n\nВаш вердикт: ${verdicts[verdict]}\nОснование: ${safeText(note)}\nКаждый диалог сохранит отдельную заметку.`)) return;
  return target.trialIds.map(trialId => ({ trialId, ...target.ids, verdict, note,
    durationMs: Math.min(3600000, Math.round((performance.now() - started) / target.trialIds.length + (reviewTimes?.get(`${record.id}|${trialId}`) ?? (trialId === trial.id ? readingMs : 0)))) }));
}

/** Conversational execution asks the human to authorize a concrete plan; it never invents human reviews. */
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
  pi.on('session_start', async (_event, ctx) => {
    if (process.env.AGENT_LAB_SESSION !== '1' || !ctx.hasUI || ctx.mode !== 'tui') return;
    ctx.ui.setTitle(`Agent Lab · ${ctx.cwd.split('/').at(-1)}`);
    ctx.ui.setHeader((_tui, theme) => new Text(theme.bold('Agent Lab') + '\nПроверьте, что сломала правка вашего агента.\n' + safeText(ctx.cwd), 1, 1));
    ctx.ui.setWidget('agent-lab-start', ['Напишите: «Проверь агента в этой папке» или «Воспроизведи эту ошибку: …»',
      'Один тест → доказательство → проверка исправления. /agent-lab demo — учебный пример.']);
  });
  pi.on('before_agent_start', async (event, ctx) => {
    if (process.env.AGENT_LAB_SESSION !== '1') return;
    ctx.ui?.setWidget?.('agent-lab-start', undefined);
    return { systemPrompt: event.systemPrompt + `\nYou are Agent Lab, a conversational tool for checking changes to the user's real agent. Work in their project. Follow the agent-builder skill. Start with ONE useful test and a concrete expected outcome; inspect the local entry point and requirements yourself. Use the user's language. Keep normal work in this conversation: build, inspect, edit, agent_lab_run, inspect the actual evidence, explain one finding and the next action. agent_lab_run asks the human to authorize the exact plan; execution consent is not a human review of expectations. Never bypass its confirmation through shell or internal APIs. Do not send users to a board just to proceed; /agent-lab is an optional evidence view. Preserve budgets and model. Save useful cases with agent_lab_suite; repeat existing cases after a change instead of regenerating them. Separate a broken test from an agent failure. Do not modify an external agent unless the user asked to fix it. Avoid lectures about personas, rubrics, calibration or tiers unless they explain a finding. Read traces and cite actual event IDs; never invent human verdicts or claim improved quality after changing the tests.` };
  });
  pi.registerTool({
    ...toolDisplay,
    name: 'agent_lab_build', label: 'Prepare agent and dialogue cards',
    description: 'Prepare an agent and a small editable set of user simulation cards from task/material contents. Uses current Pi model unless settings override. Stops before all dialogue evaluation: use agent_lab_run to show the exact plan and obtain native execution confirmation. Does not run, improve or approve the agent. mode=demo prepares the built-in scripted example without model calls. Native workflow is evaluation, with 1 test, 1 repeat, at most 20 calls and 180 seconds by default. target selects the agent under test: the trusted sandbox (default), an http endpoint, a local module adapter, or a local process (command, e.g. python3 agent.py speaking JSON lines). goldenCases become curated cards; dialogues (de-identified real conversations) ground observed user profiles, production cards that open with real users\' own messages, and simulator fidelity. settings.userModes may list static, scripted and reactive to compare what each user side finds. notes carry the owner\'s hints about users in their own words; profiles are owner-written user types. Both are legitimate inputs when no real data exists, and the verdict always states how much of the evidence is synthetic. preset=thorough widens the run without extra settings. Every result leads with a plain verdict: pass count, weak spots, confidence and next steps.',
    parameters: Type.Object({
      task: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      materials: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 180 }), content: Type.String({ minLength: 1, maxLength: 120000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 12 })),
      existingAgent: Type.Optional(Type.Unsafe(z.toJSONSchema(agentSchema))),
      settings: Type.Optional(Type.Unsafe(z.toJSONSchema(settingsSchema, { io: 'input' }))),
      scenarioCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
      connectionFile: Type.Optional(Type.String()), goldenFile: Type.Optional(Type.String()), dialoguesFile: Type.Optional(Type.String()),
      target: Type.Optional(Type.Unsafe(z.toJSONSchema(targetSchema, { io: 'input' }))),
      targetVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Agent release, commit or remote deployment version.' })),
      goldenCases: Type.Optional(Type.Unsafe(z.toJSONSchema(z.array(goldenCaseSchema).max(40), { io: 'input' }))),
      dialogues: Type.Optional(Type.Unsafe(z.toJSONSchema(z.array(dialogueSchema).max(200), { io: 'input' }))),
      notes: Type.Optional(Type.String({ maxLength: 8000, description: "The owner's own hints about users, goals and situations, in their words. First-class input for synthetic cards; never treated as a business rule." })),
      profiles: Type.Optional(Type.Unsafe(z.toJSONSchema(z.array(ownerProfileSchema).max(6), { io: 'input' }))),
      preset: Type.Optional(Type.Union([Type.Literal('quick'), Type.Literal('thorough')], { description: 'quick (default): reactive simulator, one repeat. thorough: static, scripted and reactive user modes with two repeats.' })),
      mode: Type.Optional(Type.Union([Type.Literal('live'), Type.Literal('demo')])),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, toolSignal, onUpdate, ctx) {
      const { preset, goldenFile, dialoguesFile, connectionFile, ...rest } = params;
      const mode = rest.mode ?? 'live';
      const supplied = (rest.settings ?? {}) as Partial<z.infer<typeof settingsSchema>>;
      const connection = mode === 'demo' ? undefined : connectionFile ? await readConnection(resolve(ctx.cwd, connectionFile)) : !rest.target ? await rememberedConnection(resolve(ctx.cwd, '.agent-lab')) : undefined;
      const input = createInputSchema.parse({
        ...(mode === 'demo' ? demoEvaluationInput() : {}), scenarioCount: mode === 'demo' ? 3 : 1, ...rest, mode, workflow: 'evaluate',
        ...(connection ? { target: connection.target, targetVersion: connection.targetVersion } : {}),
        ...(goldenFile ? { goldenCases: await readData(resolve(ctx.cwd, goldenFile), 'golden') } : {}),
        ...(dialoguesFile ? { dialogues: await readData(resolve(ctx.cwd, dialoguesFile), 'dialogues') } : {}),
        settings: { ...(mode === 'demo' ? demoInput().settings : {}), repeats: 1, maxCalls: 20, maxDurationMs: 180000,
          ...(mode === 'live' ? { judge: DEFAULT_JUDGE } : {}),
          ...(preset === 'thorough' ? { userModes: ['static', 'scripted', 'reactive'], repeats: 2 } : {}), ...supplied,
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
        const text = safeText(`${record.phase === 'preparing' ? 'Готовлю требования и тест' : 'Тест готов'}: ${record.message} · вызовов ${record.usage.calls}`);
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
        const output = { ...summary(record, lab.store.directory), artifacts: await exportArtifacts(await evidenceBundle(record, lab.store), lab.store.directory), ...(signal.aborted ? { cancelled: true } : {}) };
        returnToBoard(ctx, id);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
      } finally { clearInterval(timer); signal.removeEventListener('abort', cancel); await polling; await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay,
    name: 'agent_lab_inspect', label: 'Inspect agent cards and evidence',
    description: 'Read a saved draft and its hash, or a full trial transcript/state using trialId. export=true creates local HTML and Markdown reports and an AgentSpec snapshot. This tool never approves a draft or result. Legacy comparison control traces remain hidden until the control phase stops.',
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), trialId: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' })), export: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      try {
        const record = await lab.get(params.id);
        const bundle = await evidenceBundle(record, lab.store);
        const controlVisible = record.workflow === 'evaluate' || !!record.controlConsumedAt && !activePhases.has(record.phase);
        const trial = params.trialId ? record.trials.find(t => t.id === params.trialId) : undefined;
        if (params.trialId && !trial) throw new Error('Trial not found in this experiment.');
        if (trial?.split === 'control' && !controlVisible) throw new Error('Control evidence stays hidden until the final control phase stops.');
        const output = trial ?? {
          ...summary(record, lab.store.directory), agent: record.revisions.find(r => r.id === record.selectedRevisionId)?.spec,
          settings: record.settings, requirements: record.requirements, profiles: record.profiles,
          scenarios: record.scenarios.filter(s => s.split === 'dev' || controlVisible), revisions: record.revisions, iterations: record.iterations,
          trials: record.trials.filter(t => t.split === 'dev' || controlVisible).map(t => ({ id: t.id, revisionId: t.revisionId, scenarioId: t.scenarioId, split: t.split, outcome: t.outcome, reason: t.reason })),
          ...(bundle.comparison ? { comparison: bundle.comparison, comparisonSource: bundle.comparisonSource } : {}),
          warnings: bundle.warnings,
          ...(params.export ? { artifacts: await exportArtifacts(bundle, lab.store.directory) } : {}),
        };
        returnToBoard(ctx, record.id);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: { id: record.id } };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay,
    name: 'agent_lab_edit', label: 'Edit an unapproved agent draft',
    description: 'Edit a draft after inspecting its current draftHash. scenarios upserts full cards by id and preserves omitted cards. Delete only explicitly with removeScenarioIds. AgentSpec, settings, target and targetVersion may also change. Human approval stays pending. Cannot change started experiments, run dialogues, record human verdicts, or approve results.',
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), expectedHash: Type.String({ pattern: '^[a-f0-9]{64}$' }), patch: Type.Unsafe({ ...z.toJSONSchema(draftPatchSchema, { io: 'input' }), description: 'profileEdits replaces draft overrides on existing profiles and updates all linked cards. Original profiles and evidence stay intact. override:null restores original; persona:null clears persona; characteristics:[] clears traits. Omitted override fields use the original. Use scenarios to link/unlink profileId.' }) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      try {
        await lab.init();
        const record = await lab.updateDraft(params.id, params.expectedHash, draftPatchSchema.parse(params.patch));
        const output = summary(record, lab.store.directory);
        returnToBoard(ctx, record.id);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay,
    name: 'agent_lab_repeat', label: 'Prepare another run of the same cards',
    description: 'Copy a previously approved evaluation into a fresh draft without model generation. Preserves cards, materials and settings, captures current local code identity, clears results and approvals. Inspect it and use agent_lab_run; /agent-lab is an optional detailed view.',
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }), scenarioIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 40, description: 'Repeat only these existing tests; omit for the whole regression set.' })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      try { await lab.init(); const record = await lab.repeat(params.id, params.scenarioIds); const output = summary(record, lab.store.directory);
        returnToBoard(ctx, record.id);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay, name: 'agent_lab_run', label: 'Run the proposed tests',
    description: 'Run the exact inspected evaluation draft, with native confirmation of its target, tests and budget. Does not record human review of expectations or results. Stay in the conversation and inspect the evidence after running. Cannot run headlessly or without the human confirmation. Never bypass this tool through shell or internal APIs.',
    parameters: Type.Object({ id: Type.String(), expectedHash: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, toolSignal, onUpdate, ctx) {
      if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Для нового запуска нужен интерактивный терминал. В CI используйте evaluate --input suite.json --yes с явно заданным бюджетом.');
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
      signal.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      let timer: ReturnType<typeof setInterval> | undefined;
      let polling: Promise<void> = Promise.resolve();
      const cancel = () => { void lab.cancel(params.id).catch(() => {}); };
      try {
        await lab.init();
        const draft = await lab.get(params.id);
        if (draft.workflow !== 'evaluate' || draftHash(draft) !== params.expectedHash) throw new Error('План изменился. Прочитайте актуальный черновик через agent_lab_inspect.');
        if (!await ctx.ui.confirm('Запустить проверку?', runPlan(draft))) {
          return { content: [{ type: 'text', text: JSON.stringify({ id: draft.id, cancelled: true, message: 'Запуск отменён. Тесты сохранены; не повторяйте запрос запуска без новой просьбы пользователя.' }) }], details: { cancelled: true } };
        }
        signal.throwIfAborted();
        await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: params.expectedHash });
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        const progress = async () => {
          const r = await lab.get(draft.id);
          onUpdate?.({ content: [{ type: 'text', text: safeText(`Проверено ${r.trials.length} из ${plannedTrials(r)} · ${r.message}`) }], details: { id: r.id, phase: r.phase } });
        };
        await progress();
        timer = setInterval(() => { polling = polling.then(progress).catch(() => {}); }, 750);
        await lab.waitForIdle(); await progress();
        const record = await lab.get(draft.id);
        const bundle = await evidenceBundle(record, lab.store);
        const output = { ...summary(record, lab.store.directory), comparison: bundle.comparison, artifacts: await exportArtifacts(bundle, lab.store.directory) };
        returnToBoard(ctx, record.id);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
      } finally { clearInterval(timer); signal.removeEventListener('abort', cancel); await polling; await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay, name: 'agent_lab_suite', label: 'Save or load reusable tests',
    description: 'Save selected tests as a versionable .evals/*.json file, or load that file into a fresh draft without model generation. Preserves original provenance and criteria. Clears results and approvals. Saving never overwrites an existing file. Use after a useful finding or when the user wants a regression test. Loading does not run it; inspect then use agent_lab_run.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('save'), Type.Literal('load'), Type.Literal('list')]), connectionFile: Type.Optional(Type.String()), file: Type.String({ minLength: 1 }),
      id: Type.Optional(Type.String()), scenarioIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 40 })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      try {
        await lab.init();
        let output: unknown;
        if (params.action === 'list') output = await listSuites(resolve(ctx.cwd, params.file));
        else if (params.action === 'save') {
          if (!params.id) throw new Error('Укажите прогон, из которого сохранить тесты.');
          const file = await lab.saveSuite(params.id, resolve(ctx.cwd, params.file), params.scenarioIds);
          output = { file, message: 'Тесты сохранены. Их можно добавить в Git и запускать после каждой правки.', nextStep: `agent-lab evaluate --input ${JSON.stringify(file)} --yes` };
        } else output = summary(await lab.loadSuite(resolve(ctx.cwd, params.file), params.scenarioIds, params.connectionFile ? await readConnection(resolve(ctx.cwd, params.connectionFile)) : undefined), lab.store.directory);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: {} };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay, name: 'agent_lab_connection', label: 'Check agent connection',
    description: 'Inspect a saved connection or run its explicit three-request history/reset probe. Use file for portable JSON config; omit to use the remembered successful connection. check asks the human to approve the concrete requests. Reports actual evidence; never claims trusted state merely from adapter assertions.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('inspect'), Type.Literal('check')]), file: Type.Optional(Type.String()) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      const directory = resolve(ctx.cwd, '.agent-lab');
      const connection = params.file ? await readConnection(resolve(ctx.cwd, params.file)) : await rememberedConnection(directory);
      if (!connection) throw new Error('Сохранённого подключения нет. Укажите файл подключения.');
      let output: unknown = connection;
      if (params.action === 'check') {
        if (!connection.probe) throw new Error('Добавьте probe.write/read/reset и initialState в файл подключения.');
        if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Проверка подключения требует native Pi confirmation.');
        if (!await ctx.ui.confirm('Проверить историю и сброс · 3 запроса?', safeText(JSON.stringify({ target: connection.target, probe: connection.probe }, null, 2)))) return { content: [{ type: 'text', text: 'Проверка отменена.' }], details: {} };
        const result = await doctor(connection, AbortSignal.any([signal, ctx.signal].filter((s): s is AbortSignal => !!s)));
        if (result.passed) await rememberConnection(directory, connection);
        output = result;
      }
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: {} };
    },
  });
  pi.registerTool({
    ...toolDisplay, name: 'agent_lab_preview', label: 'Check criteria on good and bad answers',
    description: 'Check supplied good/bad answer examples against the current literal checks and semantic agent rubrics, without calling the target. Saves examples, criteria, judge version, evidence and cost separately. Examples are not measured target trials or human annotations. State/tool checks require recorded traces via reassess.',
    parameters: Type.Object({ id: Type.String(), scenarioId: Type.String(), good: Type.String({ minLength: 1, maxLength: 20000 }),
      bad: Type.String({ minLength: 1, maxLength: 20000 }), codeOnly: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      const { lab, close } = open(ctx.cwd);
      try {
        await lab.init(); const record = await lab.get(params.id);
        if (!params.codeOnly && record.scenarios.find(s => s.id === params.scenarioId)?.metrics?.some(m => m.subject === 'agent')) {
          if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Предпросмотр моделью требует интерактивного терминала. CLI: preview --yes.');
          if (!await ctx.ui.confirm('Проверить два примера по рубрикам?', safeText(`${params.good}\n\n${params.bad}\n\nДо 6 вызовов судьи. Агент не запускается.`))) return { content: [{ type: 'text', text: 'Предпросмотр отменён.' }], details: {} };
        }
        const output = await previewCriteria(record, params.scenarioId, { good: params.good, bad: params.bad }, { directory: lab.store.directory,
          codeOnly: params.codeOnly, signal: AbortSignal.any([signal, ctx.signal].filter((s): s is AbortSignal => !!s)) });
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay, name: 'agent_lab_reassess', label: 'Reassess recorded evidence',
    description: 'Evaluate new checks/rubrics on existing trial traces without calling the target or simulator. Creates a separate immutable result retaining the original run. codeOnly uses no model; judge overrides are optional. This cannot demonstrate an agent improvement. Ask native confirmation before model spending.',
    parameters: Type.Object({ id: Type.String(), input: Type.Optional(Type.Unsafe(z.toJSONSchema(reassessmentSchema, { io: 'input' }))) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      const input = reassessmentSchema.parse(params.input ?? {});
      const { lab, close } = open(ctx.cwd);
      const cancel = () => { void close(); };
      try {
        await lab.init();
        const original = await lab.get(params.id);
        if (!input.codeOnly) {
          if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Переоценка моделью требует native Pi confirmation.');
          if (!await ctx.ui.confirm('Переоценить сохранённые ответы?', safeText(`Агент не запускается. Диалогов: ${input.trialIds?.length ?? original.trials.length}. До ${original.settings.maxCalls} вызовов, ${original.settings.maxDurationMs / 1000} секунд.\n${JSON.stringify(input, null, 2)}`))) return { content: [{ type: 'text', text: 'Переоценка отменена.' }], details: {} };
        }
        signal?.throwIfAborted(); signal?.addEventListener('abort', cancel, { once: true });
        const draft = await lab.reassess(params.id, input);
        await lab.waitForIdle();
        const record = await lab.get(draft.id);
        const output = { ...summary(record, lab.store.directory), assessmentOf: record.assessmentOf,
          artifacts: await exportArtifacts(await evidenceBundle(record, lab.store), lab.store.directory) };
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: {} };
      } finally { signal?.removeEventListener('abort', cancel); await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay, name: 'agent_lab_prompt', label: 'Review one prompt change',
    description: 'propose saves an isolated candidate prompt and diff, citing human-confirmed dev failures. Never use control feedback. apply requires native diff review and creates a draft with the EXACT same capability/regression cards and a candidate promptFile; then use agent_lab_run. Adapter must attest promptHash. Original prompt file is preserved.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('propose'), Type.Literal('inspect'), Type.Literal('apply')]),
      id: Type.Optional(Type.String()), file: Type.Optional(Type.String()), candidate: Type.Optional(Type.String({ maxLength: 96000 })),
      hypothesis: Type.Optional(Type.String({ maxLength: 3000 })), trialIds: Type.Optional(Type.Array(Type.String(), { maxItems: 40 })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      try {
        await lab.init();
        let output: unknown;
        if (params.action === 'propose') {
          if (!params.id || !params.candidate || !params.hypothesis || !params.trialIds) throw new Error('Нужны id, candidate, hypothesis и trialIds подтверждённых ошибок.');
          output = await proposePrompt(lab.store.directory, await lab.get(params.id), { candidate: params.candidate, hypothesis: params.hypothesis, trialIds: params.trialIds });
        } else {
          if (!params.file) throw new Error('Укажите file предложения.');
          const file = resolve(ctx.cwd, params.file);
          const inspected = await inspectPrompt(file);
          if (params.action === 'inspect') output = inspected;
          else {
            if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Выбор версии промпта требует native Pi review.');
            if (!await ctx.ui.confirm('Проверить эту версию промпта?', safeText(inspected.proposal.hypothesis + '\n' + inspected.diff))) return { content: [{ type: 'text', text: 'Изменение отменено.' }], details: {} };
            output = summary(await promptVersion(lab, file, inspected.reviewHash), lab.store.directory);
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: {} };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay, name: 'agent_lab_clarify', label: 'Record owner clarification',
    description: 'Regenerate a blocked draft from the owner’s actual answers. Preserve the original questions/run and append verbatim answers as a cited material in the new draft. Never invent business decisions or infer a human review.',
    parameters: Type.Object({ id: Type.String(), answers: Type.Unsafe(z.toJSONSchema(z.array(clarificationSchema).min(1).max(50))) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      const { lab, close } = open(ctx.cwd);
      const cancel = () => { void close(); };
      try {
        await lab.init(); signal?.throwIfAborted(); signal?.addEventListener('abort', cancel, { once: true });
        const record = await lab.clarify(params.id, z.array(clarificationSchema).parse(params.answers));
        const output = summary(record, lab.store.directory);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: {} };
      } finally { signal?.removeEventListener('abort', cancel); await close(); }
    },
  });
  pi.registerCommand('agent-lab', {
    description: 'Проверить агента: /agent-lab, /agent-lab demo или /agent-lab /путь/к/проекту',
    async handler(args, ctx) {
      if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Human review requires the native Pi terminal. Start interactive Pi and open /agent-lab. Headless tools only prepare and edit drafts.');
      const startRequest = args.trim() === 'new' || args.trim().startsWith('/') || args.trim().startsWith('~');
      let handoff: { request: string; context: unknown } | undefined;
      const { lab, close } = open(ctx.cwd);
      try {
        await lab.init();
        let id = startRequest || args.trim() === 'demo' ? undefined : args.trim() || undefined;
        let section: Section | undefined;
        let selected = 0;
        let query = '';
        let pendingOnly = false;
        let beforeId: string | undefined;
        let newRequested = startRequest;
        let demoRequested = args.trim() === 'demo';
        let reportPath: string | undefined;
        // Elapsed time with the dialogue visible plus its verdict form, including time spent idle.
        const reviewTimes = new Map<string, number>();
        let notice: BoardOptions['notice'];
        const inform = (message: string, kind: 'info' | 'error' = 'info') => {
          notice = { message: safeText(message), kind };
        };
        while (true) {
          const record = id ? await lab.get(id) : undefined;
          const bundle = record ? await evidenceBundle(record, lab.store, beforeId) : undefined;
          const action: BoardAction = demoRequested ? { type: 'demo' } : newRequested ? { type: 'new' } : await showBoard(ctx, record
            ? { record, section, selected, query, pendingOnly, comparison: bundle?.comparison, before: bundle?.before, notice, reportPath, reviewTimes,
                warnings: bundle?.warnings, load: async () => evidenceBundle(await lab.get(record.id), lab.store, beforeId) }
            : { records: await lab.list(), notice, warnings: lab.store.diagnostics.map(d => `${d.id}: ${d.message}`) });
          notice = undefined;
          if ('record' in action && (action.record.updatedAt !== record?.updatedAt || action.record.phase !== record?.phase)) reportPath = undefined;
          if (action.type === 'demo') {
            demoRequested = false;
            try {
              const draft = await lab.create(demoEvaluationInput());
              await lab.waitForIdle();
              id = draft.id; section = 'cards'; selected = 0; query = ''; pendingOnly = false; beforeId = undefined; reportPath = undefined;
              inform('Учебный пример: агенту не хватает инструмента изменения записи. r — найти провал. Модель и провайдер не нужны.');
            } catch (error) { inform(inputError(error), 'error'); }
            continue;
          }
          if (action.type === 'new') {
            const request = newRequested && args.trim() !== 'new' ? `Проверь агента в ${args.trim()}`
              : await ctx.ui.editor('Папка агента и что проверить · своими словами', '');
            newRequested = false;
            if (!request?.trim()) continue;
            handoff = { request, context: { task: 'Prepare a new Agent Lab draft. Read the authorized local agent project and relevant materials; infer or prepare its adapter. Use agent_lab_build, then explain the proposed user scenarios in plain language. Explain the first test and use agent_lab_run when the user asked to check the agent. Do not claim human review. Follow the agent-builder skill.' } };
            break;
          }
          if (action.type === 'open') { id = action.id; section = undefined; selected = 0; query = ''; pendingOnly = false; beforeId = undefined; reportPath = undefined; continue; }
          if (action.type === 'close' || action.type === 'back') {
            const latest = id ? await lab.get(id) : undefined;
            if (latest && activePhases.has(latest.phase)) {
              if (!await ctx.ui.confirm('Остановить диалоги и выйти?', 'Текущий запуск будет остановлен. Уже записанные доказательства сохранятся.')) continue;
              await lab.cancel(latest.id); await lab.waitForIdle();
            }
            if (action.type === 'close') break;
            id = undefined; section = undefined; selected = 0; query = ''; pendingOnly = false; beforeId = undefined; reportPath = undefined; continue;
          }
          section = action.section; selected = action.selected;
          query = action.query ?? ''; pendingOnly = action.pendingOnly ?? false;
          try {
            if (action.type === 'discuss') {
              const r = action.record;
              const request = await ctx.ui.editor(r.phase === 'review' ? 'Что изменить или уточнить? · обычными словами' : 'Что разобрать вместе с Pi?',
                r.phase === 'review' ? '' : 'Объясни, что сломалось, на каких репликах это видно и что делать дальше.');
              if (!request?.trim()) continue;
              const current = action.section === 'comparison' ? await evidenceBundle(r, lab.store, beforeId) : undefined;
              handoff = { request, context: { experimentId: r.id, phase: r.phase,
                scenarioId: action.section === 'cards' ? r.scenarios[action.selected]?.id : undefined, trialId: action.trialId,
                ...(action.section === 'comparison' ? { comparisonSource: current?.comparisonSource,
                  comparedPair: current?.comparison?.pairs.find(pair => pair.afterTrialId === action.trialId) } : {}),
                task: 'This user request concerns the selected Agent Lab experiment. Inspect fresh evidence with agent_lab_inspect. For draft corrections, use agent_lab_edit with the current hash and summarize changes. For unresolved business questions or a preparation error, read the original evidence file and prepare a new draft with the supplied corrections; preserve the old one. For results, inspect actual trial traces and report the failure, cited trial/event IDs, whether a human confirmed it, and a concrete next step. Distinguish facts from suspected causes. Never overwrite measured results or invent human verdicts. Use agent_lab_run for requested execution with native plan confirmation. Do not alter the external agent without an explicit request to fix it.' } };
              break;
            } else if (action.type === 'repeat') {
              const scenarioId = action.section === 'results' ? action.record.trials.find(t => t.id === action.trialId)?.scenarioId : undefined;
              const next = await lab.repeat(action.record.id, scenarioId ? [scenarioId] : undefined);
              beforeId = action.record.id; id = next.id; section = 'agent'; selected = 0; query = ''; pendingOnly = false; reportPath = undefined;
            } else if (action.type === 'compare') {
              if (action.record.parentRunId) beforeId = action.record.parentRunId;
              else {
                const others = (await lab.list()).filter(r => r.id !== action.record.id && r.workflow === 'evaluate' && r.trials.length);
                if (!others.length) { inform('Для сравнения нужен ещё один прогон. Нажмите r, чтобы повторить этот набор.'); continue; }
                const labels = others.map(r => `${r.createdAt.slice(0, 16).replace('T', ' ')} · ${safeText(r.targetVersion ?? r.id.slice(0, 8))} · ${safeText(r.task)}`);
                const chosen = await ctx.ui.select('С чем сравнить текущий прогон?', labels);
                if (chosen === undefined) continue;
                beforeId = others[labels.indexOf(chosen)]?.id;
              }
              section = 'comparison'; query = ''; selected = 0;
              reportPath = undefined;
            } else if (action.type === 'edit' || action.type === 'settings') {
              if (action.record.workflow !== 'evaluate') throw new Error('Legacy comparison records are read-only in this board.');
              await editDraft(ctx, action, async patch => {
                const updated = await lab.updateDraft(action.record.id, draftHash(action.record), patch);
                reportPath = undefined;
                inform(updated.message);
              }, (scenarioId, examples) => previewCriteria(action.record, scenarioId, examples, { directory: lab.store.directory, signal: ctx.signal }));
            } else if (action.type === 'run') {
              const r = action.record;
              if (r.workflow !== 'evaluate') throw new Error('Legacy comparison records cannot run from the evaluation board.');
              const hash = draftHash(r);
              if (await ctx.ui.confirm('Запустить проверку?', runPlan(r))) {
                await lab.start(r.id, { approved: true, reviewer: 'automated', expectedHash: hash }); section = 'results'; selected = 0;
                reportPath = undefined;
              }
            } else if (action.type === 'cancel') {
              await lab.cancel(action.record.id); await lab.waitForIdle();
              reportPath = undefined;
            } else if (action.type === 'verdict') {
              const trial = action.trialId ? action.record.trials.find(t => t.id === action.trialId) : reviewOrder(action.record)[action.selected];
              if (!trial) throw new Error('Диалог не выбран.');
              await lab.addHumanReview(action.record.id, {
                trialId: trial.id, verdict: action.verdict,
                note: 'Быстрый вердикт из терминала, без записанного основания.',
                durationMs: action.reviewMs,
              });
              reviewTimes.delete(`${action.record.id}|${trial.id}`);
              reportPath = undefined;
            } else if (action.type === 'annotate') {
              const index = action.trialId ? reviewOrder(action.record).findIndex(t => t.id === action.trialId) : action.selected;
              const reviews = await humanAnnotation(ctx, action.record, index, action.reviewMs, reviewTimes);
              if (reviews) { for (const review of reviews) { await lab.addHumanReview(action.record.id, review); reviewTimes.delete(`${action.record.id}|${review.trialId}`); } reportPath = undefined; }
            } else if (action.type === 'finalize') {
              const r = action.record;
              const pending = awaitingVerdict(r).size;
              if (pending) {
                section = 'results'; pendingOnly = true; selected = 0; query = '';
                inform(`Осталось разобрать ${pending} провал(ов). p / n — вердикт; v — пояснение или оценка критерия.`, 'error');
                continue;
              }
              const hash = resultHash(r);
              const invalid = r.trials.filter(t => t.outcome === 'invalid' || t.outcome === 'cancelled').length;
              const ungraded = r.trials.filter(t => t.outcome === 'ungraded').length;
              if (await ctx.ui.confirm('Завершить человеческий аудит?', `Я проверил диалоги, основания оценок и поведение симуляторов.\nДиалогов: ${r.trials.length}; невалидных/остановленных: ${invalid}; без объективной оценки: ${ungraded}.\nОтдельных заметок человека: ${r.humanReviews?.length ?? 0}. ${r.mode === 'demo' ? 'Сценарные оценки демо останутся отдельными от моих.' : 'Оценки модели останутся отдельными от моих.'}\nВерсия результатов: ${hash}\nПодтвердить проверку всего набора?`)) {
                const reviewed = await lab.reviewResults(r.id, hash);
                section = 'agent'; selected = 0; query = ''; pendingOnly = false;
                const artifacts = await exportArtifacts(await evidenceBundle(reviewed, lab.store, beforeId), lab.store.directory);
                reportPath = artifacts.htmlReport;
                inform('Разбор завершён. HTML-отчёт сохранён. o — открыть отчёт.');
              }
            } else if (action.type === 'export') {
              const artifacts = await exportArtifacts(await evidenceBundle(action.record, lab.store, beforeId), lab.store.directory);
              reportPath = artifacts.htmlReport;
              inform('HTML, Markdown и снимок доказательств сохранены. o — открыть отчёт.');
              ctx.ui.notify(safeText(`Отчёт: ${artifacts.htmlReport}\nMarkdown: ${artifacts.report}\nДоказательства: ${artifacts.evidence}`), 'info');
            } else if (action.type === 'openReport' && reportPath) {
              const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
              const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', reportPath] : [reportPath];
              await promisify(execFile)(command, args, { timeout: 10000 });
              inform('Отчёт открыт в браузере.');
            }
          } catch (error) { inform(inputError(error), 'error'); }
        }
      } finally { await close(); }
      if (handoff) {
        pi.sendMessage({ customType: 'agent-lab-context', content: JSON.stringify(handoff.context), display: false }, { deliverAs: 'followUp' });
        pi.sendUserMessage(handoff.request, { deliverAs: 'followUp', expandPromptTemplates: false });
      }
    },
  });
  pi.on('session_shutdown', async () => { await activeClose?.(); });
}
