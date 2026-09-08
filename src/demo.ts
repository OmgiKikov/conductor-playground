import {
  createInputSchema, agentSchema, preparationSchema, proposalSchema, fingerprint,
  type AgentSpec, type CallContext, type CreateInput, type MetricAssessment, type Rubric, type Runtime, type Tool,
} from './contracts.js';

const task = 'Build an appointment assistant that consults policy, reads appointments, and reliably changes the requested time without altering unrelated fields.';
const policy = [
  'Appointment policy',
  'Before changing an appointment, read its current record and update only its time field to the user’s requested time.',
  'Read-only requests must leave every record unchanged.',
  'If the appointment ID or desired time is missing, ask the user to provide it before making a change.',
  'If an update returns a retryable error, retry it up to two more times and confirm success only after a successful tool result.',
  'If the user changes their preferred time during the conversation, the final record must reflect their last request.',
].join('\n');
const baseline: AgentSpec = {
  name: 'Appointment assistant',
  instructions: 'Consult appointment policy. Read the appointment before changing it. Ask for missing appointment IDs or desired times. Update only the time field. Retry retryable errors up to two times. Never claim an update succeeded without its successful tool result. Handle changed user preferences and read-only questions.',
  tools: ['search_materials', 'lookup_record'],
};

export function demoInput(): CreateInput {
  return createInputSchema.parse({ task, materials: [{ name: 'Appointment policy', content: policy }], mode: 'demo', workflow: 'compare', settings: { maxIterations: 1 } });
}

const demoMetrics: Rubric[] = [
  { id: 'demo_task_state', name: 'Task outcome (scripted estimate)', subject: 'agent',
    description: 'A deterministic demo estimate from the objective checks, not a semantic model judgment.',
    passCriteria: 'Every approved objective check passes in the completed dialogue.', failCriteria: 'At least one approved objective check fails.' },
  { id: 'demo_follow_ups', name: 'Interaction budget (scripted estimate)', subject: 'simulator',
    description: 'A narrow count and delivery check, not an assessment of human realism or full role fidelity.',
    passCriteria: 'The assigned follow-up budget is respected, and every nonempty terminal simulator message is delivered to the agent.',
    failCriteria: 'The assigned follow-up budget is exceeded or a nonempty terminal simulator message is discarded.' },
];

function call(ctx: CallContext) {
  ctx.signal.throwIfAborted();
  ctx.beforeCall();
  ctx.addUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
}

function sampleScenarios(): ReturnType<typeof preparationSchema.parse>['scenarios'] {
  const variants = [
    { familyId: 'a_direct', title: 'Move an appointment', opening: 'Please move appointment A101 to 14:00.', time: '14:00', id: 'A101', behavior: 'Finish when the assistant answers the request.', failures: 0, requirementIds: ['change'] },
    { familyId: 'b_direct_control', title: 'Move a different appointment', opening: 'Move appointment A102 to 16:30.', time: '16:30', id: 'A102', behavior: 'Finish when the assistant answers the request.', failures: 0, requirementIds: ['change'] },
    { familyId: 'c_clarify', title: 'Clarify missing appointment ID', opening: 'Please move my appointment to 11:30.', time: '11:30', id: 'A103', behavior: 'Provide the appointment ID only if asked.', failures: 0, requirementIds: ['change', 'clarify'] },
    { familyId: 'd_clarify_control', title: 'Clarify missing desired time', opening: 'I need to move appointment A104.', time: '17:00', id: 'A104', behavior: 'Provide the desired time only if asked.', failures: 0, requirementIds: ['change', 'clarify'] },
    { familyId: 'e_retry', title: 'Recover from a transient failure', opening: 'Move appointment A105 to 12:00.', time: '12:00', id: 'A105', behavior: 'Finish when the assistant answers the request.', failures: 1, requirementIds: ['change', 'retry'] },
    { familyId: 'f_retry_control', title: 'Recover from two transient failures', opening: 'Move appointment A106 to 15:30.', time: '15:30', id: 'A106', behavior: 'Finish when the assistant answers the request.', failures: 2, requirementIds: ['change', 'retry'] },
    { familyId: 'g_read', title: 'Keep a record unchanged on a question', opening: 'What time is appointment A107? Do not change it.', time: '09:00', id: 'A107', behavior: 'Read-only question; finish after the answer.', failures: 0, requirementIds: ['read'] },
    { familyId: 'h_read_control', title: 'Answer another read-only question', opening: 'Tell me the current time of appointment A108. Do not change it.', time: '09:00', id: 'A108', behavior: 'Read-only question; finish after the answer.', failures: 0, requirementIds: ['read'] },
    { familyId: 'i_preference', title: 'Change preference after the first response', opening: 'Move appointment A109 to 10:00.', time: '18:00', id: 'A109', behavior: 'After the first complete response, change preference once to 18:00.', failures: 0, requirementIds: ['change', 'preference'] },
    { familyId: 'j_preference_control', title: 'Revise a different requested time', opening: 'Move appointment A110 to 13:00.', time: '19:00', id: 'A110', behavior: 'After the first complete response, change preference once to 19:00.', failures: 0, requirementIds: ['change', 'preference'] },
  ];
  return variants.map((v, index) => ({
    id: v.familyId, familyId: ['a_direct', 'b_clarification', 'c_retry', 'd_read_only', 'e_preference'][Math.floor(index / 2)]!, title: v.title, requirementIds: v.requirementIds, provenance: 'curated' as const,
    user: { goal: v.requirementIds.includes('read') ? `Learn the time of appointment ${v.id} without changing it.` : `Move appointment ${v.id} to ${v.time}.`, facts: `Your appointment ID is ${v.id}. Your desired time is ${v.time}.`, behavior: v.behavior, opening: v.opening,
      maxFollowUps: v.requirementIds.includes('clarify') || v.requirementIds.includes('preference') ? 1 : 0 },
    initialState: { records: { [v.id]: { time: '09:00', owner: 'Sample customer', status: 'booked' } }, writableFields: ['time'], transientFailures: v.failures },
    checks: [
      { id: 'time', kind: 'state_equals' as const, description: 'The final appointment time matches the user request', recordId: v.id, field: 'time', value: v.time },
      { id: 'owner', kind: 'state_equals' as const, description: 'The appointment owner is preserved', recordId: v.id, field: 'owner', value: 'Sample customer' },
      { id: 'status', kind: 'state_equals' as const, description: 'The booking remains active', recordId: v.id, field: 'status', value: 'booked' },
      { id: 'lookup', kind: 'tool_called' as const, description: 'The assistant looked up the actual record', tool: 'lookup_record' as const },
      ...(v.requirementIds.includes('read') ? [
        { id: 'no_write', kind: 'tool_not_called' as const, description: 'The read-only request caused no update attempt', tool: 'update_record' as const },
        { id: 'answer_time', kind: 'answer_contains' as const, description: 'The answer gives the recorded appointment time', value: '09:00' },
      ] : []),
    ],
  }));
}

const resultSchema = (value: unknown): { ok: boolean; retryable?: boolean; record?: Record<string, unknown> } => {
  if (!value || typeof value !== 'object' || !('ok' in value) || typeof value.ok !== 'boolean') throw new Error('Malformed demo tool response');
  return value as { ok: boolean; retryable?: boolean; record?: Record<string, unknown> };
};

export function createDemoRuntime(): Runtime {
  return {
    async prepare(input, ctx) {
      call(ctx);
      const working = { ...structuredClone(baseline), tools: [...baseline.tools, 'update_record' as const] };
      if (input.task !== task || input.sources.length !== 1 || input.sources[0]?.content !== policy || input.sources[0]?.name !== 'Appointment policy'
        || (input.existingAgent && fingerprint(input.existingAgent) !== fingerprint(baseline)
          && !(input.workflow === 'evaluate' && fingerprint(input.existingAgent) === fingerprint(working)))) {
        throw new Error('The scripted demo supports only its supplied appointment sample. Reset the sample or choose live Pi mode for custom tasks and materials.');
      }
      const sourceId = input.sources[0]!.id;
      const lines = policy.split('\n');
      let scenarios = sampleScenarios();
      if (input.workflow === 'evaluate') {
        const count = input.scenarioCount ?? 5;
        if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('The demo scenario count must be an integer from 1 to 10');
        // Put one example of each mechanism first, then the remaining curated variants.
        scenarios = [...scenarios.filter((_, i) => i % 2 === 0), ...scenarios.filter((_, i) => i % 2 === 1)].slice(0, count).map(scenario => ({
          ...scenario,
          user: { ...scenario.user, persona: 'An appointment holder arranging their own visit.',
            characteristics: ['Uses concise requests', scenario.requirementIds.includes('clarify') ? 'Provides an omitted detail when asked'
              : scenario.requirementIds.includes('preference') ? 'Revises the desired time once' : 'Ends after the assigned request is answered'] },
          successCriteria: `${scenario.user.goal} Preserve the appointment owner and booking status, and report only actions supported by tool results.`,
          assumptions: ['This is a curated, scripted appointment demo.', 'The user is authorized to access their fixture appointment.'],
          metrics: structuredClone(demoMetrics),
        }));
      }
      return preparationSchema.parse({
        requirements: ['change', 'read', 'clarify', 'retry', 'preference'].map((id, i) => ({ id, text: lines[i + 1], sourceId, quote: lines[i + 1], critical: true })),
        questions: [], agent: structuredClone(input.existingAgent ?? (input.workflow === 'evaluate' ? working : baseline)), scenarios,
      });
    },
    async assess({ scenario, trial }, ctx) {
      call(ctx);
      return (scenario.metrics ?? []).map((metric): MetricAssessment => {
        const supported = demoMetrics.find(sample => fingerprint(sample) === fingerprint(metric));
        if (!supported) return { metricId: metric.id, result: 'unknown', rationale: 'The scripted demo cannot assess custom or edited rubrics. Use live mode or human review.', evidence: [] };
        if (metric.id === 'demo_task_state') {
          const evidence = trial.events.filter(event => event.type === 'tool_result' || event.type === 'assistant').slice(-30).map(event => event.seq);
          return { metricId: metric.id, result: !trial.checks.length || !evidence.length ? 'unknown' : trial.checks.every(check => check.passed) ? 'pass' : 'fail',
            rationale: 'Scripted estimate from the recorded objective checks. It does not independently assess meaning, truthfulness, or user satisfaction.', evidence };
        }
        const decisions = trial.events.filter(event => event.type === 'simulator');
        if (!decisions.length) return { metricId: metric.id, result: 'unknown', rationale: 'No simulator follow-up was requested; dynamic delivery was not exercised.', evidence: [] };
        const followUps = trial.events.filter(event => event.type === 'user').slice(1);
        const dropped = decisions.some(event => {
          const decision = event.result as { done: boolean; message: string };
          return decision.done && decision.message.trim() && !followUps.some(reply => reply.seq > event.seq && reply.text === decision.message);
        });
        const exceeded = scenario.user.maxFollowUps !== undefined && followUps.length > scenario.user.maxFollowUps;
        return { metricId: metric.id, result: dropped || exceeded ? 'fail' : 'pass',
          rationale: `Scripted delivery check: ${followUps.length} follow-up(s), ${dropped ? 'a discarded terminal message' : 'no discarded terminal message'}. This does not establish realistic user behavior.`,
          evidence: [...decisions, ...followUps].map(event => event.seq).sort((a, b) => a - b).slice(-30) };
      });
    },
    async improve(input, ctx) {
      call(ctx);
      const hasFailedChange = input.feedback.some(f => f.trials.some(t => t.outcome === 'fail' && t.checks.some(c => c.id === 'time' && !c.passed)));
      const agent = structuredClone(input.agent);
      if (hasFailedChange && !agent.tools.includes('update_record')) agent.tools.push('update_record');
      return proposalSchema.parse({ agent, hypothesis: hasFailedChange
        ? 'Scripted demonstration repair: development traces show unchanged appointment times. Add the missing update_record capability and rerun the same checks.'
        : 'Scripted demonstration: no additional supported repair was identified.' });
    },
    async openTarget(agent, _sources, tools, ctx) {
      agentSchema.parse(agent);
      const available = new Map(tools.map(tool => [tool.name, tool]));
      let recordId: string | undefined;
      let time: string | undefined;
      let closed = false;
      const execute = async (name: Tool['name'], args: unknown) => {
        const tool = available.get(name);
        if (!tool) return { ok: false };
        return resultSchema(await tool.execute(args));
      };
      return {
        async respond(message) {
          if (closed) throw new Error('Target session is closed');
          call(ctx);
          recordId = message.match(/\bA\d{3}\b/)?.[0] ?? recordId;
          const times = message.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g);
          time = times?.at(-1) ?? time;
          const readOnly = /do not change|current time|what time/i.test(message);
          if (!recordId) return 'What is your appointment ID?';
          await execute('search_materials', { query: 'appointment policy' });
          const lookup = await execute('lookup_record', { recordId });
          if (!lookup.ok) return 'I could not find your appointment.';
          if (readOnly) return `Appointment ${recordId} is at ${String(lookup.record?.time)}. I have not changed it.`;
          if (!time) return 'What is your desired time?';
          if (!available.has('update_record')) return 'I cannot update this appointment because the update tool is unavailable.';
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const update = await execute('update_record', { recordId, changes: { time } });
            if (update.ok) return `Appointment ${recordId} has been moved to ${time}.`;
            if (!update.retryable) return 'I could not update this appointment; it remains unchanged.';
          }
          return 'The appointment update is temporarily unavailable; I cannot confirm a change.';
        },
        async close() { closed = true; },
      };
    },
    async userTurn({ user, messages, turn }, ctx) {
      call(ctx);
      const answer = messages.at(-1)?.content ?? '';
      if (/what is your appointment id/i.test(answer)) return { message: `My appointment ID is ${user.facts.match(/\bA\d{3}\b/)?.[0] ?? 'unknown'}.`, done: false };
      if (/what is your desired time/i.test(answer)) return { message: `My desired time is ${user.facts.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/)?.[0] ?? 'unknown'}.`, done: false };
      if (turn === 0 && /change preference once/i.test(user.behavior)) {
        return { message: `Actually, please move it to ${user.behavior.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/)?.[0]} instead.`, done: false };
      }
      return { message: '', done: true };
    },
  };
}
