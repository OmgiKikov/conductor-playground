import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { z } from 'zod';
import { ExperimentLab, draftHash, resultHash } from '../dist/experiment.js';
import { agentSchema, createInputSchema, dialogueSchema, draftPatchSchema, goldenCaseSchema, ownerProfileSchema, settingsSchema, targetSchema, type DraftPatch, type Experiment, type HumanReviewInput } from '../dist/contracts.js';
import { evidenceSummary } from '../dist/comparison.js';
import { demoInput } from '../dist/demo.js';
import { activePhases, reviewOrder, safeText, showBoard, verdicts, type BoardAction } from './cards.ts';

const confidenceWord: Record<string, string> = { low: 'низкое', medium: 'среднее', high: 'высокое' };
const outcomeWord: Record<string, string> = {
  pass: 'пройден', fail: 'не пройден', ungraded: 'без объективной оценки', invalid: 'невалиден', cancelled: 'остановлен',
};
const verdictWord: Record<string, string> = { pass: 'пройдено', fail: 'не пройдено', unknown: 'неясно', invalid: 'невалидно' };
const fidelityNames: Record<string, string> = {
  userTurns: 'реплик пользователя на диалог', userMessageLength: 'длина реплики, символов',
  questionRate: 'доля реплик с вопросом', disengagementRate: 'доля ушедших пользователей',
};

function summary(record: Experiment, directory: string) {
  const comparison = record.comparisons.findLast(c => c.split === 'control');
  return {
    id: record.id, phase: record.phase, mode: record.mode, workflow: record.workflow,
    reviewMode: record.reviewMode, resultsReviewedAt: record.resultsReviewedAt,
    draftHash: draftHash(record), resultHash: record.trials.length ? resultHash(record) : undefined,
    message: record.message, error: record.error, questions: record.questions,
    scenarioCount: record.scenarios.length, revisionCount: record.revisions.length,
    target: record.target, profileCount: record.profiles.length, evidence: evidenceSummary(record),
    trialCount: record.trials.length, humanReviews: record.humanReviews ?? [], usage: record.usage,
    comparison: comparison && {
      baselineId: comparison.baselineId, candidateId: comparison.candidateId,
      baselinePasses: comparison.baselinePasses, candidatePasses: comparison.candidatePasses,
      verdict: comparison.verdict, fixed: comparison.fixed, regressed: comparison.regressed,
      validPairs: comparison.validPairs, plannedPairs: comparison.plannedPairs,
      scenarioFamilies: comparison.families, delta: comparison.delta, interval: comparison.interval, reasons: comparison.reasons,
    },
    limitations: record.limitations,
    nextStep: record.phase === 'review' ? 'Человеку: откройте /agent-lab, проверьте карточки, поправьте черновик и подтвердите его точную версию.'
      : record.phase === 'results_review' ? 'Человеку: откройте /agent-lab, разберите диалоги и поставьте вердикты по провалам.' : undefined,
    artifacts: { evidence: resolve(directory, `${record.id}.json`),
      ...(record.trials.length ? { traceJournal: resolve(directory, `${record.id}.trace.jsonl`) } : {}) },
  };
}

function evidenceSection(record: Experiment): string[] {
  const e = evidenceSummary(record);
  const pct = (v: number | null) => v === null ? 'нет данных' : `${Math.round(v * 100)}%`;
  const num = (v: number | null) => v === null ? 'нет данных' : v.toFixed(2);
  const target = record.target.kind === 'http' ? `http ${safeText(record.target.url)}` : record.target.kind === 'module' ? `модуль ${safeText(record.target.path)}`
    : record.target.kind === 'command' ? `процесс ${safeText([record.target.command, ...record.target.args].join(' '))}` : 'песочница (доверенные инструменты записи)';
  const v = e.verdict;
  return [
    '## Итог', '',
    safeText(v.headline), '',
    `Карточки: синтетических ${v.provenance.synthetic.cards}, golden ${v.provenance.curated.cards}, из продакшна ${v.provenance.production.cards}.`,
    ...(v.rubric.assessed ? [`${record.mode === 'demo' ? 'Сценарная оценка демо' : 'Оценка модели'} по рубрикам (не проверена): ${v.rubric.passed} из ${v.rubric.assessed} диалогов без замечаний; провалов ${v.rubric.failed}, неясно ${v.rubric.unknown}.`] : []),
    `Слабые места: ${v.weakSpots.length ? v.weakSpots.map(w => `${safeText(w.description)} (${w.failures})`).join('; ') : 'не выявлены'}.`,
    `Доверие: ${confidenceWord[v.confidence]}. ${v.confidenceReasons.map(r => safeText(r.text)).join(' ')}`, '',
    'Что дальше:', ...v.nextSteps.map(step => `- ${safeText(step.text)}`), '',
    `Испытуемый: ${target}. Реальных диалогов: ${record.dialogues.length}. Golden-кейсов: ${record.goldenCases.length}. Профилей: ${record.profiles.length} (написано владельцем: ${record.profiles.filter(p => p.source === 'owner').length}). Режимы пользователя: ${record.settings.userModes.join(', ')}.`, '',
    '## Наблюдаемый результат', '',
    ...(e.comparison ? [safeText(e.comparison.observed), safeText(e.comparison.status)] : ['Сравнения версий в этом прогоне не было. Доли пройденных ниже — наблюдения на утверждённых карточках, а не доказанное улучшение.']), '',
    '## Режимы пользователя', '', '| Режим | Пройдено / валидных | Диалогов | Реплик в среднем | Вызовов | Стоимость | Провалы, найденные только здесь |', '|---|---|---|---|---|---|---|',
    ...e.modes.map(m => `| ${m.userMode} | ${m.passed} / ${m.valid} (${pct(m.passRate)}) | ${m.trials} | ${num(m.avgUserTurns)} | ${m.calls} | ${m.costUsd === null ? 'неизвестна' : `$${m.costUsd.toFixed(4)}`} | ${m.uniqueFailedChecks.map(safeText).join(', ') || 'нет'} |`), '',
    '## Калибровка судьи', '', 'Положительный класс — «не пройдено». TPR: доля подтверждённых человеком провалов, которые судья тоже отметил. TNR: доля подтверждённых человеком прохождений, которые судья тоже пропустил.', '',
    '| Что оценивалось | Сторона | n | TPR | TNR | Согласие | Данных хватает |', '|---|---|---|---|---|---|---|',
    ...e.calibration.map(c => `| ${safeText(c.key)} | ${c.subject === 'simulator' ? 'симулятор' : 'агент'} | ${c.n} | ${pct(c.tpr)} | ${pct(c.tnr)} | ${pct(c.agreement)} | ${c.sufficient ? 'да' : 'нет (n<60)'} |`), '',
    '## Верность симулятора', '',
    ...(e.fidelity ? [
      `Реальных диалогов: ${e.fidelity.realDialogues}. Реактивных симуляций: ${e.fidelity.simulatedDialogues}. Вердикты человека о верности: ${e.fidelity.humanFidelity.passed} из ${e.fidelity.humanFidelity.reviewed} пройдено.`, '',
      '| Показатель | Реальные | Симуляция | Разрыв |', '|---|---|---|---|',
      ...e.fidelity.metrics.map(m => `| ${fidelityNames[m.metric] ?? m.metric} | ${num(m.real)} | ${num(m.simulated)} | ${m.gap === null ? 'нет данных' : m.gap.toFixed(2)} |`),
    ] : ['Реальные диалоги не загружены, верность симулятора оценить нечем.']), '',
    '## Границы доказательств', '', ...e.notes.map(n => `- ${safeText(n)}`), '',
  ];
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
    `Фаза: ${record.phase}. Режим: ${record.mode === 'demo' ? 'сценарное демо' : 'живой прогон'}. Рабочий процесс: ${record.workflow ?? 'compare'}.`,
    `Проверка карточек: ${record.reviewMode === 'human' ? 'человеком' : record.reviewMode === 'automated' ? 'автоматическая' : 'ожидается'}. Аудит результатов: ${record.resultsReviewedAt ?? 'не завершён'}.`, '',
    safeText(record.message), '',
    `Карточек: ${record.scenarios.length}. Диалогов: ${record.trials.length}. Вердиктов человека: ${record.humanReviews?.length ?? 0}.`,
    `${record.mode === 'demo' ? 'Сценарных вызовов' : 'Вызовов модели'}: ${record.usage.calls}. Наблюдаемая стоимость: ${record.usage.costUsd === null ? 'неизвестна' : `$${record.usage.costUsd.toFixed(4)}`}.`, '',
    ...evidenceSection(record),
    ...record.trials.flatMap(t => [
      `## ${t.id} · ${safeText(record.scenarios.find(s => s.id === t.scenarioId)?.title ?? t.scenarioId)}`, '',
      `Объективный исход: ${outcomeWord[t.outcome] ?? t.outcome}. ${safeText(t.reason)}`,
      ...t.checks.map(c => `- ${c.passed ? 'ПРОЙДЕНА' : 'ПРОВАЛЕНА'} ${safeText(c.description)}: ${safeText(c.evidence)}`),
      ...(t.assessments ?? []).map(a => `- ${record.mode === 'demo' ? 'Сценарная оценка демо' : 'Оценка модели'} [${a.metricId}]: ${verdictWord[a.result] ?? a.result}. ${safeText(a.rationale)}. Основания: ${a.evidence.map(n => `#${n}`).join(', ') || 'не указаны'}`),
      ...(t.assessmentError ? [`- Ошибка оценщика: ${safeText(t.assessmentError)}`] : []),
      ...(record.humanReviews ?? []).filter(r => r.trialId === t.id).map(r => `- Человек [${r.metricId ?? r.checkId ?? 'весь диалог'}]: ${verdictWord[r.verdict] ?? r.verdict}. ${safeText(r.note)}`), '',
    ]),
    ...record.limitations.map(v => `- ${safeText(v)}`), '',
    'Полные трассы, состояния и исходные оценки лежат в JSON доказательств и журнале трасс.',
    'Экспортированный AgentSpec — конфигурация песочного агента, а не отдельно установленный продовый агент.', '',
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
    name: 'agent_lab_build', label: 'Prepare agent and dialogue cards',
    description: 'Prepare an agent and a small editable set of user simulation cards from task/material contents. Uses current Pi model unless settings override. Stops before all dialogue evaluation: only a human in /agent-lab can review and approve the exact draft. Does not run, improve or approve the agent. mode=demo prepares the built-in scripted example without model calls. Native workflow is evaluation, with 5 cards and 1 repeat by default. target selects the agent under test: the trusted sandbox (default), an http endpoint, a local module adapter, or a local process (command, e.g. python3 agent.py speaking JSON lines). goldenCases become curated cards; dialogues (de-identified real conversations) ground observed user profiles, production cards that open with real users\' own messages, and simulator fidelity. settings.userModes may list static, scripted and reactive to compare what each user side finds. notes carry the owner\'s hints about users in their own words; profiles are owner-written user types. Both are legitimate inputs when no real data exists, and the verdict always states how much of the evidence is synthetic. preset=thorough widens the run without extra settings. Every result leads with a plain verdict: pass count, weak spots, confidence and next steps.',
    parameters: Type.Object({
      task: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      materials: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 180 }), content: Type.String({ minLength: 1, maxLength: 120000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 12 })),
      existingAgent: Type.Optional(Type.Unsafe(z.toJSONSchema(agentSchema))),
      settings: Type.Optional(Type.Unsafe(z.toJSONSchema(settingsSchema, { io: 'input' }))),
      scenarioCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      target: Type.Optional(Type.Unsafe(z.toJSONSchema(targetSchema, { io: 'input' }))),
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
        let section: 'agent' | 'cards' | 'results' | 'stats' | undefined;
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
              const scripted = r.settings.userModes.includes('scripted') ? r.scenarios.filter(s => s.user.script?.length).length : 0;
              const planned = r.settings.userModes.reduce((sum, mode) => sum + (mode === 'scripted' ? scripted : r.scenarios.length), 0) * r.settings.repeats;
              const target = r.target.kind === 'sandbox' ? 'песочница с доверенными инструментами' : r.target.kind === 'http' ? `внешний агент по HTTP ${safeText(r.target.url)}`
                : r.target.kind === 'module' ? `внешний агент из модуля ${safeText(r.target.path)}` : `внешний агент как процесс ${safeText([r.target.command, ...r.target.args].join(' '))}`;
              const message = `Я проверил агента, материалы, цели, пользователей и метрики всех ${r.scenarios.length} карточек.\nЦель: ${target}.\nРежимы пользователя: ${r.settings.userModes.join(', ')}.\nЗапуск: ${planned} диалогов, ${r.settings.repeats} повтор(а), до ${r.settings.maxTurns} ходов, лимит ${r.settings.maxCalls} вызовов.\n${r.mode === 'demo' ? 'Сценарный демо: без модели.' : `Модель: ${safeText(r.settings.provider)}/${safeText(r.settings.model)}. Стоимость заранее неизвестна.`}\nВерсия: ${hash}\nПодтвердить эту версию и запустить?`;
              if (await ctx.ui.confirm('Проверка карточек человеком', message)) {
                await lab.start(r.id, { approved: true, reviewer: 'human', expectedHash: hash }); section = 'results'; selected = 0;
              }
            } else if (action.type === 'cancel') {
              await lab.cancel(action.record.id); await lab.waitForIdle();
            } else if (action.type === 'verdict') {
              const trial = reviewOrder(action.record)[action.selected];
              if (!trial) throw new Error('Диалог не выбран.');
              await lab.addHumanReview(action.record.id, {
                trialId: trial.id, verdict: action.verdict,
                note: `Быстрый вердикт с доски, без пояснения. Первый провал в диалоге: ${safeText(trial.checks.find((c: { passed: boolean }) => !c.passed)?.description ?? trial.reason).slice(0, 200)}`,
              });
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
