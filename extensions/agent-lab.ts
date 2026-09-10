import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { z } from 'zod';
import { ExperimentLab, draftHash, resultHash } from '../dist/experiment.js';
import { agentSchema, createInputSchema, dialogueSchema, draftPatchSchema, goldenCaseSchema, ownerProfileSchema, profileUser, settingsSchema, targetSchema, type DraftPatch, type Experiment, type HumanReviewInput, type Profile } from '../dist/contracts.js';
import { compareRuns, evidenceSummary } from '../dist/comparison.js';
import { demoInput } from '../dist/demo.js';
import { htmlReport } from '../dist/report.js';
import { activePhases, reviewOrder, safeText, showBoard, verdicts, type BoardAction, type Section } from './cards.ts';

const confidenceWord: Record<string, string> = { low: 'низкое', medium: 'среднее', high: 'высокое' };
const tierWord: Record<string, string> = { smoke: 'дымовые', regression: 'регрессия', frontier: 'фронтир' };
const outcomeWord: Record<string, string> = {
  pass: 'пройден', fail: 'не пройден', ungraded: 'без объективной оценки', invalid: 'невалиден', cancelled: 'остановлен',
};
const verdictWord: Record<string, string> = { pass: 'пройдено', fail: 'не пройдено', unknown: 'неясно', invalid: 'невалидно' };
const fidelityNames: Record<string, string> = {
  userTurns: 'реплик пользователя на диалог', userMessageLength: 'длина реплики, символов',
  questionRate: 'доля реплик с вопросом', disengagementRate: 'доля ушедших пользователей',
};
const toolDisplay: Pick<ToolDefinition, 'renderCall' | 'renderResult'> = {
  renderCall: (_args, theme) => new Text(theme.fg('accent', 'Проверка агента'), 0, 0),
  renderResult: (result, options, theme) => {
    const raw = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (options.expanded) return new Text(safeText(raw), 0, 0);
    try {
      const data = JSON.parse(raw);
      const title = data.error ?? (data.phase === 'review' ? `Готово ${data.scenarioCount} сценариев. Посмотрите их перед запуском.`
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
  return {
    id: record.id, phase: record.phase, mode: record.mode, workflow: record.workflow,
    reviewMode: record.reviewMode, resultsReviewedAt: record.resultsReviewedAt,
    draftHash: draftHash(record), resultHash: record.trials.length ? resultHash(record) : undefined,
    message: record.message, error: record.error, questions: record.questions,
    scenarioCount: record.scenarios.length, revisionCount: record.revisions.length,
    target: record.target, profileCount: record.profiles.length, evidence: evidenceSummary(record),
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
    `Слабые места: ${v.weakSpots.length ? v.weakSpots.map(w => `${w.stage ? `[${safeText(w.stage)}] ` : ''}${safeText(w.description)} (${w.failures})`).join('; ') : 'не выявлены'}.`,
    ...(v.stages.length ? ['', 'По этапам работы агента:', ...v.stages.map(st => `- ${safeText(st.stage)}: ${st.passed} из ${st.evaluated}`)] : []),
    ...(v.tiers.some(t => t.cards) ? ['', `По ступеням: ${v.tiers.filter(t => t.cards).map(t => `${tierWord[t.tier]} ${t.passed}/${t.graded}`).join(' · ')}.`] : []),
    `Доверие: ${confidenceWord[v.confidence]}. ${v.confidenceReasons.map(r => safeText(r.text)).join(' ')}`, '',
    ...(record.failureModes?.length ? ['', 'Типы провалов в этом прогоне:',
      ...record.failureModes.map(mode => `- **${safeText(mode.name)}**${mode.stage ? ` [${safeText(mode.stage)}]` : ''} — ${mode.trialIds.length} диалог(ов). ${safeText(mode.description)}`),
      '', 'Кластеры построены по диалогам этого прогона и не описывают продовый трафик.'] : []),
    '', 'Что дальше:', ...v.nextSteps.map(step => `- ${safeText(step.text)}`), '',
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

async function exportArtifacts(record: Experiment, directory: string, comparison?: Parameters<typeof htmlReport>[1]) {
  const exportDir = resolve(directory, 'exports');
  await mkdir(exportDir, { recursive: true, mode: 0o700 });
  const stem = `${record.id}.${randomUUID().slice(0, 8)}`;
  const report = resolve(exportDir, `${stem}.report.md`);
  const html = resolve(exportDir, `${stem}.report.html`);
  const selected = record.target.kind === 'sandbox' ? record.revisions.find(r => r.id === record.selectedRevisionId)?.spec : undefined;
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
  await writeFile(html, htmlReport(record, comparison), { mode: 0o600, flag: 'wx' });
  if (agent && selected) await writeFile(agent, JSON.stringify(selected, null, 2), { mode: 0o600, flag: 'wx' });
  return { ...summary(record, directory).artifacts, report, htmlReport: html, ...(agent ? { agent } : {}) };
}

async function editDraft(ctx: ExtensionContext, action: Extract<BoardAction, { record: Experiment }>): Promise<DraftPatch | undefined> {
  const { record } = action;
  const editJSON = async (title: string, value: unknown) => {
    const text = await ctx.ui.editor(title, safeText(JSON.stringify(value, null, 2)));
    return text === undefined ? undefined : JSON.parse(text);
  };
  const editProfile = async (profile: Profile, field?: 'persona' | 'characteristics'): Promise<DraftPatch | undefined> => {
    const choice = field ?? await ctx.ui.select(`Профиль ${safeText(profile.id)} · исходные данные сохранятся`, ['Персона', 'Характеристики', 'Восстановить исходный профиль']);
    if (!choice) return;
    if (choice === 'Восстановить исходный профиль') return { profileEdits: [{ id: profile.id, override: null }] };
    const key = choice === 'Персона' || choice === 'persona' ? 'persona' : 'characteristics';
    const user = profileUser(profile);
    const count = record.scenarios.filter(s => s.profileId === profile.id).length;
    const changed = await ctx.ui.editor(`${key === 'persona' ? 'Персона' : 'Характеристики · по одной в строке'} · ${count} карточек · пусто = убрать`, safeText(key === 'persona' ? user.persona ?? '' : user.characteristics?.join('\n') ?? ''));
    if (changed === undefined) return;
    return { profileEdits: [{ id: profile.id, override: { ...profile.draftOverride,
      [key]: key === 'persona' ? changed.trim() || null : changed.split('\n').map(v => v.trim()).filter(Boolean),
    } }] };
  };
  if (action.type === 'settings') {
    const choice = await ctx.ui.select('Настройки прогона', [
      'Быстрый · реактивные диалоги, один повтор', 'Полный · три режима, два повтора',
      'Версия агента · название релиза или коммит', 'Подключение · команда, модуль или HTTP', 'Профили пользователей', 'Лимиты · расширенные настройки',
    ]);
    if (choice?.startsWith('Быстрый')) return { settings: { userModes: ['reactive'], repeats: 1 } };
    if (choice?.startsWith('Полный')) return { settings: { userModes: ['static', 'scripted', 'reactive'], repeats: 2 } };
    if (choice?.startsWith('Версия')) {
      const targetVersion = await ctx.ui.editor('Версия агента · например acquiring-v3', record.targetVersion ?? '');
      return targetVersion === undefined ? undefined : { targetVersion };
    }
    if (choice?.startsWith('Подключение')) {
      const target = await editJSON('Подключение агента · JSON', record.target);
      return target === undefined ? undefined : { target };
    }
    if (choice === 'Профили пользователей') {
      if (!record.profiles.length) { ctx.ui.notify('Профилей нет. Карточки могут работать по цели, фактам и поведению.', 'info'); return; }
      const labels = record.profiles.map(p => `${p.id} · ${profileUser(p).persona ?? 'Без персоны'}${p.draftOverride ? ' · изменён' : ''}`);
      const selected = await ctx.ui.select('Какой профиль изменить?', labels.map(safeText));
      const profile = record.profiles[labels.map(safeText).indexOf(selected ?? '')];
      return profile ? editProfile(profile) : undefined;
    }
    if (choice?.startsWith('Лимиты')) {
      const settings = await editJSON('Лимиты · повторы, ходы, вызовы и время', record.settings);
      return settings === undefined ? undefined : { settings };
    }
    return;
  }
  if (action.section === 'cards' && record.scenarios[action.selected]) {
    const scenarios = structuredClone(record.scenarios);
    const scenario = scenarios[action.selected]!;
    const fields = [
      ['profileId', 'Профиль пользователя · выбрать или убрать'],
      ['title', 'Название'], ['persona', 'Персона'], ['characteristics', 'Характеристики · по одной в строке'],
      ['goal', 'Цель пользователя'], ['behavior', 'Поведение'], ['facts', 'Факты, известные пользователю'],
      ['opening', 'Первая реплика'], ['maxFollowUps', 'Максимум ответов после первой реплики'],
      ['successCriteria', 'Критерий успеха'], ['assumptions', 'Допущения · по одному в строке'],
      ['tier', 'Ступень · дымовая, регрессия или фронтир'], ['script', 'Скрипт пользователя · по одной реплике в строке'],
      ['metrics', 'Метрики · JSON'], ['checks', 'Точные проверки · JSON'], ['initialState', 'Начальное состояние · JSON'],
      ['all', 'Все карточки · JSON'],
    ] as const;
    const choice = await ctx.ui.select('Что изменить в карточке?', fields.map(([, label]) => label));
    const entry = fields.find(([, label]) => label === choice);
    if (!entry) return;
    const [field, title] = entry;
    if (field === 'profileId') {
      const labels = ['Без профиля и персоны', ...record.profiles.map(p => `${p.id} · ${profileUser(p).persona ?? 'Без персоны'}`)].map(safeText);
      const selected = await ctx.ui.select('Профиль этой карточки', labels);
      const index = labels.indexOf(selected ?? '');
      if (index < 0) return;
      delete scenario.user.persona; delete scenario.user.characteristics;
      if (index === 0) delete scenario.profileId;
      else scenario.profileId = record.profiles[index - 1]!.id;
      return { scenarios };
    }
    if (scenario.profileId && (field === 'persona' || field === 'characteristics')) {
      return editProfile(record.profiles.find(p => p.id === scenario.profileId)!, field);
    }
    if (field === 'all') {
      const changed = await editJSON(title, scenarios);
      return changed === undefined ? undefined : { scenarios: changed };
    }
    if (field === 'tier') {
      const value = await ctx.ui.select('Ступень карточки', ['smoke · базовое поведение', 'regression · уже работает', 'frontier · новая возможность']);
      if (!value) return;
      scenario.tier = value.split(' ')[0] as typeof scenario.tier;
      return { scenarios };
    }
    const userFields = new Set(['persona', 'characteristics', 'goal', 'behavior', 'facts', 'opening', 'maxFollowUps', 'script']);
    const object = (userFields.has(field) ? scenario.user : scenario) as unknown as Record<string, unknown>;
    if (['metrics', 'checks', 'initialState'].includes(field)) {
      const changed = await editJSON(title, object[field] ?? []);
      if (changed === undefined) return;
      object[field] = changed;
    } else {
      const array = field === 'characteristics' || field === 'assumptions' || field === 'script';
      const before = object[field];
      const changed = await ctx.ui.editor(title, safeText(array ? (before as string[] | undefined)?.join('\n') ?? '' : before ?? ''));
      if (changed === undefined) return;
      object[field] = array ? changed.split('\n').map(v => v.trim()).filter(Boolean) : field === 'maxFollowUps' ? Number(changed) : changed;
      if (field === 'persona' && !changed.trim()) delete object[field];
    }
    return { scenarios };
  }
  const agent = record.revisions.find(r => r.id === record.selectedRevisionId)?.spec;
  if (!agent) throw new Error('Агент ещё не подготовлен.');
  const choice = await ctx.ui.select('Что изменить?', record.target.kind === 'sandbox' ? ['Инструкции агента', 'Агент целиком · JSON', 'Все карточки · JSON'] : ['Все карточки · JSON']);
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
        const output = { ...summary(record, lab.store.directory), artifacts: await exportArtifacts(record, lab.store.directory), ...(signal.aborted ? { cancelled: true } : {}) };
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
        await lab.init();
        const record = await lab.get(params.id);
        const controlVisible = record.workflow === 'evaluate' || !!record.controlConsumedAt && !activePhases.has(record.phase);
        const trial = params.trialId ? record.trials.find(t => t.id === params.trialId) : undefined;
        if (params.trialId && !trial) throw new Error('Trial not found in this experiment.');
        if (trial?.split === 'control' && !controlVisible) throw new Error('Control evidence stays hidden until the final control phase stops.');
        const output = trial ?? {
          ...summary(record, lab.store.directory), agent: record.revisions.find(r => r.id === record.selectedRevisionId)?.spec,
          settings: record.settings, requirements: record.requirements, profiles: record.profiles,
          scenarios: record.scenarios.filter(s => s.split === 'dev' || controlVisible), revisions: record.revisions, iterations: record.iterations,
          trials: record.trials.filter(t => t.split === 'dev' || controlVisible).map(t => ({ id: t.id, revisionId: t.revisionId, scenarioId: t.scenarioId, split: t.split, outcome: t.outcome, reason: t.reason })),
          ...(params.export ? { artifacts: await exportArtifacts(record, lab.store.directory) } : {}),
        };
        returnToBoard(ctx, record.id);
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], details: { id: record.id } };
      } finally { await close(); }
    },
  });
  pi.registerTool({
    ...toolDisplay,
    name: 'agent_lab_edit', label: 'Edit an unapproved agent draft',
    description: 'Edit draft scenarios, AgentSpec, settings, target or targetVersion after inspecting the current draftHash. Preserves human approval as pending. Cannot change started experiments, run dialogues, record human verdicts, or approve results.',
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
    description: 'Проверить агента: /agent-lab, /agent-lab new или /agent-lab /путь/к/проекту',
    async handler(args, ctx) {
      if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Human review requires the native Pi terminal. Start interactive Pi and open /agent-lab. Headless tools only prepare and edit drafts.');
      const startRequest = args.trim() === 'new' || args.trim().startsWith('/') || args.trim().startsWith('~');
      let handoff: { request: string; context: unknown } | undefined;
      const { lab, close } = open(ctx.cwd);
      try {
        await lab.init();
        let id = startRequest ? undefined : args.trim() || undefined;
        let section: Section | undefined;
        let selected = 0;
        let query = '';
        let pendingOnly = false;
        let beforeId: string | undefined;
        let newRequested = startRequest;
        while (true) {
          const record = id ? await lab.get(id) : undefined;
          const comparison = record && beforeId ? compareRuns(await lab.get(beforeId), record) : undefined;
          const action: BoardAction = newRequested ? { type: 'new' } : await showBoard(ctx, record ? { record, section, selected, query, pendingOnly, comparison, load: () => lab.get(record.id) } : { records: await lab.list() });
          if (action.type === 'new') {
            const request = newRequested && args.trim() !== 'new' ? `Проверь агента в ${args.trim()}`
              : await ctx.ui.editor('Папка агента и что проверить · своими словами', '');
            newRequested = false;
            if (!request?.trim()) continue;
            handoff = { request, context: { task: 'Prepare a new Agent Lab draft. Read the authorized local agent project and relevant materials; infer or prepare its adapter. Use agent_lab_build, then explain the proposed user scenarios in plain language. Do not run dialogues or claim human review. Follow the agent-builder skill.' } };
            break;
          }
          if (action.type === 'open') { id = action.id; section = undefined; selected = 0; query = ''; pendingOnly = false; beforeId = undefined; continue; }
          if (action.type === 'close' || action.type === 'back') {
            const latest = id ? await lab.get(id) : undefined;
            if (latest && activePhases.has(latest.phase)) {
              if (!await ctx.ui.confirm('Остановить диалоги и выйти?', 'Текущий запуск будет остановлен. Уже записанные доказательства сохранятся.')) continue;
              await lab.cancel(latest.id); await lab.waitForIdle();
            }
            if (action.type === 'close') break;
            id = undefined; section = undefined; selected = 0; query = ''; pendingOnly = false; beforeId = undefined; continue;
          }
          section = action.section; selected = action.selected;
          query = action.query ?? ''; pendingOnly = action.pendingOnly ?? false;
          try {
            if (action.type === 'discuss') {
              const r = action.record;
              const request = await ctx.ui.editor(r.phase === 'review' ? 'Что изменить или уточнить? · обычными словами' : 'Что разобрать вместе с Pi?',
                r.phase === 'review' ? '' : 'Объясни, что сломалось, на каких репликах это видно и что делать дальше.');
              if (!request?.trim()) continue;
              handoff = { request, context: { experimentId: r.id, phase: r.phase,
                scenarioId: action.section === 'cards' ? r.scenarios[action.selected]?.id : undefined, trialId: action.trialId,
                task: 'This user request concerns the selected Agent Lab experiment. Inspect fresh evidence with agent_lab_inspect. For draft corrections, use agent_lab_edit with the current hash and summarize changes. For unresolved business questions or a preparation error, read the original evidence file and prepare a new draft with the supplied corrections; preserve the old one. For results, inspect actual trial traces and report the failure, cited trial/event IDs, whether a human confirmed it, and a concrete next step. Distinguish facts from suspected causes. Never overwrite measured results, invent human verdicts, approve or run a draft. Do not alter the external agent without an explicit request to fix it.' } };
              break;
            } else if (action.type === 'repeat') {
              const next = await lab.repeat(action.record.id);
              beforeId = action.record.id; id = next.id; section = 'agent'; selected = 0; query = ''; pendingOnly = false;
            } else if (action.type === 'compare') {
              if (action.record.parentRunId) beforeId = action.record.parentRunId;
              else {
                const others = (await lab.list()).filter(r => r.id !== action.record.id && r.workflow === 'evaluate' && r.trials.length);
                if (!others.length) { ctx.ui.notify('Для сравнения нужен ещё один прогон. Нажмите r, чтобы повторить этот набор.', 'info'); continue; }
                const labels = others.map(r => `${r.createdAt.slice(0, 16).replace('T', ' ')} · ${safeText(r.targetVersion ?? r.id.slice(0, 8))} · ${safeText(r.task)}`);
                const chosen = await ctx.ui.select('С чем сравнить текущий прогон?', labels);
                if (chosen === undefined) continue;
                beforeId = others[labels.indexOf(chosen)]?.id;
              }
              section = 'comparison'; query = ''; selected = 0;
            } else if (action.type === 'edit' || action.type === 'settings') {
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
              const trial = action.trialId ? action.record.trials.find(t => t.id === action.trialId) : reviewOrder(action.record)[action.selected];
              if (!trial) throw new Error('Диалог не выбран.');
              await lab.addHumanReview(action.record.id, {
                trialId: trial.id, verdict: action.verdict,
                note: `Быстрый вердикт с доски, без пояснения. Первый провал в диалоге: ${safeText(trial.checks.find((c: { passed: boolean }) => !c.passed)?.description ?? trial.reason).slice(0, 200)}`,
              });
            } else if (action.type === 'annotate') {
              const index = action.trialId ? reviewOrder(action.record).findIndex(t => t.id === action.trialId) : action.selected;
              const review = await humanAnnotation(ctx, action.record, index);
              if (review) await lab.addHumanReview(action.record.id, review);
            } else if (action.type === 'finalize') {
              const r = action.record;
              const hash = resultHash(r);
              const invalid = r.trials.filter(t => t.outcome === 'invalid' || t.outcome === 'cancelled').length;
              const ungraded = r.trials.filter(t => t.outcome === 'ungraded').length;
              if (await ctx.ui.confirm('Завершить человеческий аудит?', `Я проверил диалоги, основания оценок и поведение симуляторов.\nДиалогов: ${r.trials.length}; невалидных/остановленных: ${invalid}; без объективной оценки: ${ungraded}.\nОтдельных заметок человека: ${r.humanReviews?.length ?? 0}. ${r.mode === 'demo' ? 'Сценарные оценки демо останутся отдельными от моих.' : 'Оценки модели останутся отдельными от моих.'}\nВерсия результатов: ${hash}\nПодтвердить проверку всего набора?`)) {
                const reviewed = await lab.reviewResults(r.id, hash);
                const artifacts = await exportArtifacts(reviewed, lab.store.directory, comparison);
                ctx.ui.notify(`Аудит сохранён. Отчёт: ${safeText(artifacts.htmlReport)}`, 'info');
              }
            } else if (action.type === 'export') {
              const artifacts = await exportArtifacts(action.record, lab.store.directory, comparison);
              ctx.ui.notify(safeText(`Отчёт: ${artifacts.htmlReport}\nMarkdown: ${artifacts.report}\nДоказательства: ${artifacts.evidence}`), 'info');
            }
          } catch (error) { ctx.ui.notify(safeText(error instanceof Error ? error.message : error), 'error'); }
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
