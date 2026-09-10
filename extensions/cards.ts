import type { ExtensionContext, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import type { Experiment, Scenario, Trial } from '../dist/contracts.js';
import { awaitingVerdict, evidenceSummary, verdictSummary, type VerdictNote } from '../dist/comparison.js';

/** All material, model and persisted text crosses this boundary before terminal rendering. */
export function safeText(value: unknown): string {
  return stripTerminalSequences(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}

export const activePhases = new Set(['preparing', 'evaluating', 'baseline', 'improving', 'control']);
const phases: Record<string, string> = {
  preparing: 'ПОДГОТОВКА', review: 'ПРОВЕРЬТЕ КАРТОЧКИ', evaluating: 'ИДУТ ДИАЛОГИ',
  results_review: 'ПРОВЕРЬТЕ РЕЗУЛЬТАТЫ', complete: 'ЗАВЕРШЕНО', cancelled: 'ОСТАНОВЛЕНО',
  error: 'ОШИБКА', interrupted: 'ПРЕРВАНО', baseline: 'БАЗОВАЯ ВЕРСИЯ', improving: 'УЛУЧШЕНИЕ', control: 'КОНТРОЛЬ',
};
export const verdicts: Record<string, string> = {
  pass: 'ПРОЙДЕНО', fail: 'НЕ ПРОЙДЕНО', unknown: 'НЕЯСНО', invalid: 'НЕВАЛИДНО', cancelled: 'ОСТАНОВЛЕНО', ungraded: 'БЕЗ ОЦЕНКИ',
};

/**
 * Review order: dialogues still waiting for a decisive verdict come first, then the rest.
 * Reviewing one moves it out of the queue, so the same position lands on the next case
 * and a person can go through failures without navigating.
 */
export function reviewOrder(record: Experiment): Trial[] {
  const pending = awaitingVerdict(record);
  const rank = (trial: Trial) => pending.has(trial.id) ? 0 : trial.outcome === 'fail' || trial.outcome === 'invalid' ? 1 : 2;
  return record.trials.map((trial, index) => ({ trial, index })).sort((a, b) => rank(a.trial) - rank(b.trial) || a.index - b.index).map(v => v.trial);
}

type Section = 'agent' | 'cards' | 'results' | 'stats';
export type BoardAction =
  | { type: 'close' }
  | { type: 'back' }
  | { type: 'open'; id: string }
  | { type: 'edit' | 'settings' | 'run' | 'annotate' | 'finalize' | 'export' | 'cancel'; record: Experiment; section: Section; selected: number }
  | { type: 'verdict'; verdict: 'pass' | 'fail'; record: Experiment; section: Section; selected: number };
export interface BoardOptions {
  records?: Experiment[];
  record?: Experiment;
  section?: Section;
  selected?: number;
  load?: () => Promise<Experiment>;
}
type BoardTheme = Pick<Theme, 'fg' | 'bold'>;
type Line = { text: string; color?: ThemeColor; bold?: boolean };
const line = (text: unknown, color?: ThemeColor, bold = false): Line => ({ text: safeText(text), color, bold });
const json = (value: unknown) => JSON.stringify(value, null, 2);
const outcomeColor = (value: string): ThemeColor => value === 'pass' ? 'success' : value === 'fail' || value === 'invalid' ? 'error' : 'warning';

function scenarioLines(scenario: Scenario, record: Experiment, expanded: boolean): Line[] {
  const rows = [
    line(scenario.title, 'accent', true),
    line(`${scenario.id} · ${tierLabels[scenario.tier] ?? scenario.tier} · ${scenario.provenance === 'synthetic' ? 'Синтетический пользователь' : 'Курированный пример'}${record.workflow !== 'evaluate' ? ` · ${scenario.split === 'control' ? 'Контроль: скрыт от билдера' : 'Разработка'}` : ''}`, 'muted'),
    line(''), line('ПОЛЬЗОВАТЕЛЬ', 'accent'),
    line(scenario.user.persona || 'Персона не задана'),
    ...(scenario.user.characteristics ?? []).map(v => line(`• ${v}`)),
    line(`Цель: ${scenario.user.goal}`), line(`Поведение: ${scenario.user.behavior}`),
    line(`Знает: ${scenario.user.facts}`), line(`Первая реплика: «${scenario.user.opening}»`),
    line(`Лимит: ${scenario.user.maxFollowUps ?? Math.max(0, record.settings.maxTurns - 1)} ответов после первой реплики`, 'muted'),
    line(''), line('УСПЕХ', 'accent'), line(scenario.successCriteria || 'Описан проверками и метриками ниже.'),
    ...scenario.checks.map(c => line(`□ ${c.stage ? `[${c.stage}] ` : ''}${c.description} [${c.id}]`)),
    ...(scenario.metrics ?? []).flatMap(m => [
      line(`${m.subject === 'simulator' ? 'Симулятор' : 'Агент'} · ${m.stage ? `[${m.stage}] ` : ''}${m.name} [${m.id}]`, 'text', true),
      line(m.description), line(`Прошёл: ${m.passCriteria}`), line(`Не прошёл: ${m.failCriteria}`),
    ]),
    line(''), line('ДОПУЩЕНИЯ', 'accent'),
    ...(scenario.assumptions?.length ? scenario.assumptions.map(v => line(`• ${v}`)) : [line('Не указаны', 'muted')]),
  ];
  if (expanded) rows.push(
    line(''), line('ОСНОВАНИЯ В МАТЕРИАЛАХ', 'accent'),
    ...record.requirements.filter(r => scenario.requirementIds.includes(r.id)).flatMap(r => [
      line(`${r.id} · ${r.text}`, 'text', true),
      line(`${record.sources.find(s => s.id === r.sourceId)?.name ?? r.sourceId}: «${r.quote}»`, 'muted'),
    ]),
    line(''), line('НАЧАЛЬНОЕ СОСТОЯНИЕ', 'accent'), line(json(scenario.initialState)),
    line(''), line('ТОЧНЫЕ ПРОВЕРКИ', 'accent'), line(json(scenario.checks)),
  );
  return rows;
}

function trialLines(trial: Trial, record: Experiment, expanded: boolean): Line[] {
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  const rows = [
    line(scenario?.title ?? trial.scenarioId, 'accent', true),
    line(`${verdicts[trial.outcome]} · повтор ${trial.repeat + 1} · ${trial.id}`, outcomeColor(trial.outcome)),
    ...(record.workflow !== 'evaluate' ? [line(`Версия агента: ${trial.revisionId}`, 'muted')] : []),
    line(trial.reason),
    line(`${trial.usage.calls} вызовов · ${(trial.elapsedMs / 1000).toFixed(1)} с · стоимость ${trial.usage.costUsd === null ? 'неизвестна' : `$${trial.usage.costUsd.toFixed(4)}`}`, 'muted'),
    line(''), line('ДЕТЕРМИНИРОВАННЫЕ ПРОВЕРКИ', 'accent'),
    ...(trial.checks.length ? trial.checks.flatMap(c => [
      line(`${c.passed ? '✓' : '×'} ${c.description} [${c.id}]`, c.passed ? 'success' : 'error'), line(c.evidence, 'muted'),
    ]) : [line('Проверок состояния нет. Итог не означает успех по всем метрикам.', 'muted')]),
    line(''), line(record.mode === 'demo' ? 'СЦЕНАРНАЯ ОЦЕНКА ДЕМО — ПРОВЕРЬТЕ ПО ТРАССЕ' : 'ОЦЕНКА МОДЕЛЬЮ — ПРОВЕРЬТЕ ПО ТРАССЕ', 'accent'),
    ...(scenario?.metrics ?? []).flatMap(m => {
      const a = trial.assessments?.find(a => a.metricId === m.id);
      return [line(`${m.subject === 'simulator' ? 'Симулятор' : 'Агент'} · ${m.name}: ${a ? verdicts[a.result] : 'НЕТ ОЦЕНКИ'}`, a ? outcomeColor(a.result) : 'warning'),
        line(a?.rationale ?? 'Оценка отсутствует; это не прохождение.'),
        line(`Основания: ${a?.evidence.length ? a.evidence.map(seq => `#${seq}`).join(', ') : 'не указаны'}`, 'muted'),
        ...(expanded ? [line(`Критерий успеха: ${m.passCriteria}`), line(`Критерий провала: ${m.failCriteria}`)] : [])];
    }),
    ...(trial.assessmentError ? [line(`Ошибка оценщика: ${trial.assessmentError}`, 'error')] : []),
    line(''), line('ОТДЕЛЬНАЯ ПРОВЕРКА ЧЕЛОВЕКОМ', 'accent'),
    ...(record.humanReviews?.filter(r => r.trialId === trial.id).flatMap(r => [
      line(`${verdicts[r.verdict]} · ${r.metricId ? `метрика ${r.metricId}` : r.checkId ? `проверка ${r.checkId}` : 'весь диалог'}`, outcomeColor(r.verdict)), line(r.note),
    ]) ?? []),
  ];
  if (!record.humanReviews?.some(r => r.trialId === trial.id)) rows.push(line(
    record.resultsReviewedAt ? 'Набор проверен человеком, но у этого диалога вердикта нет: p — пройдено, n — не пройдено, v — подробно.'
      : 'Вердикта человека нет. p — пройдено, n — не пройдено, v — подробно с пояснением.', 'muted'));
  rows.push(line(''), line('ДИАЛОГ И ИНСТРУМЕНТЫ', 'accent'));
  const roles = { user: 'ПОЛЬЗОВАТЕЛЬ', assistant: 'АГЕНТ', simulator: 'СИМУЛЯТОР', tool_call: 'ВЫЗОВ', tool_result: 'РЕЗУЛЬТАТ', error: 'ОШИБКА' };
  for (const event of trial.events) {
    rows.push(line(`#${event.seq}  ${roles[event.type]}${event.tool ? ` · ${event.tool}` : ''}`, event.type === 'user' ? 'accent' : event.type === 'error' ? 'error' : 'text', true));
    if (event.text !== undefined) rows.push(line(event.text));
    if (event.args !== undefined) rows.push(line(json(event.args), 'muted'));
    if (event.result !== undefined) rows.push(line(json(event.result), 'muted'));
    if (expanded && event.state !== undefined) rows.push(line(json(event.state), 'muted'));
    rows.push(line(''));
  }
  if (expanded) rows.push(line('СОСТОЯНИЕ ДО', 'accent'), line(json(trial.initialState)), line('СОСТОЯНИЕ ПОСЛЕ', 'accent'), line(json(trial.finalState)));
  return rows;
}

const confidenceLabels: Record<string, string> = { low: 'низкое', medium: 'среднее', high: 'высокое' };
const tierLabels: Record<string, string> = { smoke: 'дымовые', regression: 'регрессия', frontier: 'фронтир' };
/** Verdict wording comes from the record itself, so the board, the report and the CLI never disagree. */
const noteText = (note: VerdictNote): string => note.text;

/** The simple layer: what passed, where it is weak, how much to trust it, what to do next. Research statistics live in section 4. */
function verdictLines(record: Experiment): Line[] {
  const v = verdictSummary(record);
  const p = v.provenance;
  return [
    line('ИТОГ', 'accent', true),
    line(v.graded ? `Пройдено ${v.passed} из ${v.graded} диалогов (${Math.round((v.passRate ?? 0) * 100)}%).` : v.rubric.assessed ? 'Объективных проверок нет.' : 'Диалогов с оценкой ещё нет.', 'text', true),
    ...(v.rubric.assessed ? [line(`${record.mode === 'demo' ? 'Сценарная оценка демо' : 'Оценка модели'} по рубрикам (не проверена): ${v.rubric.passed} из ${v.rubric.assessed} диалогов без замечаний.`, 'muted')] : []),
    line(`Карточки: синтетических ${p.synthetic.cards}, golden ${p.curated.cards}, из продакшна ${p.production.cards}.`, 'muted'),
    line(v.weakSpots.length ? `Слабые места: ${v.weakSpots.map(w => `${w.stage ? `[${w.stage}] ` : ''}${w.description} (${w.failures} провал(ов))`).join('; ')}.` : 'Слабые места: не выявлены.'),
    ...(v.stages.length ? [line('По этапам работы агента:', 'accent'),
      ...v.stages.map(st => line(`  ${st.stage}: ${st.passed} из ${st.evaluated}`, st.passed === st.evaluated ? 'success' : 'warning'))] : []),
    ...(v.tiers.some(t => t.cards) ? [line(`По ступеням: ${v.tiers.filter(t => t.cards).map(t => `${tierLabels[t.tier]} ${t.passed}/${t.graded || 0}`).join(' · ')}.`, 'muted')] : []),
    line(`Доверие к результату: ${confidenceLabels[v.confidence] ?? v.confidence}. ${v.confidenceReasons.map(noteText).join(' ')}`, v.confidence === 'high' ? 'success' : 'warning'),
    ...(record.failureModes?.length ? [line('Типы провалов:', 'accent'),
      ...record.failureModes.flatMap(mode => [
        line(`• ${mode.name}${mode.stage ? ` [${mode.stage}]` : ''} — ${mode.trialIds.length} диалог(ов)`, 'warning'),
        line(`  ${mode.description}`, 'muted'),
      ])] : []),
    line('Что дальше:', 'accent'), ...v.nextSteps.map(step => line(`• ${noteText(step)}`)),
  ];
}
function verdictHeadline(record: Experiment): string {
  const v = verdictSummary(record);
  return `Итог: пройдено ${v.passed} из ${v.graded} (${Math.round((v.passRate ?? 0) * 100)}%) · доверие ${confidenceLabels[v.confidence] ?? v.confidence} · 1 подробнее`;
}

/** Everything here is an observation over the record; the wording says so before any number. */
function statsLines(record: Experiment): Line[] {
  const e = evidenceSummary(record);
  const pct = (v: number | null) => v === null ? 'нет данных' : `${Math.round(v * 100)}%`;
  const num = (v: number | null, digits = 2) => v === null ? 'нет данных' : v.toFixed(digits);
  const rows: Line[] = [line('СТАТИСТИКА · наблюдения, не доказательства', 'accent', true), line('')];
  if (e.comparison) rows.push(line('Наблюдаемый результат сравнения', 'accent'), line(e.comparison.observed), line(e.comparison.status, 'muted'), line(''));
  rows.push(line('Режимы пользователя', 'accent'));
  for (const m of e.modes) {
    rows.push(line(`${m.userMode}: ${m.passed}/${m.valid} пройдено (${pct(m.passRate)}) · диалогов ${m.trials} · реплик пользователя ${num(m.avgUserTurns, 1)} · вызовов ${m.calls} · стоимость ${m.costUsd === null ? 'неизвестна' : `$${m.costUsd.toFixed(4)}`}`));
    if (m.uniqueFailedChecks.length) rows.push(line(`  провалы, найденные только в этом режиме: ${m.uniqueFailedChecks.join(', ')}`, 'warning'));
  }
  rows.push(line(''), line('Калибровка судьи · человек против модели, положительный класс = ошибка', 'accent'));
  if (!e.calibration.length) rows.push(line('Метрик и проверок нет.', 'muted'));
  for (const c of e.calibration) {
    rows.push(line(`${c.key} [${c.subject}]: n=${c.n} · TPR ${pct(c.tpr)} · TNR ${pct(c.tnr)} · согласие ${pct(c.agreement)}${c.n && !c.sufficient ? ' · недостаточно данных (n<60)' : ''}`, c.n ? (c.sufficient ? 'text' : 'warning') : 'muted'));
  }
  rows.push(line(''), line('Верность симулятора · реактивные диалоги против реальных', 'accent'));
  if (!e.fidelity) rows.push(line('Реальные диалоги не загружены; верность оценить нельзя.', 'muted'));
  else {
    rows.push(line(`Реальные диалоги: ${e.fidelity.realDialogues} · реактивные симуляции: ${e.fidelity.simulatedDialogues}`, 'muted'));
    const names: Record<string, string> = { userTurns: 'реплик пользователя на диалог', userMessageLength: 'длина реплики, символов', questionRate: 'доля реплик с вопросом', disengagementRate: 'доля ушедших пользователей' };
    for (const m of e.fidelity.metrics) rows.push(line(`${names[m.metric] ?? m.metric}: реальные ${num(m.real)} · симуляция ${num(m.simulated)} · разрыв ${m.gap === null ? 'нет данных' : `${m.gap >= 0 ? '+' : ''}${m.gap.toFixed(2)}`}`));
    rows.push(line(`Человеческие вердикты о верности симулятора: ${e.fidelity.humanFidelity.passed} из ${e.fidelity.humanFidelity.reviewed} пройдено`));
  }
  rows.push(line(''), line('Ограничения доказательств', 'accent'), ...(e.notes.length ? e.notes.map(n => line(`• ${n}`, 'warning')) : [line('Нет.', 'muted')]));
  return rows;
}

/** A single native Pi component: immutable snapshots in, explicit human intentions out. */
export class LabBoard implements Component {
  private record?: Experiment;
  private section: Section;
  private selected: number;
  private scroll = 0;
  private maxScroll = 0;
  private expanded = false;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private loading = false;
  private loadError = '';

  constructor(private options: BoardOptions, private theme: BoardTheme, private done: (action: BoardAction) => void,
    private redraw: () => void, private rows: () => number = () => 32) {
    this.record = options.record;
    this.section = options.section ?? (this.record?.trials.length ? 'results' : 'cards');
    this.selected = options.selected ?? 0;
    if (options.load && this.record && activePhases.has(this.record.phase)) {
      this.timer = setInterval(() => { void this.refresh(); }, 750);
    }
  }
  private async refresh() {
    if (this.loading || this.disposed) return;
    this.loading = true;
    try {
      const record = await this.options.load!();
      if (this.disposed) return;
      this.record = record;
      this.loadError = '';
      if (!activePhases.has(record.phase)) { clearInterval(this.timer); this.timer = undefined; }
      this.redraw();
    } catch (error) {
      if (!this.disposed) { this.loadError = safeText(error instanceof Error ? error.message : error); this.redraw(); }
    }
    finally { this.loading = false; }
  }
  dispose() { this.disposed = true; clearInterval(this.timer); }
  invalidate() {}
  private finish(action: BoardAction) { this.dispose(); this.done(action); }
  private items() {
    if (!this.record) return (this.options.records ?? []).map(r => `${phases[r.phase] ?? r.phase} · ${r.task}`);
    if (this.section === 'results') {
      const pending = awaitingVerdict(this.record);
      return reviewOrder(this.record).map(t => `${pending.has(t.id) ? '● ' : ''}${verdicts[t.outcome]}${this.record!.workflow !== 'evaluate' ? ` · v${t.revisionId.slice(0, 8)}` : ''} · ${this.record!.scenarios.find(s => s.id === t.scenarioId)?.title ?? t.scenarioId} · #${t.repeat + 1}`);
    }
    if (this.section === 'cards') return this.record.scenarios.map(s => s.title);
    return [];
  }
  handleInput(data: string) {
    if (this.disposed) return;
    const key = (value: Parameters<typeof matchesKey>[1]) => matchesKey(data, value);
    if (key('q') || key('ctrl+c')) return this.finish({ type: 'close' });
    if (key('escape')) return this.finish({ type: this.record ? 'back' : 'close' });
    if (this.record) {
      const section = key('1') ? 'agent' : key('2') ? 'cards' : key('3') ? 'results' : key('4') ? 'stats' : undefined;
      if (section) { this.section = section; this.selected = 0; this.scroll = 0; }
      const editable = this.record.workflow === 'evaluate' && this.record.phase === 'review';
      const reviewable = this.record.workflow === 'evaluate' && this.section === 'results'
        && ['results_review', 'complete'].includes(this.record.phase) && this.record.trials.length > 0;
      // One key, one verdict on the whole dialogue: the common case must not cost three screens.
      if (reviewable && (key('p') || key('n'))) {
        return this.finish({ type: 'verdict', verdict: key('p') ? 'pass' : 'fail', record: this.record, section: this.section, selected: this.selected });
      }
      const type = key('e') && editable ? 'edit'
        : key('s') && editable ? 'settings'
        : key('r') && editable && !this.record.questions.length ? 'run'
        : key('v') && reviewable ? 'annotate'
        : key('f') && this.record.phase === 'results_review' ? 'finalize'
        : key('x') ? 'export'
        : key('c') && activePhases.has(this.record.phase) ? 'cancel' : undefined;
      if (type) return this.finish({ type, record: this.record, section: this.section, selected: this.selected });
    }
    const items = this.items();
    if (key('down') || key('j')) { this.selected = Math.min(items.length - 1, this.selected + 1); this.scroll = 0; }
    if (key('up') || key('k')) { this.selected = Math.max(0, this.selected - 1); this.scroll = 0; }
    if (key('pageDown') || key('right')) this.scroll = Math.min(this.maxScroll, this.scroll + Math.max(1, this.rows() - 16));
    if (key('pageUp') || key('left')) this.scroll = Math.max(0, this.scroll - Math.max(1, this.rows() - 16));
    if (key('home')) this.scroll = 0;
    if (key('end')) this.scroll = this.maxScroll;
    if (key('enter')) {
      if (!this.record && this.options.records?.[this.selected]) return this.finish({ type: 'open', id: this.options.records[this.selected]!.id });
      this.expanded = !this.expanded;
    }
    this.redraw();
  }
  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const height = Math.max(4, this.rows());
    const inner = Math.max(1, width - 4);
    const paint = (row: Line) => {
      let value = row.text;
      if (row.bold) value = this.theme.bold(value);
      return row.color ? this.theme.fg(row.color, value) : value;
    };
    const frame = (content: string) => width < 6 ? truncateToWidth(content, width, '…')
      : `${this.theme.fg('borderMuted', '│')} ${truncateToWidth(content, inner, '…', true)} ${this.theme.fg('borderMuted', '│')}`;
    const header = [line('AGENT LAB  /  лаборатория диалогов', 'accent', true)];
    const record = this.record;
    if (record) {
      header.push(line(`${phases[record.phase] ?? record.phase} · ${record.mode === 'demo' ? 'СЦЕНАРНЫЙ ДЕМО' : 'LIVE'} · ${record.id}`, activePhases.has(record.phase) ? 'accent' : 'warning'));
      header.push(line([['agent', '1 Агент'], ['cards', `2 Карточки (${record.scenarios.length})`], ['results', `3 Диалоги (${record.trials.length})`], ['stats', '4 Статистика']]
        .map(([id, label]) => this.section === id ? `[${label}]` : label).join('   '), 'muted'));
      if (this.section === 'results' && record.trials.length) {
        const pending = awaitingVerdict(record).size;
        const failures = record.trials.filter(t => t.outcome === 'fail').length;
        header.push(line(pending
          ? `Разбор: осталось ${pending} провал(ов) из ${failures}. Отмечены точкой.`
          : failures ? `Разбор: все ${failures} провал(ов) разобраны.` : 'Разбор: провалов нет.', pending ? 'warning' : 'success'));
      }
      header.push(line(`${record.trials.some(t => t.outcome === 'pass' || t.outcome === 'fail') && !activePhases.has(record.phase) ? verdictHeadline(record) : record.message}${this.loadError ? ` · ${this.loadError}` : ''}`));
    } else header.push(line('Выберите эксперимент. Новую задачу и материалы дайте Pi в разговоре.', 'muted'));
    const items = this.items();
    this.selected = Math.max(0, Math.min(this.selected, items.length - 1));
    const visibleItems = Math.max(1, Math.min(4, Math.floor(height / 5)));
    const from = Math.max(0, Math.min(this.selected - Math.floor(visibleItems / 2), items.length - visibleItems));
    if (items.length) for (let i = from; i < Math.min(items.length, from + visibleItems); i++) {
      header.push(line(`${i === this.selected ? '▸' : ' '} ${String(i + 1).padStart(2, '0')}  ${items[i]}`, i === this.selected ? 'accent' : 'muted', i === this.selected));
    }
    if (items.length > visibleItems) header.push(line(`${this.selected + 1} / ${items.length} · ↑↓ выбор`, 'dim'));
    let detail: Line[] = [];
    if (!record) {
      const chosen = this.options.records?.[this.selected];
      detail = chosen ? [line(chosen.task, 'text', true), line(`Создан: ${chosen.createdAt}`, 'muted'), line(chosen.message)]
        : [line('Пока нет экспериментов.', 'text', true), line('Попросите Pi подготовить агента и тестовые карточки по задаче и материалам.'), line('Можно начать со сценарного демо без вызовов модели.')];
    } else if (this.section === 'cards') {
      const scenario = record.scenarios[this.selected];
      detail = scenario ? scenarioLines(scenario, record, this.expanded) : [line('Карточки появятся после подготовки.', 'muted')];
    } else if (this.section === 'results') {
      const trial = reviewOrder(record)[this.selected];
      detail = trial ? trialLines(trial, record, this.expanded) : [line('Диалогов ещё нет.', 'text', true), line('Сначала проверьте карточки, агента и лимиты. Затем нажмите r для запуска.')];
    } else if (this.section === 'stats') {
      detail = statsLines(record);
    } else {
      const agent = record.revisions.find(r => r.id === record.selectedRevisionId)?.spec;
      detail = [...(record.trials.length ? [...verdictLines(record), line('')] : []), line(record.task, 'text', true),
        ...(record.questions.length ? [line('ТРЕБУЮТСЯ УТОЧНЕНИЯ', 'warning'), ...record.questions.map(q => line(`• ${q}`)), line('Уточните материалы и подготовьте новый эксперимент.')] : []),
        line(''), line('АГЕНТ', 'accent'), line(agent?.name ?? 'Подготавливается'), line(agent?.instructions ?? ''),
        line(`Инструменты: ${agent?.tools.join(', ') || 'нет'}`, 'muted'),
        line(''), line('ЛИМИТЫ ЗАПУСКА', 'accent'), line(json(record.settings)),
        line(''), line('ПРОВЕРКА ЧЕЛОВЕКОМ', 'accent'),
        line(`Карточки: ${record.reviewedAt ? record.reviewMode === 'human' ? 'подтверждены человеком' : 'автоматическая проверка' : 'ожидают проверки'}`),
        line(`Диалоги с заметкой: ${new Set(record.humanReviews?.map(r => r.trialId)).size} / ${record.trials.length}`),
        line(`Итог: ${record.resultsReviewedAt ? 'проверен человеком' : 'ещё не проверен'}`),
        line(`${record.usage.calls} ${record.mode === 'demo' ? 'сценарных' : 'модельных'} вызовов · стоимость ${record.usage.costUsd === null ? 'неизвестна' : `$${record.usage.costUsd.toFixed(4)}`}`, 'muted'),
        line(''), line('ОСНОВАНИЯ', 'accent'),
        ...record.requirements.flatMap(r => [line(`${r.id} · ${r.text}`, 'text', true), line(`${record.sources.find(s => s.id === r.sourceId)?.name ?? r.sourceId}: «${r.quote}»`, 'muted')]),
        ...(this.expanded ? record.sources.flatMap(s => [line(''), line(s.name, 'accent'), line(s.content)]) : []),
        line(''), ...record.limitations.map(v => line(`• ${v}`, 'muted')),
        ...(record.error ? [line(record.error, 'error')] : []),
      ];
    }
    const content = detail.flatMap(row => wrapTextWithAnsi(row.text, inner).map(text => paint({ ...row, text })));
    const footer = record ? [
      record.workflow !== 'evaluate' ? 'Сравнительный эксперимент · только просмотр и экспорт'
        : record.phase === 'review' ? `e Править · s Лимиты · ${record.questions.length ? 'Запуск: нужны уточнения' : 'r Проверить и запустить'}`
        : activePhases.has(record.phase) ? 'c Остановить · обновляется автоматически'
        : record.phase === 'results_review' ? 'p Пройдено · n Не пройдено · v Подробный вердикт · f Завершить аудит'
        : record.phase === 'complete' ? 'p Пройдено · n Не пройдено · v Подробный вердикт · результат сохранён' : 'Результат сохранён',
      inner < 80 ? '↑↓ Выбор · ←→ Текст · Enter Детали · x Экспорт · Esc Назад'
        : `↑↓ Выбор · PgUp/PgDn Текст · Enter ${this.expanded ? 'Свернуть' : 'Подробнее'} · x Экспорт · Esc Назад`,
    ] : ['↑↓ Выбор · Enter Открыть · Esc Закрыть'];
    const available = Math.max(1, height - header.length - footer.length - 3);
    this.maxScroll = Math.max(0, content.length - available);
    this.scroll = Math.min(this.scroll, this.maxScroll);
    const border = (left: string, right: string) => this.theme.fg('borderMuted', width < 2 ? '─' : left + '─'.repeat(width - 2) + right);
    const rows = [border('╭', '╮'), ...header.map(r => frame(paint(r))), frame(this.theme.fg('borderMuted', '─'.repeat(inner))),
      ...content.slice(this.scroll, this.scroll + available).map(frame),
      ...footer.map((text, i) => frame(this.theme.fg(i ? 'dim' : 'accent', text))), border('╰', '╯')];
    // Even very small terminals remain valid; Pi requires each rendered line to fit.
    return rows.slice(0, height).map(row => visibleWidth(row) > width ? truncateToWidth(row, width, '…') : row);
  }
}

export function showBoard(ctx: ExtensionContext, options: BoardOptions): Promise<BoardAction> {
  return ctx.ui.custom<BoardAction>((tui, theme, _keys, done) =>
    new LabBoard(options, theme, done, () => tui.requestRender(), () => tui.terminal.rows),
  { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 } });
}
