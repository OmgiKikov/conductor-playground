// Opt-in model regression: node --import tsx test/live/simulator-stop.ts PROVIDER MODEL
// Twelve model calls. No target-agent calls and no business-policy verdicts.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPiRuntime } from '../../src/pi.js';
import { emptyUsage, settingsSchema, simulatorFidelity, type CallContext, type Scenario, type TraceEvent, type Trial } from '../../src/contracts.js';

const [provider, model] = process.argv.slice(2);
assert(provider && model, 'Usage: node --import tsx test/live/simulator-stop.ts PROVIDER MODEL');
const sample = JSON.parse(await readFile(new URL('./aigw-stop.json', import.meta.url), 'utf8')) as {
  user: Scenario['user']; events: TraceEvent[]; sourceTrialId: string;
};
const settings = settingsSchema.parse({ provider, model, maxCalls: 12, timeoutMs: 120000 });
const runtime = await createPiRuntime(settings);
const usage = emptyUsage();
const ctx: CallContext = {
  signal: AbortSignal.timeout(900000), timeoutMs: settings.timeoutMs,
  beforeCall() { assert(usage.calls < 12, 'Model call budget exhausted'); usage.calls++; },
  addUsage(value) { usage.inputTokens += value.inputTokens; usage.outputTokens += value.outputTokens; usage.costUsd = null; },
};
const cases = [
  { name: 'instruction already sufficient', user: sample.user, reply: sample.events[1]!.text!, expect: '' },
  { name: 'necessary clarification', user: sample.user, reply: 'Какой номер вашего терминала?', expect: '87654321' },
  { name: 'required change after first success',
    user: { goal: 'Перенести запись', facts: 'Номер записи A. Сначала хочу 10:00, затем передумаю и попрошу 11:00.',
      behavior: 'После первого подтверждения обязательно один раз попросить перенести на 11:00. Затем закончить.',
      opening: 'Перенесите запись A на 10:00.', maxFollowUps: 1 },
    reply: 'Запись A перенесена на 10:00.', expect: '11:00' },
  { name: 'stop on refusal', user: { ...sample.user, behavior: 'Если агент отказывает, закончить без дальнейших реплик, в том числе благодарности.' },
    reply: 'Я не могу помочь с разблокировкой терминала.', expect: '' },
];
const results: unknown[] = [];
for (let repeat = 0; repeat < 2; repeat++) {
  for (const c of cases) {
    const answer = await runtime.userTurn({ user: c.user,
      messages: [{ role: 'user', content: c.user.opening }, { role: 'assistant', content: c.reply }], turn: 0 }, ctx);
    results.push({ name: c.name, repeat, answer });
    console.log(JSON.stringify(results.at(-1)));
    if (c.expect) assert(answer.message.includes(c.expect), `${c.name}: necessary follow-up missing`);
    else assert(answer.done && !answer.message.trim(), `${c.name}: simulator should stop without another target call`);
  }
  const world = { records: {}, writableFields: [], transientFailures: 0 };
  const scenario: Scenario = { id: 'stop', familyId: 'stop', title: 'Simulator stopping rule',
    provenance: 'synthetic', requirementIds: [], user: sample.user, split: 'dev',
    initialState: world, checks: [], metrics: [simulatorFidelity] };
  for (const [expected, events] of [
    ['fail', sample.events],
    ['pass', [...sample.events.slice(0, 2), { seq: 6, type: 'simulator', result: { message: '', done: true } }]],
  ] as const) {
    const trial: Trial = { id: 'stop_trial', scenarioId: scenario.id, familyId: scenario.familyId, revisionId: 'r',
      userMode: 'reactive', repeat, split: 'dev', manifestHash: 'probe', outcome: 'ungraded', reason: '', checks: [],
      events: [...events], initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 0 };
    const assessments = await runtime.assess!({ scenario, trial, sources: [] }, ctx);
    results.push({ name: `judge stopping ${expected}`, repeat, assessments });
    console.log(JSON.stringify(results.at(-1)));
    assert.equal(assessments[0]?.result, expected);
    assert(assessments[0]!.evidence.length > 0);
    assert(assessments[0]!.evidence.every(seq => events.some(e => e.seq === seq)));
  }
}
console.log(JSON.stringify({ passed: results.length, usage, provider, model, sourceTrialId: sample.sourceTrialId }));
