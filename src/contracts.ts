import { createHash } from 'node:crypto';
import { z } from 'zod';

export const VERSION = '3';
export const DEFAULT_JUDGE = { provider: 'openrouter', model: 'openai/gpt-5.6-sol', upstream: 'openai' } as const;
export const TOOL_NAMES = ['search_materials', 'lookup_record', 'update_record'] as const;
export type ToolName = typeof TOOL_NAMES[number];
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'Reserved identifier');
const text = z.string().trim().min(1);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
export const scalarSchema = z.union([z.string().max(8000), z.number().finite(), z.boolean(), z.null()]);
export const agentSchema = z.strictObject({
  name: text.max(120),
  instructions: text.max(24000),
  tools: z.array(z.enum(TOOL_NAMES)).max(3).refine(unique, 'Duplicate tools'),
});
export type AgentSpec = z.infer<typeof agentSchema>;
export const materialSchema = z.strictObject({ name: text.max(180), content: text.max(120000) });

/*
 * How the simulated user's side of a dialogue is produced:
 *   reactive  – a model plays the user card and answers the target's actual replies
 *   scripted  – user.script lines are sent in order, ignoring the target's replies
 *   static    – only the opening message; the dialogue ends after the first reply
 * Running the same cards in all three modes measures what the reactive simulator adds.
 */
export const userModeSchema = z.enum(['reactive', 'scripted', 'static']);
export type UserMode = z.infer<typeof userModeSchema>;
export const settingsSchema = z.strictObject({
  provider: z.string().max(120).default(''),
  model: z.string().max(200).default(''),
  judge: z.strictObject({ provider: z.string().min(1).max(120), model: z.string().min(1).max(200), upstream: z.string().min(1).max(120).optional() })
    .refine(v => !v.upstream || v.provider === 'openrouter', 'Judge upstream routing requires OpenRouter').optional(),
  repeats: z.number().int().min(1).max(5).default(2),
  maxIterations: z.number().int().min(1).max(5).default(2),
  maxTurns: z.number().int().min(2).max(16).default(6),
  maxCalls: z.number().int().min(5).max(3000).default(300),
  timeoutMs: z.number().int().min(1000).max(120000).default(120000),
  maxDurationMs: z.number().int().min(5000).max(3600000).default(600000),
  userModes: z.array(userModeSchema).min(1).max(3).refine(unique, 'Duplicate user modes').default(['reactive']),
});
export type Settings = z.infer<typeof settingsSchema>;
// A patch must never materialize defaults for keys the caller did not send.
const settingsPatchSchema = z.strictObject({
  provider: settingsSchema.shape.provider.removeDefault(), model: settingsSchema.shape.model.removeDefault(),
  judge: settingsSchema.shape.judge,
  repeats: settingsSchema.shape.repeats.removeDefault(), maxIterations: settingsSchema.shape.maxIterations.removeDefault(),
  maxTurns: settingsSchema.shape.maxTurns.removeDefault(), maxCalls: settingsSchema.shape.maxCalls.removeDefault(),
  timeoutMs: settingsSchema.shape.timeoutMs.removeDefault(), maxDurationMs: settingsSchema.shape.maxDurationMs.removeDefault(),
  userModes: settingsSchema.shape.userModes.removeDefault(),
}).partial();

/*
 * Who answers the simulated user. The sandbox target is a nested Pi session with trusted tools.
 * External targets speak a JSON contract (see targets.ts); their secrets stay in environment variables.
 */
export const targetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sandbox') }),
  z.strictObject({
    kind: z.literal('http'), url: z.string().url().max(2000),
    headersEnv: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/, 'Invalid header name'), z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/, 'Header values must name environment variables')).default({}),
    timeoutMs: z.number().int().min(1000).max(600000).default(60000),
  }),
  z.strictObject({
    kind: z.literal('module'), path: z.string().min(1).max(4000).refine(p => p.startsWith('/'), 'Absolute path required'),
    exportName: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/).default('createSession'),
    timeoutMs: z.number().int().min(1000).max(600000).optional(),
  }),
  /** A local process (for example `python3 agent.py`) speaking one JSON request/reply per line over stdin/stdout. */
  z.strictObject({
    kind: z.literal('command'), command: z.string().min(1).max(4000), args: z.array(z.string().max(4000)).max(50).default([]),
    cwd: z.string().min(1).max(4000).refine(p => p.startsWith('/'), 'Absolute path required').optional(),
    timeoutMs: z.number().int().min(1000).max(600000).default(60000),
  }),
]);
export type Target = z.infer<typeof targetSchema>;

export interface Source { id: string; name: string; content: string; hash: string }
export const requirementSchema = z.strictObject({
  id: identifier, text: text.max(2000), sourceId: identifier, quote: text.max(3000), critical: z.boolean(),
});
export type Requirement = z.infer<typeof requirementSchema>;
export const worldSchema = z.strictObject({
  records: z.record(identifier, z.record(identifier, scalarSchema)).refine(v => Object.keys(v).length <= 30, 'Too many records'),
  writableFields: z.array(identifier).max(16),
  transientFailures: z.number().int().min(0).max(2).default(0),
});
export type World = z.infer<typeof worldSchema>;
/**
 * Which job of the agent this criterion is about. A dialogue is a chain of jobs — understand
 * the request, look things up, act, compose the answer, validate it — and a single end-to-end
 * verdict cannot say which link broke. The label changes nothing in measurement and everything
 * in diagnosis: results are grouped by it. Optional, because a one-step agent has one job.
 */
const stage = { stage: text.max(80).optional() };
const checkBase = { id: identifier, description: text.max(1000), ...stage };
const toolIdentifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:/-]{0,199}$/);
export const checkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...checkBase, kind: z.literal('state_equals'), recordId: identifier, field: identifier, value: scalarSchema }),
  z.strictObject({ ...checkBase, kind: z.literal('tool_called'), tool: toolIdentifier }),
  z.strictObject({ ...checkBase, kind: z.literal('tool_not_called'), tool: toolIdentifier }),
  z.strictObject({ ...checkBase, kind: z.literal('tool_count'), tool: toolIdentifier, min: z.number().int().min(0).max(1000), max: z.number().int().min(0).max(1000) }),
  z.strictObject({ ...checkBase, kind: z.literal('fresh_read_before_update') }),
  z.strictObject({ ...checkBase, kind: z.literal('answer_contains'), value: text.max(1000) }),
  /** The last assistant reply must match exactly; whitespace, case and newlines are significant. */
  z.strictObject({ ...checkBase, kind: z.literal('answer_equals'), value: z.string().min(1).max(8000) }),
  /** Wording that must never reach the user: internal instructions, staff-only phrasing, forbidden promises. */
  z.strictObject({ ...checkBase, kind: z.literal('answer_omits'), value: text.max(1000) }),
]);
export type Check = z.infer<typeof checkSchema>;
export function describeCheck(check: Check): string {
  if (check.kind === 'state_equals') return `${check.recordId}.${check.field} = ${JSON.stringify(check.value)} в конце диалога`;
  if (check.kind === 'answer_equals') return `Последний ответ в точности: ${JSON.stringify(check.value)}`;
  if (check.kind === 'answer_contains') return `В ответах есть: ${JSON.stringify(check.value)} (без учёта регистра)`;
  if (check.kind === 'answer_omits') return `В ответах нет: ${JSON.stringify(check.value)} (без учёта регистра)`;
  if (check.kind === 'tool_called') return `Есть вызов ${check.tool}`;
  if (check.kind === 'tool_not_called') return `Нет вызовов ${check.tool}`;
  if (check.kind === 'tool_count') return `${check.tool}: от ${check.min} до ${check.max} попыток вызова`;
  return 'Перед каждым изменением — успешное чтение той же записи';
}
export const rubricSchema = z.strictObject({
  id: identifier, name: text.max(120), subject: z.enum(['agent', 'simulator']),
  description: text.max(2000), passCriteria: text.max(2000), failCriteria: text.max(2000), ...stage,
});
export type Rubric = z.infer<typeof rubricSchema>;
export const simulatorFidelity: Rubric = {
  id: 'user_fidelity', name: 'Верность симулятора', subject: 'simulator',
  description: 'Соблюдение заданных фактов, цели, поведения и лимита реплик; персона и характеристики учитываются только если заданы.',
  passCriteria: 'Пользователь следует карточке, отвечает на необходимые уточнения только известными фактами и соблюдает каждое условие остановки. Если карточка требует закончить после достаточной инструкции, дальнейших реплик нет. Не оценивает агента и не выдумывает его ответы или результаты инструментов.',
  failCriteria: 'Пользователь придумывает факты, знает скрытые ответы или состояние, меняет роль, оценивает агента, пропускает обязательное уточнение или продолжает разговор вопреки карточке. Новый вопрос после достаточной инструкции нарушает требование закончить, даже если все сообщённые факты верны. Неудача агента сама по себе не является провалом симулятора.',
};
export const metricAssessmentSchema = z.strictObject({
  metricId: identifier, result: z.enum(['pass', 'fail', 'unknown']),
  rationale: text.max(4000), evidence: z.array(z.number().int().nonnegative()).max(30),
});
export type MetricAssessment = z.infer<typeof metricAssessmentSchema>;
/** The fixed opening belongs to the card, not to the reactive actor. */
export function metricApplies(metric: Rubric, trial: Pick<Trial, 'userMode' | 'events'>): boolean {
  return metric.id !== 'user_fidelity' || metric.subject !== 'simulator'
    || trial.userMode === 'reactive' && trial.events.some(event => event.type === 'simulator');
}
export const judgeAuditSchema = z.strictObject({
  protocolHash: text, inputHash: text, provider: text, model: text,
  transport: z.strictObject({ api: text, upstream: text.optional(), structured: z.boolean() }).optional(),
  prompt: text, input: text,
  attempts: z.array(z.strictObject({
    metricId: identifier.optional(), input: text.optional(),
    startedAt: text, raw: z.string().optional(), error: text.optional(),
    assessments: z.array(metricAssessmentSchema).optional(),
  })).max(16),
  notApplicable: z.array(identifier),
});
export type JudgeAudit = z.infer<typeof judgeAuditSchema>;
export const userSchema = z.strictObject({
  goal: text.max(3000), facts: text.max(5000), behavior: text.max(2000), opening: text.max(3000),
  maxFollowUps: z.number().int().min(0).max(15).optional(),
  persona: text.max(2000).optional(), characteristics: z.array(text.max(300)).max(12).optional(),
  script: z.array(z.string().min(1).max(3000).refine(v => !!v.trim(), 'Empty user message')).max(15).optional()
    .describe('Follow-up messages AFTER opening, never include opening itself. [] means opening only. Every line must fit maxFollowUps and maxTurns.'),
});
/**
 * The rung a card occupies. smoke: the basics that must never break, whatever else changes.
 * regression: behaviour that already works and must not get worse. frontier: what the product
 * is still climbing towards, where failures are expected and informative. One flat suite hides
 * the difference between "we broke the product" and "we have not got there yet".
 */
export const tierSchema = z.enum(['smoke', 'regression', 'frontier']);
export type Tier = z.infer<typeof tierSchema>;
export const scenarioSchema = z.strictObject({
  id: identifier, familyId: identifier, title: text.max(200),
  requirementIds: z.array(identifier).max(20),
  provenance: z.enum(['synthetic', 'curated', 'production']),
  tier: tierSchema.default('regression'),
  profileId: identifier.optional(),
  user: userSchema, initialState: worldSchema,
  checks: z.array(checkSchema).max(12),
  successCriteria: text.max(3000).optional(), assumptions: z.array(text.max(1000)).max(12).optional(),
  metrics: z.array(rubricSchema).max(8).optional(),
});
export type Scenario = z.infer<typeof scenarioSchema> & { split: 'dev' | 'control' };

/** Validate the conversation we will actually send, before spending any target calls. */
export function scriptIssue(user: Scenario['user'], maxTurns: number): string | undefined {
  const available = Math.min(user.maxFollowUps ?? maxTurns - 1, maxTurns - 1);
  if (user.script && user.script.length > available) {
    return `Скрипт содержит ${user.script.length} продолжения, но лимит допускает ${available}. script содержит только реплики после opening; уберите повтор первой реплики или увеличьте лимит.`;
  }
}

/*
 * Real data supplied by the owner:
 *   Dialogue    – a de-identified production conversation; grounds user profiles and fidelity metrics
 *   Profile     – observed persona/characteristics extracted from dialogues, with evidence IDs
 *   GoldenCase  – a human-reviewed test case; becomes a curated scenario without model generation
 */
export const dialogueSchema = z.strictObject({
  id: identifier, goal: text.max(3000).optional(),
  messages: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), content: text.max(8000) })).min(1).max(60),
  outcome: z.enum(['success', 'failure', 'abandoned', 'unknown']).default('unknown'),
});
export type Dialogue = z.infer<typeof dialogueSchema>;
const profileFields = {
  id: identifier, persona: text.max(2000).optional(), characteristics: z.array(text.max(300)).max(12).default([]),
  observedStyle: text.max(2000).optional(), evidenceDialogueIds: z.array(identifier).max(50).default([]),
};
const profileOverrideSchema = z.strictObject({ persona: text.max(2000).nullable().optional(), characteristics: z.array(text.max(300)).max(12).optional() })
  .refine(v => Object.keys(v).length > 0, 'Supply a profile change');
/** Extractors cannot impersonate an owner or supply draft edits. */
export const observedProfileSchema = z.strictObject({ ...profileFields, source: z.literal('observed').default('observed'), evidenceDialogueIds: z.array(identifier).min(1).max(50) });
export const profileSchema = z.strictObject({ ...profileFields, source: z.enum(['observed', 'owner']).default('observed'), draftOverride: profileOverrideSchema.optional() })
  .refine(p => p.source === 'owner' || p.evidenceDialogueIds.length > 0, { message: 'Observed profiles need evidence dialogue IDs', path: ['evidenceDialogueIds'] });
export type Profile = z.infer<typeof profileSchema>;
/** Original evidence remains immutable; null explicitly removes the persona from linked cards. */
export function profileUser(profile: Profile): Pick<Scenario['user'], 'persona' | 'characteristics'> {
  const persona = profile.draftOverride?.persona !== undefined ? profile.draftOverride.persona : profile.persona;
  return { ...(persona ? { persona } : {}), characteristics: [...(profile.draftOverride?.characteristics ?? profile.characteristics)] };
}
/** Profiles the owner writes by hand: a legitimate way to describe users when no dialogues exist. Synthetic, and labelled so. */
export const ownerProfileSchema = z.strictObject({ ...profileFields, source: z.literal('owner').default('owner') });
export const goldenCaseSchema = z.strictObject({
  id: identifier, familyId: identifier.optional(), title: text.max(200).optional(), tier: tierSchema.default('regression'),
  goal: text.max(3000), opening: text.max(3000),
  facts: text.max(5000).default('No additional facts beyond the opening request.'), persona: text.max(2000).optional(),
  characteristics: z.array(text.max(300)).max(12).default([]),
  behavior: text.max(2000).default('Ask once; answer clarifications from the known facts; finish when the request is answered.'),
  script: z.array(text.max(3000)).max(15).optional(), maxFollowUps: z.number().int().min(0).max(15).default(1),
  successCriteria: text.max(3000), initialState: worldSchema.default({ records: {}, writableFields: [], transientFailures: 0 }),
  checks: z.array(checkSchema).max(12).default([]), metrics: z.array(rubricSchema).max(8).default([]),
});
export type GoldenCase = z.infer<typeof goldenCaseSchema>;
export function goldenToScenario(c: GoldenCase): Omit<Scenario, 'split'> {
  return {
    id: c.id, familyId: c.familyId ?? c.id, title: c.title ?? c.goal.slice(0, 200), requirementIds: [], provenance: 'curated', tier: c.tier,
    user: {
      goal: c.goal, facts: c.facts, behavior: c.behavior, opening: c.opening, maxFollowUps: c.maxFollowUps,
      ...(c.persona ? { persona: c.persona } : {}), ...(c.characteristics.length ? { characteristics: c.characteristics } : {}), ...(c.script ? { script: c.script } : {}),
    },
    initialState: c.initialState, checks: c.checks, successCriteria: c.successCriteria,
    assumptions: ['Curated golden case supplied by the owner; not generated by a model.'], metrics: c.metrics,
  };
}

/*
 * ObservedGoal: what a real user actually tried to do, extracted from production dialogues.
 * The opening is the real user's own message, verbatim; it becomes a production card without model-written text.
 */
export const observedGoalSchema = z.strictObject({
  id: identifier, goal: text.max(3000), opening: text.max(3000), profileId: identifier.optional(),
  evidenceDialogueIds: z.array(identifier).min(1).max(50), successCriteria: text.max(3000),
  facts: text.max(5000).default('Only what the real user revealed in the evidence dialogues.'),
  outcome: z.enum(['success', 'failure', 'abandoned', 'unknown']).default('unknown'),
});
export type ObservedGoal = z.infer<typeof observedGoalSchema>;
export function validateObservedGoals(goals: ObservedGoal[], dialogues: Dialogue[], profiles: Profile[]): void {
  if (!unique(goals.map(g => g.id))) throw new Error('Observed goals have duplicate IDs');
  const byId = new Map(dialogues.map(d => [d.id, d]));
  for (const goal of goals) {
    if (goal.profileId !== undefined && !profiles.some(p => p.id === goal.profileId)) throw new Error(`Observed goal ${goal.id} references an unknown profileId ${goal.profileId}`);
    const evidence = goal.evidenceDialogueIds.map(id => byId.get(id));
    if (evidence.some(d => !d)) throw new Error(`Observed goal ${goal.id} cites a dialogue that was not supplied`);
    if (!evidence.some(d => d!.messages.some(m => m.role === 'user' && m.content.trim() === goal.opening.trim()))) {
      throw new Error(`Observed goal ${goal.id} opening is not a verbatim user message from its evidence dialogues`);
    }
  }
}
export function goalToScenario(goal: ObservedGoal, profile?: Profile): Omit<Scenario, 'split'> {
  return {
    id: goal.id, familyId: goal.id, title: goal.goal.slice(0, 200), requirementIds: [], provenance: 'production', tier: 'regression', profileId: goal.profileId,
    user: {
      goal: goal.goal, facts: goal.facts, opening: goal.opening, maxFollowUps: 2,
      behavior: 'Behave like the real user in the evidence dialogues: answer clarifications from the known facts, stop when the goal is reached or clearly blocked.',
      ...(profile ? profileUser(profile) : {}),
    },
    initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [], successCriteria: goal.successCriteria,
    assumptions: [`Derived from a real dialogue (${goal.evidenceDialogueIds.join(', ')}); the opening is the real user's first message and the success criteria were inferred from the logged outcome (${goal.outcome}).`],
    metrics: [
      { id: 'goal_attainment', name: 'Goal attainment', subject: 'agent', description: 'Did the user get what they came for, as the real user would judge it.', passCriteria: 'The stated goal is reached or the user is told clearly and correctly why it cannot be.', failCriteria: 'The goal is not reached and no correct explanation is given, or the answer contradicts the success criteria.' },
      { id: 'perimeter', name: 'Stays within the agent perimeter', subject: 'agent', description: 'The agent answers only what it is meant to answer and grounds answers in its materials.', passCriteria: 'Answers stay within the described perimeter and materials; out-of-scope requests are declined or redirected.', failCriteria: 'The agent answers outside its perimeter, invents facts, or fails to decline an out-of-scope request.' },
      { ...simulatorFidelity },
    ],
  };
}

export const createInputSchema = z.strictObject({
  task: text.max(8000),
  materials: z.array(materialSchema).min(1).max(12),
  mode: z.enum(['demo', 'live']),
  settings: settingsSchema.default(() => settingsSchema.parse({})),
  existingAgent: agentSchema.optional(),
  workflow: z.enum(['evaluate', 'compare']).default('evaluate'),
  /** 0 means: run only the owner's own cards and generate nothing. */
  scenarioCount: z.number().int().min(0).max(10).default(5),
  target: targetSchema.default({ kind: 'sandbox' }),
  targetVersion: text.max(200).optional(),
  goldenCases: z.array(goldenCaseSchema).max(40).default([]),
  dialogues: z.array(dialogueSchema).max(200).default([]),
  /** The owner's own hints about users, goals and situations. First-class input for cards; never a business rule. */
  notes: z.string().trim().max(8000).default(''),
  profiles: z.array(ownerProfileSchema).max(6).default([]),
}).superRefine((v, ctx) => {
  if (v.materials.reduce((n, m) => n + m.content.length, 0) > 300000) ctx.addIssue({ code: 'custom', message: 'Materials exceed 300,000 characters', path: ['materials'] });
  if (v.dialogues.reduce((n, d) => n + d.messages.reduce((m, x) => m + x.content.length, 0), 0) > 2000000) ctx.addIssue({ code: 'custom', message: 'Dialogues exceed 2,000,000 characters', path: ['dialogues'] });
  if (!unique(v.dialogues.map(d => d.id))) ctx.addIssue({ code: 'custom', message: 'Duplicate dialogue IDs', path: ['dialogues'] });
  if (!unique(v.goldenCases.map(g => g.id))) ctx.addIssue({ code: 'custom', message: 'Duplicate golden case IDs', path: ['goldenCases'] });
  if (v.scenarioCount === 0 && !v.goldenCases.length && !v.dialogues.length) {
    ctx.addIssue({ code: 'custom', message: 'scenarioCount 0 needs golden cases or production dialogues to have anything to run', path: ['scenarioCount'] });
  }
  if (!unique(v.profiles.map(p => p.id))) ctx.addIssue({ code: 'custom', message: 'Duplicate profile IDs', path: ['profiles'] });
});
export type CreateInput = z.infer<typeof createInputSchema>;

export const preparationSchema = z.strictObject({
  requirements: z.array(requirementSchema).min(1).max(30),
  questions: z.array(text.max(2000)).max(12),
  agent: agentSchema,
  scenarios: z.array(scenarioSchema).max(40),
});
export interface Preparation {
  requirements: Requirement[]; questions: string[]; agent: AgentSpec; scenarios: Scenario[];
}
export interface Revision { id: string; parentId: string | null; spec: AgentSpec; hypothesis: string; createdAt: string }
export type Outcome = 'pass' | 'fail' | 'ungraded' | 'invalid' | 'cancelled';
export interface Usage { calls: number; inputTokens: number; outputTokens: number; costUsd: number | null }
export const emptyUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
export interface TraceEvent {
  seq: number; type: 'user' | 'assistant' | 'simulator' | 'tool_call' | 'tool_result' | 'error';
  text?: string; tool?: string; args?: unknown; result?: unknown; state?: World;
}
export interface CheckResult { id: string; description: string; passed: boolean; evidence: string }
export interface Trial {
  id: string; revisionId: string; scenarioId: string; familyId: string; repeat: number; userMode: UserMode;
  split: 'dev' | 'control'; manifestHash: string; outcome: Outcome; reason: string;
  checks: CheckResult[]; events: TraceEvent[]; initialState: World; finalState: World;
  usage: Usage; elapsedMs: number;
  assessments?: MetricAssessment[]; assessmentError?: string; judgeAudit?: JudgeAudit;
}
export interface Comparison {
  baselineId: string; candidateId: string; manifestHash: string; split: 'dev' | 'control';
  plannedPairs: number; validPairs: number; invalidPairs: number; families: number;
  baselinePasses: number; candidatePasses: number; fixed: number; regressed: number; tied: number;
  delta: number | null; interval: [number, number] | null;
  verdict: 'improved' | 'regressed' | 'no_change' | 'insufficient' | 'incomparable';
  reasons: string[]; cases: { scenarioId: string; baselinePasses: number; candidatePasses: number; repeats: number }[];
}
export const humanReviewInputSchema = z.strictObject({
  trialId: identifier, metricId: identifier.optional(), checkId: identifier.optional(),
  verdict: z.enum(['pass', 'fail', 'unknown', 'invalid']), note: text.max(3000),
}).refine(v => !(v.metricId && v.checkId), 'Review either one metric, one check, or the whole trial');
export type HumanReviewInput = z.infer<typeof humanReviewInputSchema>;
export type HumanReview = HumanReviewInput & { id: string; createdAt: string };
export const draftPatchSchema = z.strictObject({
  /** Full cards to update or add by id. Omitted cards are always preserved. */
  scenarios: z.array(scenarioSchema.extend({ split: z.enum(['dev', 'control']).optional() })).min(1).max(40)
    .refine(cards => unique(cards.map(card => card.id)), 'Повторяются идентификаторы изменяемых карточек.').optional(),
  removeScenarioIds: z.array(identifier).min(1).max(40)
    .refine(unique, 'Повторяются идентификаторы удаляемых карточек.').optional(),
  profileEdits: z.array(z.strictObject({ id: identifier, override: profileOverrideSchema.nullable() })).min(1).max(12)
    .refine(edits => unique(edits.map(e => e.id)), 'Duplicate profile edits').optional(),
  agent: agentSchema.optional(), settings: settingsPatchSchema.optional(),
  target: targetSchema.optional(), targetVersion: text.max(200).optional(),
}).refine(v => Object.keys(v).length > 0, 'Supply a draft change')
  .refine(v => !v.scenarios?.some(card => v.removeScenarioIds?.includes(card.id)), 'Нельзя одновременно изменить и удалить одну карточку.');
export type DraftPatch = z.infer<typeof draftPatchSchema>;
export type Phase = 'preparing' | 'review' | 'evaluating' | 'results_review' | 'baseline' | 'improving' | 'control' | 'complete' | 'cancelled' | 'error' | 'interrupted';
export interface Experiment {
  schemaVersion: '1'; id: string; task: string; mode: 'demo' | 'live'; workflow: 'evaluate' | 'compare';
  createdAt: string; updatedAt: string; phase: Phase; message: string;
  sources: Source[]; settings: Settings; target: Target; requirements: Requirement[]; questions: string[];
  goldenCases: GoldenCase[]; dialogues: Dialogue[]; profiles: Profile[]; notes: string;
  scenarios: Scenario[]; revisions: Revision[]; selectedRevisionId: string | null;
  manifestHash: string | null; reviewedAt: string | null; reviewMode: 'human' | 'automated' | null; controlConsumedAt: string | null;
  trials: Trial[]; comparisons: Comparison[]; iterations: { revisionId: string; accepted: boolean; reason: string }[];
  usage: Usage; error: string | null; limitations: string[];
  humanReviews: HumanReview[]; resultsReviewedAt?: string; resultsReviewHash?: string;
  /** Named clusters over the failed dialogues of this run; the bridge from evaluation to fixing. */
  failureModes?: FailureMode[];
  parentRunId?: string;
  selectedScenarioIds?: string[];
  targetVersion?: string;
  targetFingerprint?: string;
}
const usageSchema = z.strictObject({ calls: z.number().int().nonnegative(), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), costUsd: z.number().finite().nonnegative().nullable() });
const revisionSchema = z.strictObject({ id: text, parentId: text.nullable(), spec: agentSchema, hypothesis: z.string(), createdAt: text });
const trialSchema = z.strictObject({
  id: identifier, revisionId: text, scenarioId: identifier, familyId: identifier, repeat: z.number().int().nonnegative(),
  userMode: userModeSchema.default('reactive'),
  split: z.enum(['dev', 'control']), manifestHash: text, outcome: z.enum(['pass', 'fail', 'ungraded', 'invalid', 'cancelled']), reason: z.string(),
  checks: z.array(z.strictObject({ id: identifier, description: z.string(), passed: z.boolean(), evidence: z.string() })),
  events: z.array(z.strictObject({ seq: z.number().int().nonnegative(), type: z.enum(['user', 'assistant', 'simulator', 'tool_call', 'tool_result', 'error']), text: z.string().optional(), tool: z.string().max(200).optional(), args: z.unknown().optional(), result: z.unknown().optional(), state: worldSchema.optional() })),
  initialState: worldSchema, finalState: worldSchema, usage: usageSchema, elapsedMs: z.number().finite().nonnegative(),
  assessments: z.array(metricAssessmentSchema).max(8).optional(), assessmentError: z.string().max(4000).optional(),
  judgeAudit: judgeAuditSchema.optional(),
});
const comparisonSchema = z.strictObject({
  baselineId: text, candidateId: text, manifestHash: text, split: z.enum(['dev', 'control']),
  plannedPairs: z.number().int().nonnegative(), validPairs: z.number().int().nonnegative(), invalidPairs: z.number().int().nonnegative(), families: z.number().int().nonnegative(),
  baselinePasses: z.number().int().nonnegative(), candidatePasses: z.number().int().nonnegative(), fixed: z.number().int().nonnegative(), regressed: z.number().int().nonnegative(), tied: z.number().int().nonnegative(),
  delta: z.number().finite().nullable(), interval: z.tuple([z.number().finite(), z.number().finite()]).nullable(),
  verdict: z.enum(['improved', 'regressed', 'no_change', 'insufficient', 'incomparable']), reasons: z.array(z.string()),
  cases: z.array(z.strictObject({ scenarioId: identifier, baselinePasses: z.number().int().nonnegative(), candidatePasses: z.number().int().nonnegative(), repeats: z.number().int().nonnegative() })),
});
/** Files written by older versions load with defaults; the in-memory type is always complete. */
/*
 * FailureMode: a named cluster of dialogues that broke the same way. "Bad answer" is not a
 * failure mode; "found the article and still handed the client to the hotline" is. Naming the
 * failure precisely is what turns an evaluation into an improvement loop, so every cluster
 * must cite the dialogues it was drawn from and may name the stage where the chain broke.
 * Clusters cover the traces of this run only; they are not a picture of production traffic.
 */
export const failureModeSchema = z.strictObject({
  id: identifier, name: text.max(160), description: text.max(2000),
  stage: text.max(80).optional(), trialIds: z.array(identifier).min(1).max(200),
});
export type FailureMode = z.infer<typeof failureModeSchema>;
export function validateFailureModes(modes: FailureMode[], trials: Trial[]): void {
  const failed = new Set(trials.filter(t => t.outcome === 'fail' || t.outcome === 'ungraded'
    || t.outcome === 'pass' && t.assessments?.some(a => a.result === 'fail')).map(t => t.id));
  if (!unique(modes.map(m => m.id))) throw new Error('Названия провалов повторяются.');
  for (const mode of modes) {
    if (!unique(mode.trialIds)) throw new Error(`Кластер ${mode.id} ссылается на один диалог дважды.`);
    const unknown = mode.trialIds.filter(id => !failed.has(id));
    if (unknown.length) throw new Error(`Кластер ${mode.id} ссылается на диалоги, которые не проваливались: ${unknown.join(', ')}`);
  }
}

export const experimentSchema: z.ZodType<Experiment> = z.strictObject({
  schemaVersion: z.literal('1'), id: identifier, task: text.max(8000), mode: z.enum(['demo', 'live']), createdAt: text, updatedAt: text,
  workflow: z.enum(['evaluate', 'compare']).default('compare'),
  phase: z.enum(['preparing', 'review', 'evaluating', 'results_review', 'baseline', 'improving', 'control', 'complete', 'cancelled', 'error', 'interrupted']), message: z.string(),
  sources: z.array(z.strictObject({ id: identifier, name: text, content: text, hash: text })).max(12), settings: settingsSchema,
  target: targetSchema.default({ kind: 'sandbox' }),
  requirements: z.array(requirementSchema), questions: z.array(z.string()), scenarios: z.array(scenarioSchema.extend({ split: z.enum(['dev', 'control']) })),
  goldenCases: z.array(goldenCaseSchema).max(40).default([]), dialogues: z.array(dialogueSchema).max(200).default([]), profiles: z.array(profileSchema).max(12).default([]),
  notes: z.string().max(8000).default(''),
  revisions: z.array(revisionSchema), selectedRevisionId: text.nullable(), manifestHash: text.nullable(), reviewedAt: text.nullable(), reviewMode: z.enum(['human', 'automated']).nullable().default(null), controlConsumedAt: text.nullable(),
  trials: z.array(trialSchema), comparisons: z.array(comparisonSchema), iterations: z.array(z.strictObject({ revisionId: text, accepted: z.boolean(), reason: z.string() })),
  usage: usageSchema, error: z.string().nullable(), limitations: z.array(z.string()),
  humanReviews: z.array(z.strictObject({
    id: identifier, createdAt: text, trialId: identifier, metricId: identifier.optional(), checkId: identifier.optional(),
    verdict: z.enum(['pass', 'fail', 'unknown', 'invalid']), note: text.max(3000),
  })).default([]), resultsReviewedAt: text.optional(), resultsReviewHash: text.optional(),
  failureModes: z.array(failureModeSchema).max(30).optional(),
  parentRunId: identifier.optional(), selectedScenarioIds: z.array(identifier).min(1).max(40).optional(), targetVersion: text.max(200).optional(), targetFingerprint: text.optional(),
});
export interface CallContext {
  signal: AbortSignal; timeoutMs: number;
  beforeCall(): void;
  addUsage(usage: Omit<Usage, 'calls'>): void;
  onTrace?(trialId: string, event: TraceEvent): void;
  onTargetEvent?(event: Omit<TraceEvent, 'seq'>): void;
  onJudgment?(trialId: string, audit: JudgeAudit): void;
}
export interface Tool {
  name: ToolName; description: string; parameters: Record<string, unknown>;
  execute(args: unknown): Promise<unknown>;
}
export interface DialogueMessage { role: 'user' | 'assistant'; content: string }
export interface TargetSession { respond(message: string): Promise<string>; close(): Promise<void> }
export const userTurnSchema = z.strictObject({ done: z.boolean(), message: z.string().max(6000) }).refine(v => v.done || v.message.trim().length > 0, 'Empty user message');
export type UserTurn = z.infer<typeof userTurnSchema>;
export interface PrepareInput {
  task: string; sources: Source[]; existingAgent?: AgentSpec; workflow?: 'evaluate' | 'compare'; scenarioCount?: number;
  profiles?: Profile[]; goldenCases?: GoldenCase[]; notes?: string; observedGoals?: ObservedGoal[];
  /** The sandbox agent is only built when the sandbox answers; an external target has its own. */
  targetKind?: Target['kind'];
}
export interface ImproveInput {
  task: string; sources: Source[]; requirements: Requirement[]; agent: AgentSpec;
  feedback: { scenario: Scenario; trials: Trial[] }[];
}
export const proposalSchema = z.strictObject({ agent: agentSchema, hypothesis: text.max(3000) });
export interface Runtime {
  prepare(input: PrepareInput, ctx: CallContext): Promise<z.infer<typeof preparationSchema>>;
  improve(input: ImproveInput, ctx: CallContext): Promise<z.infer<typeof proposalSchema>>;
  openTarget(agent: AgentSpec, sources: Source[], tools: Tool[], ctx: CallContext): Promise<TargetSession>;
  userTurn(input: { user: Scenario['user']; messages: DialogueMessage[]; turn: number }, ctx: CallContext): Promise<UserTurn>;
  assess?(input: { scenario: Scenario; sources: Source[]; trial: Trial }, ctx: CallContext): Promise<MetricAssessment[]>;
  profiles?(input: { task: string; sources: Source[]; dialogues: Dialogue[] }, ctx: CallContext): Promise<Profile[]>;
  goals?(input: { task: string; sources: Source[]; dialogues: Dialogue[]; profiles: Profile[] }, ctx: CallContext): Promise<ObservedGoal[]>;
  failureModes?(input: { task: string; failures: { trialId: string; card: string; reason: string; failed: string[]; trace: string }[] }, ctx: CallContext): Promise<FailureMode[]>;
}

/** Stable JSON content identity; array order remains significant. */
export function fingerprint(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, normalize(x)])) : v;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

export function validatePreparation(raw: unknown, sources: Source[], workflow: 'evaluate' | 'compare' = 'compare', profiles: Profile[] = []): Preparation {
  const p = preparationSchema.parse(raw);
  if (!p.scenarios.length) throw new Error('No cards to run: supply golden cases or ask for generated ones');
  const requireUnique = (values: string[], name: string) => {
    if (!unique(values)) throw new Error(`Duplicate ${name}`);
  };
  requireUnique(p.requirements.map(r => r.id), 'requirement IDs');
  requireUnique(p.scenarios.map(s => s.id), 'scenario IDs');
  for (const r of p.requirements) {
    const source = sources.find(s => s.id === r.sourceId);
    if (!source?.content.includes(r.quote)) throw new Error(`Requirement ${r.id} has an ungrounded source quote`);
  }
  const families = [...new Set(p.scenarios.map(s => s.familyId))].sort();
  if (workflow === 'compare' && families.length < 4) throw new Error('At least four distinct scenario families are required');
  const control = new Set(families.filter((_, i) => i % 2 === 1));
  for (const s of p.scenarios) {
    const synthetic = s.provenance === 'synthetic';
    if (synthetic && !s.requirementIds.length) throw new Error(`Scenario ${s.id} needs at least one grounded requirement`);
    if (s.profileId !== undefined && !profiles.some(profile => profile.id === s.profileId)) throw new Error(`Scenario ${s.id} references an unknown profileId`);
    if (s.profileId !== undefined) {
      const profile = profiles.find(candidate => candidate.id === s.profileId)!;
      delete s.user.persona;
      Object.assign(s.user, profileUser(profile));
    }
    if (workflow === 'evaluate' && (!s.successCriteria || s.user.maxFollowUps === undefined)) {
      throw new Error(`Scenario ${s.id} needs success criteria and an explicit follow-up limit`);
    }
    requireUnique(s.checks.map(c => c.id), 'check IDs');
    requireUnique((s.metrics ?? []).map(m => m.id), 'metric IDs');
    if (!s.checks.length && !s.metrics?.length) throw new Error(`Scenario ${s.id} has no evaluation criteria`);
    if (s.requirementIds.some(id => !p.requirements.some(r => r.id === id))) throw new Error(`Unknown requirement in ${s.id}`);
    const states = new Map<string, unknown>();
    const calls = new Map<string, { min: number; max: number }>();
    const phrases = new Map<string, boolean>();
    let exactAnswer: string | undefined;
    for (const c of s.checks) {
      if (c.kind === 'state_equals') {
        const key = `${c.recordId}.${c.field}`;
        if (states.has(key) && !Object.is(states.get(key), c.value)) throw new Error(`Contradictory state checks in ${s.id}`);
        states.set(key, c.value);
      } else if (c.kind === 'answer_contains' || c.kind === 'answer_omits') {
        const required = c.kind === 'answer_contains';
        const seen = phrases.get(c.value.toLocaleLowerCase());
        if (seen !== undefined && seen !== required) throw new Error(`Contradictory answer checks in ${s.id}`);
        phrases.set(c.value.toLocaleLowerCase(), required);
      } else if (c.kind === 'answer_equals') {
        if (exactAnswer !== undefined && exactAnswer !== c.value) throw new Error(`Contradictory exact answer checks in ${s.id}`);
        exactAnswer = c.value;
      } else if (c.kind === 'tool_called' || c.kind === 'tool_not_called' || c.kind === 'tool_count') {
        const before = calls.get(c.tool) ?? { min: 0, max: Infinity };
        const min = Math.max(before.min, c.kind === 'tool_count' ? c.min : c.kind === 'tool_called' ? 1 : 0);
        const max = Math.min(before.max, c.kind === 'tool_count' ? c.max : c.kind === 'tool_not_called' ? 0 : Infinity);
        if (min > max) throw new Error(`Contradictory tool checks in ${s.id}`);
        calls.set(c.tool, { min, max });
      }
    }
    if (exactAnswer !== undefined && [...phrases].some(([phrase, required]) => !required && exactAnswer.toLocaleLowerCase().includes(phrase))) {
      throw new Error(`Exact answer contains forbidden wording in ${s.id}`);
    }
    for (const c of s.checks) if (c.kind === 'state_equals') {
      const record = s.initialState.records[c.recordId];
      if (!record || !Object.hasOwn(record, c.field)) throw new Error(`Invalid expected state in ${s.id}`);
      if (!Object.is(record[c.field], c.value) && !s.initialState.writableFields.includes(c.field)) throw new Error(`Unreachable expected state in ${s.id}`);
      if (!Object.is(record[c.field], c.value) && calls.get('update_record')?.max === 0) throw new Error(`Contradictory update prohibition in ${s.id}`);
    }
  }
  if (workflow === 'compare') for (const r of p.requirements) if (r.critical && !p.scenarios.some(s => s.requirementIds.includes(r.id))) throw new Error(`Critical requirement ${r.id} has no test coverage`);
  return { ...p, scenarios: p.scenarios.map(s => ({ ...s, split: workflow === 'compare' && control.has(s.familyId) ? 'control' : 'dev' })) };
}
