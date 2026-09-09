import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
import { LabBoard, safeText, type BoardAction } from '../extensions/cards.ts';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { emptyUsage, fingerprint, type Experiment } from '../src/contracts.js';

const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };
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
  const board = new LabBoard({ record }, theme, () => {}, () => {}, () => 120);
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
  record.phase = 'complete'; record.resultsReviewedAt = record.updatedAt; record.humanReviews = [];
  const reviewed = new LabBoard({ record }, theme, () => {}, () => {}, () => 120);
  assert.match(reviewed.render(120).join('\n'), /Набор проверен человеком.*отдельной заметки нет/);
  reviewed.dispose();
});

test('live polling stops on dispose and never applies a late response to a closed board', async () => {
  const record = await fixture();
  record.phase = 'evaluating';
  let loads = 0;
  let renders = 0;
  let resolveLoad!: (value: Experiment) => void;
  const board = new LabBoard({ record, load: () => { loads++; return new Promise(resolve => { resolveLoad = resolve; }); } }, theme, () => {}, () => { renders++; });
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(loads, 1);
  board.dispose();
  resolveLoad({ ...record, phase: 'results_review' });
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
  const text = stripTerminalSequences(board.render(120).join('\n'));
  assert.match(text, /4 Статистика/);
  assert.match(text, /static/); assert.match(text, /reactive/);
  assert.match(text, /No human verdicts/);
  assert.match(text, /Реальные диалоги: 1/);
  assert.match(text, /Калибровка судьи/);
  board.dispose();
  const other = new LabBoard({ record }, theme, () => {}, () => {}, () => 40);
  other.handleInput('4');
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
  assert.match(text, /Пройдено 2 из 3/);
  assert.match(text, /Доверие к результату: низкое/);
  assert.match(text, /синтетических 2/);
  assert.match(text, /Время изменено/);
  assert.match(text, /Что дальше/);
  assert.doesNotMatch(text, /TPR/);
  for (const width of [16, 40, 80]) for (const line of board.render(width)) assert.ok(visibleWidth(line) <= width, `overflow at ${width}`);
  board.dispose();
  const results = new LabBoard({ record }, theme, () => {}, () => {}, () => 40);
  assert.match(stripTerminalSequences(results.render(120).join('\n')), /Итог: пройдено 2 из 3/);
  results.dispose();
});
