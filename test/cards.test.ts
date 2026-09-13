import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
import { LabBoard, reviewOrder, safeText, type BoardAction, type BoardOptions } from '../extensions/cards.ts';
import { htmlReport } from '../src/report.js';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { emptyUsage, fingerprint, type Experiment } from '../src/contracts.js';
import { compareRuns } from '../src/comparison.js';
import { evidenceBundle } from '../src/artifacts.js';
import { markdownReport } from '../src/report.js';

const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };

test('coincident replies with different scores are visible in Pi and exported reports', async () => {
  const before = await fixture();
  before.id = 'before'; before.phase = 'results_review';
  before.settings.userModes = ['reactive']; before.settings.repeats = 1;
  before.scenarios = [before.scenarios[0]!];
  const card = before.scenarios[0]!;
  card.checks = [];
  card.metrics = [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'd', passCriteria: 'p', failCriteria: 'f' }];
  before.trials = [{ id: 'before_trial', revisionId: 'revision-1', scenarioId: card.id, familyId: card.familyId,
    repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'hash', outcome: 'ungraded', reason: '', checks: [],
    events: [{ seq: 0, type: 'assistant', text: 'The same instruction.' }], initialState: card.initialState, finalState: card.initialState,
    elapsedMs: 1, usage: emptyUsage(), assessments: [{ metricId: 'goal', result: 'fail', rationale: 'r', evidence: [0] }] }];
  const after = structuredClone(before); after.id = 'after'; after.parentRunId = before.id;
  after.trials[0]!.id = 'after_trial'; after.trials[0]!.assessments![0]!.result = 'pass';
  const bundle = await evidenceBundle(after, { get: async () => before, traceJournal: async () => '' });
  const board = new LabBoard({ record: after, before, comparison: bundle.comparison, section: 'comparison' }, theme, () => {}, () => {}, () => 40);
  try {
    for (const text of [board.render(120).join('\n'), htmlReport(bundle), markdownReport(bundle)]) {
      assert.match(text, /Общих оценённых карточек нет/);
      assert.match(text, /Ответы агента совпали/);
      assert.doesNotMatch(text, /Исправлено 1/);
    }
  } finally { board.dispose(); }
});

async function fixture(): Promise<Experiment> {
  const input = demoInput();
  const sources = input.materials.map((m, i) => ({ ...m, id: `source-${i + 1}`, hash: fingerprint(m.content) }));
  const prepared = await createDemoRuntime().prepare({ task: input.task, sources, workflow: 'evaluate', scenarioCount: 2 }, {
    signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {},
  });
  return {
    schemaVersion: '1', id: 'cards-test', task: input.task, mode: 'demo', workflow: 'evaluate',
    createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', phase: 'review', message: 'Карточки готовы.',
    sources, settings: input.settings, requirements: prepared.requirements, questions: [],
    scenarios: prepared.scenarios.map(s => ({ ...s, split: 'dev' })),
    revisions: [{ id: 'revision-1', spec: prepared.agent, parentId: null, hypothesis: '', createdAt: '2026-09-08' }],
    selectedRevisionId: 'revision-1', manifestHash: null, reviewedAt: null, reviewMode: null, controlConsumedAt: null,
    trials: [], comparisons: [], iterations: [], usage: emptyUsage(), error: null, limitations: [], humanReviews: [], target: { kind: 'sandbox' }, goldenCases: [], dialogues: [], profiles: [],
  };
}

test('80×24 shows the opening and first reply before metadata, with visible feedback and scroll position', async () => {
  const record = await fixture();
  const scenario = record.scenarios[0]!;
  scenario.title = 'Перенос записи'; scenario.user.opening = 'Перенесите запись на 14:00.';
  scenario.user.goal = 'Изменить время записи'; scenario.successCriteria = 'Время изменилось на 14:00.';
  const cards = new LabBoard({ record, notice: { kind: 'info', message: 'Изменена 1 карточка, остальные сохранены.' } }, theme, () => {}, () => {}, () => 24);
  const cardText = cards.render(80).join('\n');
  assert.match(cardText, /Перенесите запись на 14:00/);
  assert.match(cardText, /Изменена 1 карточка/);
  cards.dispose();
  record.phase = 'results_review';
  record.trials = [{ id: 'readable', revisionId: 'revision-1', scenarioId: scenario.id, familyId: scenario.familyId,
    repeat: 0, userMode: 'static', split: 'dev', manifestHash: 'hash', outcome: 'ungraded', reason: 'Оценено по рубрикам.',
    checks: [], events: [{ seq: 0, type: 'user', text: scenario.user.opening }, { seq: 1, type: 'assistant', text: 'Запись перенесена на 14:00.' }],
    initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 20 }];
  const results = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 24);
  const text = results.render(80).join('\n');
  assert.match(text, /Перенесите запись на 14:00/);
  assert.match(text, /Запись перенесена на 14:00/);
  assert.match(text, /ПО РУБРИКАМ/);
  assert.match(text, /\d+–\d+\/\d+/);
  results.dispose();
  record.phase = 'evaluating'; record.trials = []; record.message = 'Карточка 1/2: ждём ответ агента';
  const running = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 24);
  assert.match(running.render(80).join('\n'), /ДИАЛОГ ВЫПОЛНЯЕТСЯ/);
  assert.doesNotMatch(running.render(80).join('\n'), /Затем нажмите r|r для запуска/);
  running.dispose();
});

test('comparison refreshes with a finished repeat, so 5 opens current paired evidence immediately', async t => {
  const before = await fixture();
  before.id = 'before'; before.phase = 'results_review'; before.reviewedAt = before.createdAt;
  before.settings.repeats = 2;
  before.scenarios.forEach(s => { s.metrics = []; });
  before.trials = before.scenarios.flatMap((s, i) => [0, 1].map(repeat => ({
    id: `before-${i}-${repeat}`, revisionId: 'revision-1', scenarioId: s.id, familyId: s.familyId, repeat,
    userMode: 'reactive', split: 'dev', manifestHash: 'hash', outcome: i || repeat ? 'pass' : 'fail', reason: '',
    checks: s.checks.map((c, j) => ({ id: c.id, description: c.description, evidence: 'fixture', passed: i > 0 || repeat > 0 || j > 0 })),
    events: [{ seq: 0, type: 'assistant', text: 'Раньше не мог изменить запись.' }], initialState: s.initialState, finalState: s.initialState,
    elapsedMs: 1, usage: emptyUsage(),
  })));
  const after = structuredClone(before); after.id = 'after'; after.parentRunId = before.id;
  for (const trial of after.trials) {
    trial.id = trial.id.replace('before', 'after'); trial.outcome = 'pass';
    trial.checks.forEach(c => { c.passed = true; });
    trial.events[0]!.text = 'Теперь запись изменена.';
  }
  const running = { ...after, phase: 'evaluating' as const, trials: [] };
  let rendered!: () => void;
  const refreshed = new Promise<void>(resolve => { rendered = resolve; });
  const actions: BoardAction[] = [];
  const board = new LabBoard({ record: running, before, comparison: compareRuns(before, running),
    warnings: ['Прогон ещё идёт.'], reportPath: '/fixture/partial.html', notice: { kind: 'info', message: 'Промежуточный отчёт сохранён.' },
    load: async () => ({ record: after, before, comparison: compareRuns(before, after), warnings: [] }) }, theme, a => actions.push(a), rendered, () => 40);
  let timer: ReturnType<typeof setTimeout>;
  t.after(() => { clearTimeout(timer); board.dispose(); });
  await Promise.race([refreshed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('board did not refresh')), 3000); })]);
  board.handleInput('5');
  const text = board.render(120).join('\n');
  assert.match(text, /Исправлено 1, сломалось 0/);
  assert.match(text, /Раньше не мог изменить запись/);
  assert.match(text, /Теперь запись изменена/);
  const list = text.split('\n').map(line => line.split('│')[1] ?? '');
  assert.equal(list.filter(line => line.includes('+ ')).length, 1, 'only the changed attempt gets a plus; its unchanged repeat must not');
  assert.doesNotMatch(text, /Прогон ещё идёт|Промежуточный отчёт|o Открыть отчёт/);
  board.handleInput('o');
  assert.deepEqual(actions, []);
});

test('native cards sanitize terminal escapes, preserve readable Unicode, and fit narrow or wide terminals', async () => {
  const record = await fixture();
  record.scenarios[0]!.title = '\x1b]52;c;malicious\x07\x1b[2JПерсона 👩🏽‍💻 中文 e\u0301 ' + 'длинный'.repeat(80);
  record.scenarios[0]!.user.persona = '\u202eРазворот\u2066\x00\x9bПолезный текст';
  const board = new LabBoard({ record }, theme, () => {}, () => {}, () => 36);
  for (const width of [1, 2, 5, 16, 40, 80, 132]) {
    const lines = board.render(width);
    assert.ok(lines.length <= 36);
    for (const value of lines) {
      assert.ok(visibleWidth(value) <= width, `overflow ${width}: ${value}`);
      assert.doesNotMatch(stripTerminalSequences(value), /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
      assert.doesNotMatch(value, /\x1b\]|\x1b\[2J/);
    }
  }
  assert.match(board.render(100).join('\n'), /Персона|ПОЛЬЗОВАТЕЛЬ/);
  assert.equal(safeText('\x1b]8;;https://invalid\x1b\\текст\x1b]8;;\x1b\\\n👩🏽‍💻'), 'текст\n👩🏽‍💻');
  board.dispose();
});

test('keyboard navigation exposes complete card details and only phase-appropriate human actions', async () => {
  const record = await fixture();
  const actions: BoardAction[] = [];
  const board = new LabBoard({ record }, theme, a => actions.push(a), () => {}, () => 28);
  board.handleInput('\r'); // Expand full source grounding and state.
  board.render(90);
  board.handleInput('\x1b[F'); // End, no content silently discarded.
  assert.match(board.render(90).join('\n'), /ТОЧНЫЕ ПРОВЕРКИ|state_equals|tool_called|answer_contains/);
  board.handleInput('r');
  assert.equal(actions[0]?.type, 'run');
  assert.equal(actions.length, 1);
  board.handleInput('r');
  assert.equal(actions.length, 1, 'disposed board cannot submit consent twice');

  for (const r of [{ ...record, workflow: 'compare' as const }, { ...record, questions: ['Уточнить правило'] }, { ...record, phase: 'complete' as const }]) {
    const forbidden: BoardAction[] = [];
    const blocked = new LabBoard({ record: r }, theme, a => forbidden.push(a), () => {});
    blocked.handleInput('r');
    assert.equal(forbidden.length, 0);
    blocked.dispose();
  }
});

test('result cards keep model grades, missing grades, traces and human annotations distinct', async () => {
  const record = await fixture();
  record.phase = 'results_review';
  const scenario = record.scenarios[0]!;
  scenario.metrics = [{ id: 'm1', name: 'Точность', subject: 'agent', description: 'Точность ответа', passCriteria: 'Верно', failCriteria: 'Ошибка' }, { id: 'm2', name: 'Реалистичность', subject: 'simulator', description: 'Естественность', passCriteria: 'Уместно', failCriteria: 'Невозможно' }];
  record.trials = [{ id: 'trial1', revisionId: 'revision-1', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, split: 'dev', manifestHash: 'hash', outcome: 'pass', reason: 'Objective pass only',
    checks: [], events: [{ seq: 0, type: 'user', text: 'Реплика пользователя' }, { seq: 1, type: 'assistant', text: 'Ответ агента' }], initialState: scenario.initialState, finalState: scenario.initialState, usage: { ...emptyUsage(), costUsd: null }, elapsedMs: 12,
    assessments: [{ metricId: 'm1', result: 'unknown', rationale: 'Недостаточно данных', evidence: [1] }] }];
  record.humanReviews = [{ id: 'h1', trialId: 'trial1', verdict: 'fail', note: 'Ошибка в реплике #1', createdAt: record.createdAt }];
  const board = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 120);
  const text = stripTerminalSequences(board.render(120).join('\n'));
  assert.match(text, /Агент · Точность: НЕЯСНО/);
  assert.match(text, /Симулятор · Реалистичность: НЕТ ОЦЕНКИ/);
  assert.match(text, /стоимость неизвестна/);
  assert.match(text, /ОТДЕЛЬНАЯ ПРОВЕРКА ЧЕЛОВЕКОМ/);
  assert.match(text, /СЦЕНАРНАЯ ОЦЕНКА ДЕМО/);
  assert.doesNotMatch(text, /ОЦЕНКА МОДЕЛЬЮ/);
  assert.match(text, /Ошибка в реплике #1/);
  assert.match(text, /#1  АГЕНТ/);
  assert.match(text, /Ответ агента/);
  board.dispose();
  scenario.checks = []; record.trials[0]!.outcome = 'ungraded';
  record.trials[0]!.assessments = [
    { metricId: 'm2', result: 'fail', rationale: 'SIMULATOR_FAILURE_SENTINEL', evidence: [0] },
    { metricId: 'm1', result: 'fail', rationale: 'AGENT_FAILURE_SENTINEL', evidence: [1] },
  ];
  const overview = new LabBoard({ record }, theme, () => {}, () => {}, () => 120);
  const overviewText = overview.render(120).join('\n');
  assert.match(overviewText, /AGENT_FAILURE_SENTINEL/); assert.doesNotMatch(overviewText, /SIMULATOR_FAILURE_SENTINEL/);
  assert.match(overviewText, /реплики #1/); overview.dispose();
  assert.match(htmlReport(record), /Оценено моделью · предварительно<\/h3><strong>0<span class="muted"> \/ 1/);
  record.phase = 'complete'; record.resultsReviewedAt = record.updatedAt; record.humanReviews = [];
  const reviewed = new LabBoard({ record, section: 'results' }, theme, () => {}, () => {}, () => 120);
  assert.match(reviewed.render(120).join('\n'), /Вердикта человека нет/);
  assert.doesNotMatch(reviewed.render(120).join('\n'), /Набор проверен человеком|Разбор набора завершён/);
  reviewed.dispose();
});

test('разбор начинается с провалов без вердикта, счётчик их считает, вердикт ставится одной клавишей', async () => {
  const record = await fixture();
  record.phase = 'results_review';
  const scenario = record.scenarios[0]!;
  const trial = (id: string, outcome: 'pass' | 'fail') => ({
    id, revisionId: 'revision-1', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, split: 'dev' as const,
    manifestHash: 'hash', outcome, reason: outcome === 'pass' ? 'Все объективные проверки пройдены.' : 'Часть объективных проверок провалена.',
    checks: [{ id: 'time', description: 'Запись переставлена', passed: outcome === 'pass', evidence: 'e' }],
    events: [], initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1,
  });
  // Порядок в записи нарочно неудобный: пройденный первым, неразобранный провал последним.
  record.trials = [trial('t_pass', 'pass'), trial('t_done', 'fail'), trial('t_pending', 'fail')];
  record.humanReviews = [{ id: 'h1', trialId: 't_done', verdict: 'fail', note: 'разобрано', createdAt: record.createdAt }];

  const actions: BoardAction[] = [];
  const board = new LabBoard({ record, section: 'results' }, theme, a => actions.push(a), () => {}, () => 40);
  const text = stripTerminalSequences(board.render(120).join('\n'));
  assert.match(text, /Разбор: осталось 1 провал\(ов\) из 2/);
  assert.match(text, /Запись переставлена/, 'первым открыт тот диалог, который ждёт человека');

  board.handleInput('p');
  const verdict = actions[0];
  assert.equal(verdict?.type, 'verdict');
  assert.equal(verdict.type === 'verdict' && verdict.verdict, 'pass');
  assert.equal(verdict.type === 'verdict' && reviewOrder(record)[verdict.selected]?.id, 't_pending');
  board.dispose();

  const failing: BoardAction[] = [];
  const second = new LabBoard({ record, section: 'results' }, theme, a => failing.push(a), () => {}, () => 40);
  second.handleInput('n');
  assert.equal(failing[0]?.type === 'verdict' && failing[0].verdict, 'fail');
  second.dispose();

  // Пока диалоги идут, вердикт ставить не по чему.
  const running: BoardAction[] = [];
  const active = new LabBoard({ record: { ...record, phase: 'evaluating' }, section: 'results' }, theme, a => running.push(a), () => {}, () => 40);
  active.handleInput('p');
  assert.deepEqual(running, []);
  active.dispose();

  const reviewed = { ...record, humanReviews: [...record.humanReviews, { id: 'h2', trialId: 't_pending', verdict: 'pass' as const, note: 'ok', createdAt: record.createdAt }] };
  assert.match(stripTerminalSequences(new LabBoard({ record: reviewed, section: 'results' }, theme, () => {}, () => {}, () => 40).render(120).join('\n')),
    /Замечания человека: 1 диалогов · расхождения оценок: 1/);
});

test('live polling stops on dispose and never applies a late response to a closed board', async () => {
  const record = await fixture();
  record.phase = 'evaluating';
  let loads = 0;
  let renders = 0;
  let resolveLoad!: (value: Awaited<ReturnType<NonNullable<BoardOptions['load']>>>) => void;
  const board = new LabBoard({ record, load: () => { loads++; return new Promise(resolve => { resolveLoad = resolve; }); } }, theme, () => {}, () => { renders++; });
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(loads, 1);
  board.dispose();
  resolveLoad({ record: { ...record, phase: 'results_review' }, warnings: [] });
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(loads, 1);
  assert.equal(renders, 0);
});

test('the statistics section renders the evidence summary in narrow and wide terminals without claiming more than the data', async () => {
  const record = await fixture();
  record.settings.userModes = ['static', 'reactive'];
  record.dialogues = [{ id: 'd1', messages: [{ role: 'user', content: 'hi?' }], outcome: 'abandoned' }];
  const board = new LabBoard({ record, section: 'stats' }, theme, () => {}, () => {}, () => 40);
  for (const width of [16, 40, 80, 132]) for (const line of board.render(width)) assert.ok(visibleWidth(line) <= width, `overflow at ${width}`);
  const firstPage = board.render(120).join('\n');
  board.handleInput('\u001b[F');
  const text = stripTerminalSequences(firstPage + '\n' + board.render(120).join('\n'));
  assert.match(text, /4 Статистика/);
  assert.match(text, /static/); assert.match(text, /reactive/);
  assert.match(text, /Вердиктов человека по метрикам и проверкам ещё нет/);
  assert.match(text, /Реальные диалоги: 1/);
  assert.match(text, /Сверка с ручными вердиктами/);
  board.dispose();
  const other = new LabBoard({ record }, theme, () => {}, () => {}, () => 40);
  other.handleInput('4');
  other.render(120);
  other.handleInput('\u001b[F');
  assert.match(stripTerminalSequences(other.render(120).join('\n')), /Верность симулятора/);
  other.dispose();
});

test('the board leads with a plain verdict once dialogues exist and keeps the research statistics one key away', async () => {
  const record = await fixture();
  record.phase = 'results_review';
  const scenario = record.scenarios[0]!;
  record.trials = [0, 1, 2].map(i => ({ id: `t${i}`, revisionId: 'revision-1', scenarioId: scenario.id, familyId: scenario.familyId, repeat: i, userMode: 'reactive' as const, split: 'dev' as const, manifestHash: 'hash',
    outcome: i === 0 ? 'fail' as const : 'pass' as const, reason: '', checks: [{ id: 'time', description: 'Время изменено', passed: i !== 0, evidence: '' }],
    events: [{ seq: 0, type: 'user' as const, text: 'hi' }, { seq: 1, type: 'assistant' as const, text: 'ok' }], initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1 }));
  const board = new LabBoard({ record, section: 'agent' }, theme, () => {}, () => {}, () => 40);
  const text = stripTerminalSequences(board.render(120).join('\n'));
  assert.match(text, /ИТОГ/);
  assert.match(text, /По кодовым проверкам пройдено 2 из 3/);
  assert.match(text, /ожидают разбора 1/);
  assert.match(text, /Время изменено/);
  assert.match(text, /Дальше/);
  assert.doesNotMatch(text, /TPR/);
  board.handleInput('4');
  assert.match(board.render(120).join('\n'), /Полнота аудита: низкая/);
  for (const width of [16, 40, 80]) for (const line of board.render(width)) assert.ok(visibleWidth(line) <= width, `overflow at ${width}`);
  board.dispose();
  const results = new LabBoard({ record }, theme, () => {}, () => {}, () => 40);
  assert.match(results.render(120).join('\n'), /ЧТО ТРЕБУЕТ ВНИМАНИЯ/);
  assert.match(stripTerminalSequences(results.render(120).join('\n')), /Итог: По кодовым проверкам пройдено 2 из 3/);
  results.dispose();
});

test('filtered review targets the visible trial ID and help cannot accidentally submit a verdict', async () => {
  const record = await fixture(); record.phase = 'results_review';
  record.trials = record.scenarios.map((s, i) => ({ id: `trial-${i}`, scenarioId: s.id, revisionId: 'r', familyId: s.familyId, repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'h', outcome: 'fail', reason: '', checks: [{ id: 'c', passed: false, evidence: '', description: 'c' }], events: [], initialState: s.initialState, finalState: s.initialState, elapsedMs: 1, usage: emptyUsage() }));
  record.scenarios[0]!.title = 'Первый'; record.scenarios[1]!.title = 'Возврат';
  const actions: BoardAction[] = [];
  const board = new LabBoard({ record, section: 'results' }, theme, a => actions.push(a), () => {}, () => 30);
  board.handleInput('?'); board.handleInput('n'); assert.equal(actions.length, 0); board.handleInput('?');
  board.handleInput('/'); board.handleInput('Возврат'); board.handleInput('\r');
  const lines = board.render(120);
  assert.ok(lines.at(-1)?.endsWith('╯'), 'footer fits the terminal');
  assert.match(lines.join('\n'), /Возврат/);
  board.handleInput('n');
  assert.equal(actions[0]?.type === 'verdict' && actions[0].trialId, 'trial-1');
  const discussion = new LabBoard({ record, section: 'cards', query: 'Возврат' }, theme, a => actions.push(a), () => {});
  discussion.handleInput('a');
  assert.equal(actions[1]?.type === 'discuss' && record.scenarios[actions[1].selected]?.id, record.scenarios[1]!.id);
  const empty = new LabBoard({ records: [] }, theme, a => actions.push(a), () => {});
  empty.handleInput('n'); assert.equal(actions[2]?.type, 'new');
});

test('HTML reports escape untrusted text and remain self-contained with explicit evidence limits', async () => {
  const record = await fixture();
  record.task = '<script>alert(1)</script> & "тест"';
  const html = htmlReport(record);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<iframe|<img|<link|<form/i);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /lang="ru"/);
  assert.match(html, /Аудит не завершён/);
  assert.match(html, /Сценарное демо/);
  record.profiles = [{ id: 'p', source: 'observed', persona: '<img src=x>', characteristics: ['Original trait'], evidenceDialogueIds: ['d1'], draftOverride: { persona: null, characteristics: ['<script>override</script>'] } }];
  record.scenarios[0]!.profileId = 'p'; delete record.scenarios[0]!.user.persona;
  const profiles = htmlReport(record);
  assert.match(profiles, /&lt;img src=x&gt;/); assert.match(profiles, /&lt;script&gt;override&lt;\/script&gt;/);
  assert.match(profiles, /Правка черновика/); assert.match(profiles, /Персона: убрана/);
  assert.doesNotMatch(profiles, /<img/i);
  record.workflow = 'compare'; record.scenarios[1]!.split = 'control'; record.scenarios[1]!.title = 'CONTROL_CARD_SENTINEL';
  assert.doesNotMatch(htmlReport(record), /CONTROL_CARD_SENTINEL/);
  record.controlConsumedAt = 'now'; record.phase = 'control';
  assert.doesNotMatch(htmlReport(record), /CONTROL_CARD_SENTINEL/);
  record.phase = 'complete'; assert.match(htmlReport(record), /CONTROL_CARD_SENTINEL/);
});
