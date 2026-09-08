import { createHash } from 'node:crypto';
import { z } from 'zod';

export const VERSION = '2';
export const TOOL_NAMES = ['search_materials', 'lookup_record', 'update_record'] as const;
export type ToolName = typeof TOOL_NAMES[number];
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'Reserved identifier');
const text = z.string().trim().min(1);
export const scalarSchema = z.union([z.string().max(8000), z.number().finite(), z.boolean(), z.null()]);
export const agentSchema = z.strictObject({
  name: text.max(120),
  instructions: text.max(24000),
  tools: z.array(z.enum(TOOL_NAMES)).max(3).refine(v => new Set(v).size === v.length, 'Duplicate tools'),
});
export type AgentSpec = z.infer<typeof agentSchema>;
export const materialSchema = z.strictObject({ name: text.max(180), content: text.max(120000) });
export const settingsSchema = z.strictObject({
  provider: z.string().max(120).default(''),
  model: z.string().max(200).default(''),
  repeats: z.number().int().min(1).max(5).default(2),
  maxIterations: z.number().int().min(1).max(5).default(2),
  maxTurns: z.number().int().min(2).max(16).default(6),
  maxCalls: z.number().int().min(5).max(3000).default(300),
  timeoutMs: z.number().int().min(1000).max(120000).default(120000),
  maxDurationMs: z.number().int().min(5000).max(3600000).default(600000),
});
export type Settings = z.infer<typeof settingsSchema>;
export const createInputSchema = z.strictObject({
  task: text.max(8000),
  materials: z.array(materialSchema).min(1).max(12),
  mode: z.enum(['demo', 'live']),
  settings: settingsSchema.default(() => settingsSchema.parse({})),
  existingAgent: agentSchema.optional(),
  workflow: z.enum(['evaluate', 'compare']).default('evaluate'),
  scenarioCount: z.number().int().min(1).max(10).default(5),
}).refine(v => v.materials.reduce((n, m) => n + m.content.length, 0) <= 300000, 'Materials exceed 300,000 characters');
export type CreateInput = z.infer<typeof createInputSchema>;
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
const checkBase = { id: identifier, description: text.max(1000) };
export const checkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...checkBase, kind: z.literal('state_equals'), recordId: identifier, field: identifier, value: scalarSchema }),
  z.strictObject({ ...checkBase, kind: z.literal('tool_called'), tool: z.enum(TOOL_NAMES) }),
  z.strictObject({ ...checkBase, kind: z.literal('tool_not_called'), tool: z.enum(TOOL_NAMES) }),
  z.strictObject({ ...checkBase, kind: z.literal('tool_count'), tool: z.enum(TOOL_NAMES), min: z.number().int().min(0).max(1000), max: z.number().int().min(0).max(1000) }),
  z.strictObject({ ...checkBase, kind: z.literal('fresh_read_before_update') }),
  z.strictObject({ ...checkBase, kind: z.literal('answer_contains'), value: text.max(1000) }),
]);
export type Check = z.infer<typeof checkSchema>;
export const rubricSchema = z.strictObject({
  id: identifier, name: text.max(120), subject: z.enum(['agent', 'simulator']),
  description: text.max(2000), passCriteria: text.max(2000), failCriteria: text.max(2000),
});
export type Rubric = z.infer<typeof rubricSchema>;
export const metricAssessmentSchema = z.strictObject({
  metricId: identifier, result: z.enum(['pass', 'fail', 'unknown']),
  rationale: text.max(4000), evidence: z.array(z.number().int().nonnegative()).max(30),
});
export type MetricAssessment = z.infer<typeof metricAssessmentSchema>;
export const userSchema = z.strictObject({
  goal: text.max(3000), facts: text.max(5000), behavior: text.max(2000), opening: text.max(3000),
  maxFollowUps: z.number().int().min(0).max(15).optional(),
  persona: text.max(2000).optional(), characteristics: z.array(text.max(300)).max(12).optional(),
});
export const scenarioSchema = z.strictObject({
  id: identifier, familyId: identifier, title: text.max(200),
  requirementIds: z.array(identifier).min(1).max(20),
  provenance: z.enum(['synthetic', 'curated']),
  user: userSchema, initialState: worldSchema,
  checks: z.array(checkSchema).max(12),
  successCriteria: text.max(3000).optional(), assumptions: z.array(text.max(1000)).max(12).optional(),
  metrics: z.array(rubricSchema).max(8).optional(),
});
export type Scenario = z.infer<typeof scenarioSchema> & { split: 'dev' | 'control' };
export const preparationSchema = z.strictObject({
  requirements: z.array(requirementSchema).min(1).max(30),
  questions: z.array(text.max(2000)).max(12),
  agent: agentSchema,
  scenarios: z.array(scenarioSchema).min(1).max(40),
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
  id: string; revisionId: string; scenarioId: string; familyId: string; repeat: number;
  split: 'dev' | 'control'; manifestHash: string; outcome: Outcome; reason: string;
  checks: CheckResult[]; events: TraceEvent[]; initialState: World; finalState: World;
  usage: Usage; elapsedMs: number;
  assessments?: MetricAssessment[]; assessmentError?: string;
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
  scenarios: z.array(scenarioSchema.extend({ split: z.enum(['dev', 'control']).optional() })).min(1).max(40).optional(),
  agent: agentSchema.optional(), settings: settingsSchema.partial().optional(),
}).refine(v => Object.keys(v).length > 0, 'Supply a draft change');
export type DraftPatch = z.infer<typeof draftPatchSchema>;
export type Phase = 'preparing' | 'review' | 'evaluating' | 'results_review' | 'baseline' | 'improving' | 'control' | 'complete' | 'cancelled' | 'error' | 'interrupted';
export interface Experiment {
  schemaVersion: '1'; id: string; task: string; mode: 'demo' | 'live';
  createdAt: string; updatedAt: string; phase: Phase; message: string;
  sources: Source[]; settings: Settings; requirements: Requirement[]; questions: string[];
  scenarios: Scenario[]; revisions: Revision[]; selectedRevisionId: string | null;
  manifestHash: string | null; reviewedAt: string | null; reviewMode: 'human' | 'automated' | null; controlConsumedAt: string | null;
  trials: Trial[]; comparisons: Comparison[]; iterations: { revisionId: string; accepted: boolean; reason: string }[];
  usage: Usage; error: string | null; limitations: string[];
  workflow?: 'evaluate' | 'compare'; humanReviews?: HumanReview[];
  resultsReviewedAt?: string; resultsReviewHash?: string;
}
const usageSchema = z.strictObject({ calls: z.number().int().nonnegative(), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), costUsd: z.number().finite().nonnegative().nullable() });
const revisionSchema = z.strictObject({ id: text, parentId: text.nullable(), spec: agentSchema, hypothesis: z.string(), createdAt: text });
const trialSchema = z.strictObject({
  id: identifier, revisionId: text, scenarioId: identifier, familyId: identifier, repeat: z.number().int().nonnegative(),
  split: z.enum(['dev', 'control']), manifestHash: text, outcome: z.enum(['pass', 'fail', 'ungraded', 'invalid', 'cancelled']), reason: z.string(),
  checks: z.array(z.strictObject({ id: identifier, description: z.string(), passed: z.boolean(), evidence: z.string() })),
  events: z.array(z.strictObject({ seq: z.number().int().nonnegative(), type: z.enum(['user', 'assistant', 'simulator', 'tool_call', 'tool_result', 'error']), text: z.string().optional(), tool: z.string().max(200).optional(), args: z.unknown().optional(), result: z.unknown().optional(), state: worldSchema.optional() })),
  initialState: worldSchema, finalState: worldSchema, usage: usageSchema, elapsedMs: z.number().finite().nonnegative(),
  assessments: z.array(metricAssessmentSchema).max(8).optional(), assessmentError: z.string().max(4000).optional(),
});
const comparisonSchema = z.strictObject({
  baselineId: text, candidateId: text, manifestHash: text, split: z.enum(['dev', 'control']),
  plannedPairs: z.number().int().nonnegative(), validPairs: z.number().int().nonnegative(), invalidPairs: z.number().int().nonnegative(), families: z.number().int().nonnegative(),
  baselinePasses: z.number().int().nonnegative(), candidatePasses: z.number().int().nonnegative(), fixed: z.number().int().nonnegative(), regressed: z.number().int().nonnegative(), tied: z.number().int().nonnegative(),
  delta: z.number().finite().nullable(), interval: z.tuple([z.number().finite(), z.number().finite()]).nullable(),
  verdict: z.enum(['improved', 'regressed', 'no_change', 'insufficient', 'incomparable']), reasons: z.array(z.string()),
  cases: z.array(z.strictObject({ scenarioId: identifier, baselinePasses: z.number().int().nonnegative(), candidatePasses: z.number().int().nonnegative(), repeats: z.number().int().nonnegative() })),
});
export const experimentSchema: z.ZodType<Experiment> = z.strictObject({
  schemaVersion: z.literal('1'), id: identifier, task: text.max(8000), mode: z.enum(['demo', 'live']), createdAt: text, updatedAt: text,
  phase: z.enum(['preparing', 'review', 'evaluating', 'results_review', 'baseline', 'improving', 'control', 'complete', 'cancelled', 'error', 'interrupted']), message: z.string(),
  sources: z.array(z.strictObject({ id: identifier, name: text, content: text, hash: text })).max(12), settings: settingsSchema,
  requirements: z.array(requirementSchema), questions: z.array(z.string()), scenarios: z.array(scenarioSchema.extend({ split: z.enum(['dev', 'control']) })),
  revisions: z.array(revisionSchema), selectedRevisionId: text.nullable(), manifestHash: text.nullable(), reviewedAt: text.nullable(), reviewMode: z.enum(['human', 'automated']).nullable().default(null), controlConsumedAt: text.nullable(),
  trials: z.array(trialSchema), comparisons: z.array(comparisonSchema), iterations: z.array(z.strictObject({ revisionId: text, accepted: z.boolean(), reason: z.string() })),
  usage: usageSchema, error: z.string().nullable(), limitations: z.array(z.string()),
  workflow: z.enum(['evaluate', 'compare']).optional(),
  humanReviews: z.array(z.strictObject({
    id: identifier, createdAt: text, trialId: identifier, metricId: identifier.optional(), checkId: identifier.optional(),
    verdict: z.enum(['pass', 'fail', 'unknown', 'invalid']), note: text.max(3000),
  })).optional(), resultsReviewedAt: text.optional(), resultsReviewHash: text.optional(),
});
export interface CallContext {
  signal: AbortSignal; timeoutMs: number;
  beforeCall(): void;
  addUsage(usage: Omit<Usage, 'calls'>): void;
  onTrace?(trialId: string, event: TraceEvent): void;
  onTargetEvent?(event: Omit<TraceEvent, 'seq'>): void;
}
export interface Tool {
  name: ToolName; description: string; parameters: Record<string, unknown>;
  execute(args: unknown): Promise<unknown>;
}
export interface DialogueMessage { role: 'user' | 'assistant'; content: string }
export interface TargetSession { respond(message: string): Promise<string>; close(): Promise<void> }
export const userTurnSchema = z.strictObject({ message: z.string().max(6000), done: z.boolean() }).refine(v => v.done || v.message.trim().length > 0, 'Empty user message');
export type UserTurn = z.infer<typeof userTurnSchema>;
export interface PrepareInput { task: string; sources: Source[]; existingAgent?: AgentSpec; workflow?: 'evaluate' | 'compare'; scenarioCount?: number }
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
}

/** Stable JSON content identity; array order remains significant. */
export function fingerprint(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, normalize(x)])) : v;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

export function validatePreparation(raw: unknown, sources: Source[], workflow: 'evaluate' | 'compare' = 'compare'): Preparation {
  const p = preparationSchema.parse(raw);
  const unique = (values: string[], name: string) => {
    if (new Set(values).size !== values.length) throw new Error(`Duplicate ${name}`);
  };
  unique(p.requirements.map(r => r.id), 'requirement IDs');
  unique(p.scenarios.map(s => s.id), 'scenario IDs');
  for (const r of p.requirements) {
    const source = sources.find(s => s.id === r.sourceId);
    if (!source?.content.includes(r.quote)) throw new Error(`Requirement ${r.id} has an ungrounded source quote`);
  }
  const families = [...new Set(p.scenarios.map(s => s.familyId))].sort();
  if (workflow === 'compare' && families.length < 4) throw new Error('At least four distinct scenario families are required');
  const control = new Set(families.filter((_, i) => i % 2 === 1));
  for (const s of p.scenarios) {
    if (workflow === 'evaluate' && (!s.successCriteria || !s.user.persona || !s.user.characteristics || s.user.maxFollowUps === undefined)) {
      throw new Error(`Scenario ${s.id} needs success criteria, a persona, characteristics and an explicit follow-up limit`);
    }
    unique(s.checks.map(c => c.id), 'check IDs');
    unique((s.metrics ?? []).map(m => m.id), 'metric IDs');
    if (!s.checks.length && !s.metrics?.length) throw new Error(`Scenario ${s.id} has no evaluation criteria`);
    if (s.requirementIds.some(id => !p.requirements.some(r => r.id === id))) throw new Error(`Unknown requirement in ${s.id}`);
    const states = new Map<string, unknown>();
    const calls = new Map<string, { min: number; max: number }>();
    for (const c of s.checks) {
      if (c.kind === 'state_equals') {
        const key = `${c.recordId}.${c.field}`;
        if (states.has(key) && !Object.is(states.get(key), c.value)) throw new Error(`Contradictory state checks in ${s.id}`);
        states.set(key, c.value);
      } else if (c.kind === 'tool_called' || c.kind === 'tool_not_called' || c.kind === 'tool_count') {
        const before = calls.get(c.tool) ?? { min: 0, max: Infinity };
        const min = Math.max(before.min, c.kind === 'tool_count' ? c.min : c.kind === 'tool_called' ? 1 : 0);
        const max = Math.min(before.max, c.kind === 'tool_count' ? c.max : c.kind === 'tool_not_called' ? 0 : Infinity);
        if (min > max) throw new Error(`Contradictory tool checks in ${s.id}`);
        calls.set(c.tool, { min, max });
      }
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
