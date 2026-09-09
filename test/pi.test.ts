import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ModelRuntime, type ProviderConfig } from '@earendil-works/pi-coding-agent';
import { createPiRuntime, getPiStatus } from '../src/pi.js';
import { emptyUsage, settingsSchema, type CallContext, type Scenario, type Tool, type Trial } from '../src/contracts.js';

type Request = Parameters<NonNullable<ProviderConfig['streamSimple']>>[1];
type Options = Parameters<NonNullable<ProviderConfig['streamSimple']>>[2];
type Message = Awaited<ReturnType<ReturnType<ModelRuntime['streamSimple']>['result']>>;
type Reply = string | Message['content'];
const settings = settingsSchema.parse({ provider: 'agent-lab-test', model: 'test-model', timeoutMs: 1000 });
const reviewFields = {
  successCriteria: 'The user receives the requested result supported by observable evidence.', assumptions: ['User and record details are synthetic fixtures.'],
  metrics: [
    { id: 'goal', name: 'Goal attainment', subject: 'agent' as const, description: 'Check the requested outcome.', passCriteria: 'The requested outcome is established.', failCriteria: 'The requested outcome is contradicted or omitted.' },
    { id: 'fidelity', name: 'User fidelity', subject: 'simulator' as const, description: 'Check assigned user facts and behavior.', passCriteria: 'Known facts and assigned interaction behavior are followed.', failCriteria: 'The user invents facts or violates assigned behavior.' },
  ],
};
function plainCard(index: number): Omit<Scenario, 'split'> {
  return {
    ...reviewFields, id: `card_${index}`, familyId: 'support', title: `Support question ${index}`, requirementIds: ['req_1'], provenance: 'synthetic',
    user: { goal: 'Learn how to contact support', facts: 'I need help', persona: 'Customer seeking support', characteristics: ['Concise'], behavior: 'Ask once', opening: 'How do I contact support?', maxFollowUps: 0 },
    initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [],
  };
}

function callContext(options: { timeoutMs?: number; signal?: AbortSignal; limit?: number } = {}) {
  const usage = emptyUsage();
  const ctx: CallContext = {
    signal: options.signal ?? new AbortController().signal, timeoutMs: options.timeoutMs ?? 1000,
    beforeCall() {
      if (usage.calls >= (options.limit ?? 100)) throw new Error('Call budget exhausted');
      usage.calls++;
    },
    addUsage(value) {
      usage.inputTokens += value.inputTokens;
      usage.outputTokens += value.outputTokens;
      usage.costUsd = usage.costUsd === null || value.costUsd === null ? null : usage.costUsd + value.costUsd;
    },
  };
  return { ctx, usage };
}

async function fixture(reply: (request: Request, index: number, options?: Options) => Reply | Promise<Reply>) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-pi-'));
  const requests: Request[] = [];
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'), modelsPath: null,
    modelsStorePath: join(directory, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.registerProvider('agent-lab-test', {
    api: 'openai-completions', apiKey: 'fixture-only-not-a-real-key', baseUrl: 'http://127.0.0.1:1',
    models: [{
      id: 'test-model', name: 'Offline SDK fixture', reasoning: false, input: ['text'],
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, contextWindow: 200000, maxTokens: 16384,
    }],
    streamSimple(model, request, options) {
      const index = requests.length;
      requests.push(JSON.parse(JSON.stringify(request)));
      const finished = (async (): Promise<Message> => {
        const value = await reply(request, index, options);
        const content: Message['content'] = typeof value === 'string' ? [{ type: 'text', text: value }] : value;
        return {
          role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18,
            cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.001, total: 0.032 } },
          stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now(),
        };
      })();
      // The SDK consumes the public stream iterator/result protocol. No network or model output is mocked above it.
      return {
        result: () => finished,
        async *[Symbol.asyncIterator]() {
          const message = await finished;
          yield { type: 'start', partial: message };
          yield { type: 'done', reason: message.stopReason, message };
        },
      } as ReturnType<ModelRuntime['streamSimple']>;
    },
  });
  return {
    runtime, requests, directory,
    adapter: await createPiRuntime(settings, runtime),
    async close() { await rm(directory, { recursive: true, force: true }); },
  };
}

test('real SDK sessions omit discovered resources and simulator receives only explicit user data', async () => {
  const f = await fixture(() => JSON.stringify({ message: 'Please use the later time.', done: false }));
  const cwd = process.cwd();
  try {
    await mkdir(join(f.directory, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(f.directory, 'AGENTS.md'), 'PRIVATE_CONTEXT_SENTINEL');
    await writeFile(join(f.directory, '.pi', 'extensions', 'leak.ts'), "process.env.AGENT_LAB_EXTENSION_LOADED='yes'; export default function() {};");
    process.chdir(f.directory);
    const { ctx, usage } = callContext();
    const output = await f.adapter.userTurn({
      user: {
        goal: 'Reschedule', facts: 'Record ID A; desired time 11:00', behavior: 'Provide the ID and time when asked', opening: 'Move my appointment', maxFollowUps: 1,
        persona: 'Appointment holder', characteristics: ['Answers concisely'],
        checks: 'HIDDEN_RUBRIC_SENTINEL', initialState: { transientFailures: 'BACKEND_FAILURE_SCHEDULE_SENTINEL' },
      } as never,
      messages: [{ role: 'assistant', content: 'Which time?' }], turn: 1,
    }, ctx);
    assert.equal(output.message, 'Please use the later time.');
    assert.equal(usage.calls, 1);
    assert.deepEqual(usage, { calls: 1, inputTokens: 13, outputTokens: 5, costUsd: 0.032 });
    const payload = JSON.stringify(f.requests);
    assert.match(payload, /Which time/);
    assert.match(payload, /Record ID A; desired time 11:00/);
    assert.match(payload, /maxFollowUps/);
    assert.match(payload, /Appointment holder|Answers concisely/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /assigned interaction behavior takes priority over achieving the goal/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /use done:true rather than repeatedly asking "try again" to force success/);
    assert.doesNotMatch(payload, /PRIVATE_CONTEXT_SENTINEL|HIDDEN_RUBRIC_SENTINEL|BACKEND_FAILURE_SCHEDULE_SENTINEL|Current working directory/);
    assert.deepEqual(f.requests[0]?.tools, []);
    assert.ok(f.requests.every(r => !(r.tools ?? []).some(t => /web|fetch|browse|bash|read|write/.test(t.name))));
    assert.equal(process.env.AGENT_LAB_EXTENSION_LOADED, undefined);
    const status = await getPiStatus(f.runtime);
    assert.deepEqual(status.models, [{ provider: 'agent-lab-test', id: 'test-model', name: 'Offline SDK fixture' }]);
  } finally { process.chdir(cwd); await f.close(); }
});

test('simulator preserves a final user message separately from stopping without another message', async () => {
  const replies = [{ message: 'Record ID A.', done: true }, { message: '', done: true }];
  const f = await fixture((_request, index) => JSON.stringify(replies[index]));
  try {
    const input = {
      user: { goal: 'Move my appointment', facts: 'Record ID A', behavior: 'Provide the ID when asked, then end', opening: 'Move my appointment', maxFollowUps: 1 },
      messages: [{ role: 'assistant' as const, content: 'What is the record ID?' }], turn: 1,
    };
    assert.deepEqual(await f.adapter.userTurn(input, callContext().ctx), replies[0]);
    assert.deepEqual(await f.adapter.userTurn(input, callContext().ctx), replies[1]);
    assert.match(f.requests[0]?.systemPrompt ?? '', /done:true with a nonempty message means deliver this final user message, receive the target response, then end/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /done:true with an empty message means stop now without another target response/);
  } finally { await f.close(); }
});

test('actual SDK executes only allowed tools, counts continuations and retains target conversation', async () => {
  const calls: unknown[] = [];
  const f = await fixture((_request, index) => index === 0 ? [
    { type: 'text', text: 'I will look up the record.' },
    { type: 'toolCall', id: 'lookup-1', name: 'lookup_record', arguments: { recordId: 'A' } },
    { type: 'toolCall', id: 'forbidden-1', name: 'bash', arguments: { command: 'echo forbidden' } },
  ] : 'Your appointment is at 10:00.');
  try {
    const { ctx, usage } = callContext();
    const targetEvents: unknown[] = [];
    ctx.onTargetEvent = event => { targetEvents.push(event); };
    const tool: Tool = {
      name: 'lookup_record', description: 'Look up an appointment',
      parameters: { type: 'object', properties: { recordId: { type: 'string' } }, required: ['recordId'], additionalProperties: false },
      async execute(args) { calls.push(args); return { ok: true, record: { time: '10:00' } }; },
    };
    const target = await f.adapter.openTarget({ name: 'Scheduling', instructions: 'Check the appointment.', tools: ['lookup_record'] }, [], [tool], ctx);
    assert.equal(await target.respond('When is A?'), 'Your appointment is at 10:00.');
    assert.deepEqual(calls, [{ recordId: 'A' }]);
    assert.equal(usage.calls, 2);
    assert.equal(usage.inputTokens, 26);
    assert.equal(targetEvents.length, 3);
    assert.deepEqual(targetEvents[0], { type: 'assistant', text: 'I will look up the record.' });
    assert.match(JSON.stringify(targetEvents), /forbidden|bash/);
    assert.doesNotMatch(JSON.stringify(targetEvents), /lookup_record|10:00/);
    assert.deepEqual(f.requests[0]?.tools?.map(t => t.name), ['lookup_record']);
    assert.match(JSON.stringify(f.requests[1]?.messages), /not found|Unknown tool|not available/i);
    await target.respond('Thanks');
    assert.match(JSON.stringify(f.requests[2]?.messages), /When is A/);
    await target.close();
    await assert.rejects(target.respond('Again'), /closed/);
  } finally { await f.close(); }
});

test('provider continuations respect call budget and malformed structured output remains invalid', async () => {
  const f = await fixture(() => [{ type: 'toolCall', id: 'read-1', name: 'lookup_record', arguments: { recordId: 'A' } }]);
  try {
    const { ctx, usage } = callContext({ limit: 1 });
    const target = await f.adapter.openTarget({ name: 'A', instructions: 'Find A', tools: ['lookup_record'] }, [], [{
      name: 'lookup_record', description: 'Lookup', parameters: { type: 'object', properties: {} },
      async execute() { return { ok: true }; },
    }], ctx);
    await assert.rejects(target.respond('Find A'), /Call budget exhausted/);
    assert.equal(usage.calls, 1);
    assert.equal(f.requests.length, 1);
    await target.close();
  } finally { await f.close(); }
  const malformed = await fixture(() => 'This is not JSON');
  try {
    await assert.rejects(malformed.adapter.userTurn({ user: { goal: 'A', facts: 'A', behavior: 'A', opening: 'A' }, messages: [], turn: 0 }, callContext().ctx), /malformed JSON/);
  } finally { await malformed.close(); }
});

test('a structured answer wrapped in a markdown fence is still the model answer', async () => {
  // Models wrap JSON in a fence often enough that rejecting it would fail runs over formatting, not content.
  const fenced = await fixture(() => '```json\n{"message":"Move it to 11:00","done":false}\n```');
  try {
    const turn = await fenced.adapter.userTurn({ user: { goal: 'A', facts: 'A', behavior: 'A', opening: 'A' }, messages: [], turn: 0 }, callContext().ctx);
    assert.deepEqual(turn, { message: 'Move it to 11:00', done: false });
  } finally { await fenced.close(); }

  const prose = await fixture(() => 'Here you go: {"message":"hi","done":false}');
  try {
    await assert.rejects(prose.adapter.userTurn({ user: { goal: 'A', facts: 'A', behavior: 'A', opening: 'A' }, messages: [], turn: 0 }, callContext().ctx), /malformed JSON/);
  } finally { await prose.close(); }
});

test('deadline and external cancellation reach the actual SDK provider stream', async () => {
  for (const cancel of [false, true]) {
    let providerAborted = false;
    const f = await fixture((_request, _index, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => { providerAborted = true; reject(new Error('request aborted')); }, { once: true });
    }));
    try {
      const controller = new AbortController();
      const { ctx, usage } = callContext({ timeoutMs: cancel ? 1000 : 25, signal: controller.signal });
      const pending = f.adapter.userTurn({ user: { goal: 'A', facts: 'A', behavior: 'A', opening: 'A' }, messages: [], turn: 0 }, ctx);
      const timer = cancel ? setTimeout(() => controller.abort(new Error('User cancelled')), 25) : undefined;
      await assert.rejects(pending, cancel ? /User cancelled/ : /deadline exceeded/);
      if (timer) clearTimeout(timer);
      assert.equal(providerAborted, true);
      assert.equal(usage.costUsd, null, 'Aborted requests without usage cannot be reported as free');
    } finally { await f.close(); }
  }
});

test('missing model selection fails without demo fallback and builder rejects control feedback', async () => {
  await assert.rejects(createPiRuntime(settingsSchema.parse({})), /Select a provider and model/);
  const f = await fixture(() => 'unused');
  try {
    await assert.rejects(f.adapter.improve({ feedback: [{ scenario: { split: 'control' }, trials: [] }] } as never, callContext().ctx), /development evidence only/);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('preparation separates grounded requirements, independent cards and candidate construction', async () => {
  const quote = 'Verify the record ID before changing the appointment time.';
  const requirements = [{ id: 'req_1', text: quote, sourceId: 'source_1', quote, critical: true }];
  const familyNames = ['normal', 'clarify', 'changed', 'retry', 'readonly', 'unsupported', 'privacy', 'conflict'];
  const families = familyNames.map(familyId => ({ familyId, mechanism: `Boundary for ${familyId}`, requirementIds: ['req_1'] }));
  const scenarios = familyNames.map((family, index) => ({
    ...reviewFields,
    id: `case_${index}`, familyId: family, title: `SCENARIO_PRIVATE_${family}`,
    requirementIds: ['req_1'], provenance: 'synthetic',
    user: { goal: 'Move A to 11:00', facts: 'Record ID A; final desired time 11:00', behavior: 'No additional request', opening: 'Move A to 11:00', maxFollowUps: 0, persona: 'Appointment holder', characteristics: ['Concise'] },
    initialState: { records: { A: { time: '10:00' } }, writableFields: ['time'], transientFailures: 0 },
    checks: [
      { id: 'state_1', description: 'Time changed', kind: 'state_equals', recordId: 'A', field: 'time', value: '11:00' },
      { id: 'order_1', description: 'Each update uses a fresh successful read', kind: 'fresh_read_before_update' },
      { id: 'count_1', description: 'One update operation has at most two retries', kind: 'tool_count', tool: 'update_record', min: 1, max: 3 },
    ],
  }));
  const spec = { name: 'IMPLEMENTATION_PRIVATE', instructions: 'Check the ID, update time, confirm tool success.', tools: ['lookup_record', 'update_record'] };
  const outputs = [{ requirements, questions: [] }, { families }, { scenarios: scenarios.slice(0, 4) }, { scenarios: scenarios.slice(4) }, spec, { agent: spec, hypothesis: 'No measured failure supports another change.' }];
  const f = await fixture((_request, index) => JSON.stringify(outputs[index]));
  try {
    const { ctx, usage } = callContext();
    const prepared = await f.adapter.prepare({
      task: 'Manage appointments', sources: [{ id: 'source_1', name: 'Policy', content: quote, hash: 'source-hash' }], workflow: 'compare',
    }, ctx);
    assert.equal(prepared.agent.name, spec.name);
    assert.equal(prepared.scenarios.length, 8);
    assert.ok(prepared.scenarios.every(scenario => scenario.user.maxFollowUps === 0));
    assert.deepEqual(prepared.scenarios[0]?.checks.map(check => check.kind), ['state_equals', 'fresh_read_before_update', 'tool_count']);
    assert.equal(usage.calls, 5);
    assert.ok(f.requests.every(r => r.messages.length === 1 && r.tools?.length === 0));
    assert.match(JSON.stringify(f.requests[0]?.messages), /Verify the record ID/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /NOT quotable business-source evidence/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /retryable/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /lookup_record/);
    // Check the generated schema reaches the actual provider, rather than existing only in local grading types.
    assert.match(f.requests[2]?.systemPrompt ?? '', /"const":"fresh_read_before_update"/);
    assert.match(f.requests[2]?.systemPrompt ?? '', /"const":"tool_count"/);
    assert.match(f.requests[2]?.systemPrompt ?? '', /"required":\["goal","facts","behavior","opening","maxFollowUps","persona","characteristics"\]/);
    assert.match(f.requests[2]?.systemPrompt ?? '', /extra reads must not fail unless a source explicitly limits them/);
    assert.match(f.requests[2]?.systemPrompt ?? '', /exact requested fixture values or wording a source explicitly mandates verbatim/);
    assert.match(f.requests[2]?.systemPrompt ?? '', /before observing an error the user simply wants the task done/);
    for (const request of f.requests.slice(1, 4)) assert.doesNotMatch(JSON.stringify(request.messages), /IMPLEMENTATION_PRIVATE/);
    assert.doesNotMatch(JSON.stringify(f.requests[4]?.messages), /SCENARIO_PRIVATE|Boundary for/);
    const payload = (index: number) => {
      const content = f.requests[index]!.messages[0]!.content;
      return JSON.parse(typeof content === 'string' ? content : content.filter(c => c.type === 'text').map(c => c.text).join(''));
    };
    assert.deepEqual(payload(2).requestedFamilies.map((f: { familyId: string }) => f.familyId), familyNames.slice(0, 4));
    assert.deepEqual(payload(3).requestedFamilies.map((f: { familyId: string }) => f.familyId), familyNames.slice(4));
    assert.deepEqual(payload(2).familyPlan, payload(3).familyPlan);
    const proposal = await f.adapter.improve({ task: 'Manage appointments', sources: [], requirements, agent: prepared.agent, feedback: [] }, ctx);
    assert.equal(proposal.hypothesis, 'No measured failure supports another change.');
    assert.equal(usage.calls, 6);
  } finally { await f.close(); }
});

test('default evaluation prepares exactly five cards and also supports one plain conversational case', async () => {
  for (const count of [5, 1]) {
    const quote = 'Support is available by email.';
    const cards = Array.from({ length: count }, (_, index) => plainCard(index));
    const original = { name: 'EXISTING_AGENT_PRIVATE', instructions: 'Tell users how to contact support.', tools: [] };
    const outputs = [
      { requirements: [{ id: 'req_1', text: quote, sourceId: 'source_1', quote, critical: true }], questions: [] },
      ...Array.from({ length: Math.ceil(count / 3) }, (_, index) => ({ scenarios: cards.slice(index * 3, index * 3 + 3) })),
    ];
    const f = await fixture((_request, index) => JSON.stringify(outputs[index]));
    try {
      const result = await f.adapter.prepare({
        task: 'Evaluate support answers', sources: [{ id: 'source_1', name: 'Policy', content: quote, hash: 'hash' }],
        existingAgent: original, ...(count === 1 ? { scenarioCount: 1 } : {}),
      }, callContext().ctx);
      assert.equal(result.scenarios.length, count);
      assert.deepEqual(result.agent, original);
      assert.equal(f.requests.length, 1 + Math.ceil(count / 3));
      assert.ok(result.scenarios.every(s => s.metrics?.some(m => m.subject === 'agent') && s.metrics?.some(m => m.subject === 'simulator')));
      assert.ok(result.scenarios.every(s => s.checks.length === 0 && s.user.persona && s.user.characteristics));
      assert.doesNotMatch(JSON.stringify(f.requests), /EXISTING_AGENT_PRIVATE|Prefer eight meaningful families/);
      assert.match(JSON.stringify(f.requests[1]?.messages), /requestedCount/);
      assert.match(f.requests[1]?.systemPrompt ?? '', /what the user wants to achieve, not an implementation rule/);
      if (count === 5) {
        const last = JSON.stringify(f.requests[2]?.messages);
        assert.match(last, /earlierGoals|card_0/);
        assert.doesNotMatch(last, /passCriteria|failCriteria|EXISTING_AGENT_PRIVATE/);
      }
    } finally { await f.close(); }
  }
});

test('card generation distinguishes the answer being sought from legitimate prior user knowledge', async () => {
  const quote = 'Weekday opening hours are 08:00–20:00. Ask the visit day if it is missing.';
  const card = plainCard(0);
  card.user = { ...card.user, goal: 'Learn cafe hours for Tuesday', facts: 'I plan to visit on Tuesday', opening: 'What are your opening hours?', behavior: 'Provide Tuesday when asked, then end', maxFollowUps: 1 };
  const outputs = [
    { requirements: [{ id: 'req_1', text: quote, sourceId: 'source_1', quote, critical: true }], questions: [] },
    { scenarios: [card] },
  ];
  const f = await fixture((_request, index) => JSON.stringify(outputs[index]));
  try {
    await f.adapter.prepare({
      task: 'Evaluate a visitor asking cafe hours', scenarioCount: 1,
      sources: [{ id: 'source_1', name: 'Cafe policy', content: quote, hash: 'hash' }],
      existingAgent: { name: 'Cafe', instructions: quote, tools: [] },
    }, callContext().ctx);
    const request = f.requests[1]!;
    assert.match(JSON.stringify(request.messages), /08:00–20:00/);
    assert.match(request.systemPrompt ?? '', /keep that answer and grading criteria from business materials out of all user fields unless the scenario explicitly establishes prior knowledge/);
    assert.match(request.systemPrompt ?? '', /Preserve legitimately known facts/);
    assert.match(request.systemPrompt ?? '', /planned visit day.*not the business answer they want to learn/);
  } finally { await f.close(); }
});

test('isolated assessment uses approved rubrics and trace evidence without inheriting deterministic verdicts', async () => {
  const assessments = [
    { metricId: 'goal', result: 'pass', rationale: 'The reply provides the support contact.', evidence: [1] },
    { metricId: 'fidelity', result: 'unknown', rationale: 'No reactive user turn occurred.', evidence: [] },
  ];
  const f = await fixture(() => JSON.stringify({ assessments }));
  try {
    const scenario: Scenario = { ...plainCard(0), split: 'dev' };
    const trial: Trial = {
      id: 'trial_1', revisionId: 'revision_1', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0,
      split: 'dev', manifestHash: 'hash', outcome: 'fail', reason: 'DETERMINISTIC_GRADE_SENTINEL', checks: [],
      events: [{ seq: 0, type: 'user', text: 'How do I contact support?' }, { seq: 1, type: 'assistant', text: 'Email support@example.test.' }],
      initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1,
    };
    const { ctx, usage } = callContext();
    assert.deepEqual(await f.adapter.assess!({ scenario, sources: [], trial }, ctx), assessments);
    assert.equal(usage.calls, 1);
    assert.deepEqual(f.requests[0]?.tools, []);
    const payload = JSON.stringify(f.requests[0]?.messages);
    assert.match(payload, /passCriteria|support@example.test/);
    assert.doesNotMatch(payload, /DETERMINISTIC_GRADE_SENTINEL/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /actual event seq number/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /provisional model estimates for human review/);
    assert.deepEqual(await f.adapter.assess!({ scenario: { ...scenario, metrics: undefined }, sources: [], trial }, ctx), []);
    assert.equal(usage.calls, 1, 'Legacy cards without rubrics do not incur a judge call');
  } finally { await f.close(); }
});

test('scenario batches reject invalid attribution and incomplete human-review cards', async () => {
  const quote = 'Use the requested time.';
  const requirements = [{ id: 'req_1', text: quote, sourceId: 'source_1', quote, critical: true }];
  const families = Array.from({ length: 8 }, (_, i) => ({ familyId: `family_${i}`, mechanism: `Mechanism ${i}`, requirementIds: ['req_1'] }));
  const cards = families.map(f => ({
    ...reviewFields,
    id: `scenario_${f.familyId}`, familyId: f.familyId, title: f.mechanism,
    requirementIds: ['req_1'], provenance: 'synthetic',
    user: { goal: 'Change time', facts: 'Record A at 11:00', behavior: 'No additional request', opening: 'Set A to 11:00', maxFollowUps: 0, persona: 'Appointment holder', characteristics: ['Concise'] },
    initialState: { records: { A: { time: '10:00' } }, writableFields: ['time'], transientFailures: 0 },
    checks: [{ id: 'time', description: 'Requested time', kind: 'state_equals', recordId: 'A', field: 'time', value: '11:00' }],
  }));
  for (const issue of ['duplicate plan', 'unknown plan requirement', 'unplanned family', 'duplicate scenario', 'unknown card requirement', 'missing follow-up budget', 'missing persona', 'missing success criteria', 'missing simulator rubric']) {
    const plan = structuredClone(families);
    const scenarios = structuredClone(cards);
    if (issue === 'duplicate plan') plan[1]!.familyId = plan[0]!.familyId;
    if (issue === 'unknown plan requirement') plan[0]!.requirementIds = ['unknown'];
    if (issue === 'unplanned family') scenarios[0]!.familyId = 'family_7';
    if (issue === 'duplicate scenario') scenarios[4]!.id = scenarios[0]!.id;
    if (issue === 'unknown card requirement') scenarios[0]!.requirementIds = ['unknown'];
    if (issue === 'missing follow-up budget') delete (scenarios[0]!.user as { maxFollowUps?: number }).maxFollowUps;
    if (issue === 'missing persona') delete (scenarios[0]!.user as { persona?: string }).persona;
    if (issue === 'missing success criteria') delete (scenarios[0]! as { successCriteria?: string }).successCriteria;
    if (issue === 'missing simulator rubric') scenarios[0]!.metrics = scenarios[0]!.metrics.filter(m => m.subject === 'agent');
    const outputs = [{ requirements, questions: [] }, { families: plan }, { scenarios: scenarios.slice(0, 4) }, { scenarios: scenarios.slice(4) }];
    const f = await fixture((_request, index) => JSON.stringify(outputs[index]));
    try {
      await assert.rejects(f.adapter.prepare({
        task: 'Reschedule', sources: [{ id: 'source_1', name: 'Policy', content: quote, hash: 'hash' }],
        workflow: 'compare',
        existingAgent: { name: 'Original', instructions: quote, tools: ['update_record'] },
      }, callContext().ctx), issue.startsWith('missing ') ? /Scenario.*invalid structured response/ : /Scenario.*(duplicate|unknown|unrequested)/, issue);
      assert.ok(f.requests.length <= 4, 'Invalid family/card output must stop before any candidate construction');
    } finally { await f.close(); }
  }
});

test('profile extraction cites only supplied dialogues, sees user turns only, and the simulator may disengage without exaggerating', async () => {
  const profile = { id: 'observed_1', persona: 'Observed appointment holder', characteristics: ['Writes short messages'], observedStyle: '12 chars on average', evidenceDialogueIds: ['d1'] };
  const replies = [{ profiles: [profile] }, { profiles: [{ ...profile, evidenceDialogueIds: ['nope'] }] }, { message: 'ok, not now', done: true }];
  const f = await fixture((_request, index) => JSON.stringify(replies[index]));
  try {
    const dialogues = [{ id: 'd1', messages: [{ role: 'user' as const, content: 'hello from user' }, { role: 'assistant' as const, content: 'ASSISTANT_PRIVATE reply' }], outcome: 'success' as const }];
    const profiles = await f.adapter.profiles!({ task: 'Manage appointments', sources: [], dialogues }, callContext().ctx);
    assert.deepEqual(profiles, [{ ...profile, source: 'observed' }]);
    assert.match(f.requests[0]?.systemPrompt ?? '', /Do not infer demographic traits/);
    assert.match(f.requests[0]?.systemPrompt ?? '', /evidenceDialogueIds only from the supplied dialogues/);
    const payload = JSON.stringify(f.requests[0]?.messages);
    assert.match(payload, /hello from user/);
    assert.doesNotMatch(payload, /ASSISTANT_PRIVATE/);
    await assert.rejects(f.adapter.profiles!({ task: 'Manage appointments', sources: [], dialogues }, callContext().ctx), /evidence/i);
    const turn = await f.adapter.userTurn({ user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 1, persona: profile.persona, characteristics: profile.characteristics }, messages: [{ role: 'assistant', content: 'I cannot help with that.' }], turn: 1 }, callContext().ctx);
    assert.deepEqual(turn, { message: 'ok, not now', done: true });
    assert.match(f.requests[2]?.systemPrompt ?? '', /Real users leave/);
    assert.match(f.requests[2]?.systemPrompt ?? '', /Do not exaggerate traits/);
  } finally { await f.close(); }
});

test('card generation with observed profiles requires a profileId and passes the profiles as evidence', async () => {
  const quote = 'Support is available by email.';
  const profile = { id: 'observed_1', persona: 'Observed customer', characteristics: ['Writes short messages'], observedStyle: 'short', evidenceDialogueIds: ['d1'] };
  const requirements = [{ id: 'req_1', text: quote, sourceId: 'source_1', quote, critical: true }];
  const outputs = [{ requirements, questions: [] }, { scenarios: [plainCard(0)] }, { requirements, questions: [] }, { scenarios: [{ ...plainCard(1), profileId: 'observed_1' }] }];
  const f = await fixture((_request, index) => JSON.stringify(outputs[index]));
  try {
    const input = { task: 'Evaluate support answers', sources: [{ id: 'source_1', name: 'Policy', content: quote, hash: 'hash' }], existingAgent: { name: 'A', instructions: 'Help.', tools: [] }, scenarioCount: 1, profiles: [profile] };
    await assert.rejects(f.adapter.prepare(input, callContext().ctx), /profileId/);
    const prepared = await f.adapter.prepare(input, callContext().ctx);
    assert.equal(prepared.scenarios[0]?.profileId, 'observed_1');
    assert.match(f.requests[3]?.systemPrompt ?? '', /profileId to one of them/);
    assert.match(JSON.stringify(f.requests[3]?.messages), /observedProfiles/);
    assert.match(JSON.stringify(f.requests[3]?.messages), /Observed customer/);
  } finally { await f.close(); }
});

test('owner notes reach the card generator as owner-supplied hints, not as business rules', async () => {
  const quote = 'Support is available by email.';
  const outputs = [{ requirements: [{ id: 'req_1', text: quote, sourceId: 'source_1', quote, critical: true }], questions: [] }, { scenarios: [plainCard(0)] }];
  const f = await fixture((_request, index) => JSON.stringify(outputs[index]));
  try {
    await f.adapter.prepare({
      task: 'Evaluate support answers', sources: [{ id: 'source_1', name: 'Policy', content: quote, hash: 'hash' }],
      existingAgent: { name: 'A', instructions: 'Help.', tools: [] }, scenarioCount: 1, notes: 'OWNER_HINT: users often write in a hurry and skip details.',
    }, callContext().ctx);
    assert.match(JSON.stringify(f.requests[1]?.messages), /OWNER_HINT/);
    assert.doesNotMatch(JSON.stringify(f.requests[0]?.messages), /OWNER_HINT/);
    assert.match(f.requests[1]?.systemPrompt ?? '', /ownerNotes/);
    assert.match(f.requests[1]?.systemPrompt ?? '', /not business rules/);
  } finally { await f.close(); }
});

test('observed goals are extracted from user turns, must quote a real opening and a known profile', async () => {
  const dialogues = [{ id: 'd1', messages: [{ role: 'user' as const, content: 'move A101 to 14:00 pls' }, { role: 'assistant' as const, content: 'ASSISTANT_PRIVATE' }], outcome: 'success' as const }];
  const profile = { id: 'observed_1', persona: 'Observed', characteristics: ['Short'], observedStyle: 's', evidenceDialogueIds: ['d1'], source: 'observed' as const };
  const good = { id: 'goal_move', goal: 'Move appointment A101 to 14:00', opening: 'move A101 to 14:00 pls', profileId: 'observed_1', evidenceDialogueIds: ['d1'], successCriteria: 'Moved or told why not' };
  const replies = [{ goals: [good] }, { goals: [{ ...good, opening: 'invented opening' }] }, { goals: [{ ...good, profileId: 'nope' }] }];
  const f = await fixture((_request, index) => JSON.stringify(replies[index]));
  try {
    const goals = await f.adapter.goals!({ task: 'Manage appointments', sources: [], dialogues, profiles: [profile] }, callContext().ctx);
    assert.equal(goals[0]?.opening, 'move A101 to 14:00 pls');
    assert.match(f.requests[0]?.systemPrompt ?? '', /verbatim/);
    assert.doesNotMatch(JSON.stringify(f.requests[0]?.messages), /ASSISTANT_PRIVATE/);
    await assert.rejects(f.adapter.goals!({ task: 'Manage appointments', sources: [], dialogues, profiles: [profile] }, callContext().ctx), /opening/i);
    await assert.rejects(f.adapter.goals!({ task: 'Manage appointments', sources: [], dialogues, profiles: [profile] }, callContext().ctx), /profileId/);
  } finally { await f.close(); }
});

test('card generation receives observed goals so synthetic cards add new situations instead of repeating the logs', async () => {
  const quote = 'Support is available by email.';
  const outputs = [{ requirements: [{ id: 'req_1', text: quote, sourceId: 'source_1', quote, critical: true }], questions: [] }, { scenarios: [plainCard(0)] }];
  const f = await fixture((_request, index) => JSON.stringify(outputs[index]));
  try {
    await f.adapter.prepare({
      task: 'Evaluate support answers', sources: [{ id: 'source_1', name: 'Policy', content: quote, hash: 'hash' }], existingAgent: { name: 'A', instructions: 'Help.', tools: [] }, scenarioCount: 1,
      observedGoals: [{ id: 'goal_1', goal: 'OBSERVED_GOAL_SENTINEL', opening: 'how do I email support?', profileId: 'p', evidenceDialogueIds: ['d1'], successCriteria: 's', facts: 'f', outcome: 'unknown' }],
    }, callContext().ctx);
    assert.match(JSON.stringify(f.requests[1]?.messages), /OBSERVED_GOAL_SENTINEL/);
    assert.match(f.requests[1]?.systemPrompt ?? '', /observedGoals/);
  } finally { await f.close(); }
});

test('the card generator is told to probe the agent perimeter with an out-of-scope request graded by a rubric', async () => {
  const quote = 'The assistant answers only questions about appointments and must decline legal advice.';
  const outputs = [{ requirements: [{ id: 'req_1', text: quote, sourceId: 'source_1', quote, critical: true }], questions: [] }, { scenarios: [plainCard(0)] }];
  const f = await fixture((_request, index) => JSON.stringify(outputs[index]));
  try {
    await f.adapter.prepare({ task: 'Evaluate the appointment assistant', sources: [{ id: 'source_1', name: 'Agent card', content: quote, hash: 'hash' }], existingAgent: { name: 'A', instructions: 'Help.', tools: [] }, scenarioCount: 1 }, callContext().ctx);
    assert.match(f.requests[1]?.systemPrompt ?? '', /out-of-scope question whose success is a correct refusal or redirect/);
  } finally { await f.close(); }
});
