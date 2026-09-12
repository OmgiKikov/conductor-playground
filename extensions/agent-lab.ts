import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { z } from 'zod';
import { ExperimentLab, draftHash, resultHash } from '../dist/experiment.js';
import { agentSchema, createInputSchema, dialogueSchema, draftPatchSchema, goldenCaseSchema, ownerProfileSchema, settingsSchema, targetSchema, type Experiment, type HumanReviewInput } from '../dist/contracts.js';
import { awaitingVerdict, evidenceSummary } from '../dist/comparison.js';
import { demoEvaluationInput, demoInput } from '../dist/demo.js';
import { evidenceBundle, exportArtifacts } from '../dist/artifacts.js';
import { editDraft, inputError } from './editor.ts';
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
      return new Text(theme.fg(data.error ? 'error' : 'text', safeText(title)) + (data.id ? '\n/agent-lab — сценарии, диалоги и обсуждение с Pi' : ''), 0, 0);
    } catch { return new Text(safeText(raw), 0, 0); }
  },
};
const returnToBoard = (ctx: ExtensionContext, id: string) => {
  if (!ctx.hasUI || ctx.mode !== 'tui') return;
  const text = ctx.ui?.getEditorText?.() ?? '';
  if (!text.trim() || /^\/agent-lab(?:\s|$)/.test(text)) ctx.ui?.setEditorText?.(`/agent-lab ${id}`);
};

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

async function humanAnnotation(ctx: ExtensionContext, record: Experiment, selected: number): Promise<HumanReviewInput | undefined> {
  const trial = reviewOrder(record)[selected];
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
    ...toolDisplay,
    name: 'agent_lab_build', label: 'Prepare agent and dialogue cards',
    description: 'Prepare an agent and a small editable set of user simulation cards from task/material contents. Uses current Pi model unless settings override. Stops before all dialogue evaluation: only a human in /agent-lab can review and approve the exact draft. Does not run, improve or approve the agent. mode=demo prepares the built-in scripted example without model calls. Native workflow is evaluation, with 5 cards and 1 repeat by default. target selects the agent under test: the trusted sandbox (default), an http endpoint, a local module adapter, or a local process (command, e.g. python3 agent.py speaking JSON lines). goldenCases become curated cards; dialogues (de-identified real conversations) ground observed user profiles, production cards that open with real users\' own messages, and simulator fidelity. settings.userModes may list static, scripted and reactive to compare what each user side finds. notes carry the owner\'s hints about users in their own words; profiles are owner-written user types. Both are legitimate inputs when no real data exists, and the verdict always states how much of the evidence is synthetic. preset=thorough widens the run without extra settings. Every result leads with a plain verdict: pass count, weak spots, confidence and next steps.',
    parameters: Type.Object({
      task: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      materials: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 180 }), content: Type.String({ minLength: 1, maxLength: 120000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 12 })),
      existingAgent: Type.Optional(Type.Unsafe(z.toJSONSchema(agentSchema))),
      settings: Type.Optional(Type.Unsafe(z.toJSONSchema(settingsSchema, { io: 'input' }))),
      scenarioCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
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
      const { preset, ...rest } = params;
      const mode = rest.mode ?? 'live';
      const supplied = (rest.settings ?? {}) as Partial<z.infer<typeof settingsSchema>>;
      const input = createInputSchema.parse({
        ...(mode === 'demo' ? demoInput() : {}), ...rest, mode, workflow: 'evaluate',
        settings: { ...(mode === 'demo' ? demoInput().settings : {}), repeats: 1,
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
    description: 'Copy a previously approved evaluation into a fresh draft without model generation. Preserves cards, materials and settings, captures current local code identity, clears results and approvals. The human reviews and launches it in /agent-lab.',
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' }) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { lab, close } = open(ctx.cwd);
      try { await lab.init(); const record = await lab.repeat(params.id); const output = summary(record, lab.store.directory);
        returnToBoard(ctx, record.id);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: output };
      } finally { await close(); }
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
        let notice: BoardOptions['notice'];
        const inform = (message: string, kind: 'info' | 'error' = 'info') => {
          notice = { message: safeText(message), kind };
        };
        while (true) {
          const record = id ? await lab.get(id) : undefined;
          const bundle = record ? await evidenceBundle(record, lab.store, beforeId) : undefined;
          const action: BoardAction = demoRequested ? { type: 'demo' } : newRequested ? { type: 'new' } : await showBoard(ctx, record
            ? { record, section, selected, query, pendingOnly, comparison: bundle?.comparison, before: bundle?.before, notice, reportPath,
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
            handoff = { request, context: { task: 'Prepare a new Agent Lab draft. Read the authorized local agent project and relevant materials; infer or prepare its adapter. Use agent_lab_build, then explain the proposed user scenarios in plain language. Do not run dialogues or claim human review. Follow the agent-builder skill.' } };
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
                task: 'This user request concerns the selected Agent Lab experiment. Inspect fresh evidence with agent_lab_inspect. For draft corrections, use agent_lab_edit with the current hash and summarize changes. For unresolved business questions or a preparation error, read the original evidence file and prepare a new draft with the supplied corrections; preserve the old one. For results, inspect actual trial traces and report the failure, cited trial/event IDs, whether a human confirmed it, and a concrete next step. Distinguish facts from suspected causes. Never overwrite measured results, invent human verdicts, approve or run a draft. Do not alter the external agent without an explicit request to fix it.' } };
              break;
            } else if (action.type === 'repeat') {
              const next = await lab.repeat(action.record.id);
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
              });
            } else if (action.type === 'run') {
              const r = action.record;
              if (r.workflow !== 'evaluate') throw new Error('Legacy comparison records cannot run from the evaluation board.');
              const hash = draftHash(r);
              const scripted = r.settings.userModes.includes('scripted') ? r.scenarios.filter(s => s.user.script?.length).length : 0;
              const planned = r.settings.userModes.reduce((sum, mode) => sum + (mode === 'scripted' ? scripted : r.scenarios.length), 0) * r.settings.repeats;
              const target = r.target.kind === 'sandbox' ? 'песочница с доверенными инструментами' : r.target.kind === 'http' ? `внешний агент по HTTP ${safeText(r.target.url)}`
                : r.target.kind === 'module' ? `внешний агент из модуля ${safeText(r.target.path)}` : `внешний агент как процесс ${safeText([r.target.command, ...r.target.args].join(' '))}`;
              const message = `Я проверил агента, материалы, цели, пользователей и метрики всех ${r.scenarios.length} карточек.\nЦель: ${target}.\nРежимы пользователя: ${r.settings.userModes.join(', ')}.\nЗапуск: ${planned} диалогов, ${r.settings.repeats} повтор(а), до ${r.settings.maxTurns} ходов, лимит ${r.settings.maxCalls} вызовов.\n${r.mode === 'demo' ? 'Сценарный демо: без модели.' : `Модель: ${safeText(r.settings.provider)}/${safeText(r.settings.model)}. Стоимость заранее неизвестна.`}\nВерсия: ${hash}\nПодтвердить эту версию и запустить?`;
              if (await ctx.ui.confirm('Проверка карточек человеком', message)) {
                await lab.start(r.id, { approved: true, reviewer: 'human', expectedHash: hash }); section = 'results'; selected = 0;
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
                note: 'Быстрый вердикт с доски, без пояснения. Нажмите v, чтобы записать основание.',
              });
              reportPath = undefined;
            } else if (action.type === 'annotate') {
              const index = action.trialId ? reviewOrder(action.record).findIndex(t => t.id === action.trialId) : action.selected;
              const review = await humanAnnotation(ctx, action.record, index);
              if (review) { await lab.addHumanReview(action.record.id, review); reportPath = undefined; }
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
