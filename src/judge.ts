import { z } from 'zod';
import { fingerprint, metricApplies, metricAssessmentSchema, type CallContext, type JudgeAudit, type MetricAssessment, type Runtime } from './contracts.js';
import { ASSESS_ROLE, DATA_BOUNDARY } from './prompts.js';

const condition = z.enum(['met', 'not_met', 'unclear']);
const responseSchema = z.strictObject({ assessments: z.array(metricAssessmentSchema.omit({ result: true }).extend({
  passCondition: condition, failCondition: condition,
})).max(8) });
// Anthropic's grammar supports the object shape, but not these size/range bounds.
// The complete responseSchema above still validates every original response locally.
export const JUDGE_RESPONSE_FORMAT = { type: 'json_schema', json_schema: { name: 'agent_lab_judgment', strict: true,
  schema: JSON.parse(JSON.stringify(z.toJSONSchema(responseSchema), (key, value) =>
    ['minimum', 'maximum', 'minLength', 'maxLength', 'maxItems'].includes(key) ? undefined : value)),
} };
export const JUDGE_PROMPT = `${ASSESS_ROLE}\n${DATA_BOUNDARY}
Evaluate passCriteria and failCriteria INDEPENDENTLY against the same evidence. Report met, not_met or unclear for EACH condition. Do not choose which condition takes precedence. If both apply, preserve both as met. An unspecified scope or priority is unclear; never invent one. Explain both conditions in rationale. A condition that is not exercised is unclear, not automatically met or not_met.
Return exactly one compact JSON object, without markdown fences, matching this schema:
${JSON.stringify(z.toJSONSchema(responseSchema))}`;
export const JUDGE_PROTOCOL = fingerprint({ version: 5, prompt: JUDGE_PROMPT, responseFormat: JUDGE_RESPONSE_FORMAT, applicability: 'reactive-actor-was-called', repeatsPerMetric: 2, aggregation: 'per-metric-unanimous-exclusive-conditions', repair: false, temperature: 0, thinking: 'off', maxTokens: 16384 });
type Input = Parameters<NonNullable<Runtime['assess']>>[0];

/** This is the complete, frozen judge input. Prior verdicts, usage and run identity are deliberately absent. */
export function judgeInput(input: Input) {
  return {
    scenario: input.scenario,
    sources: input.sources.map(({ id, name, content }) => ({ id, name, content })),
    trial: { userMode: input.trial.userMode, events: input.trial.events, initialState: input.trial.initialState, finalState: input.trial.finalState },
  };
}

function parseJudgment(raw: string, input: Input, metrics: NonNullable<Input['scenario']['metrics']>): MetricAssessment[] {
  const rows = responseSchema.parse(JSON.parse(raw)).assessments;
  const ids = new Set(metrics.map(m => m.id));
  if (rows.length !== ids.size || new Set(rows.map(r => r.metricId)).size !== ids.size || rows.some(r => !ids.has(r.metricId))) {
    throw new Error('Assessment must cover every requested metric exactly once');
  }
  const events = new Set(input.trial.events.map(e => e.seq));
  return rows.map(({ passCondition, failCondition, ...row }) => {
    const result = passCondition === 'met' && failCondition === 'not_met' ? 'pass'
      : failCondition === 'met' && passCondition === 'not_met' ? 'fail' : 'unknown';
    if (row.evidence.some(seq => !events.has(seq))) throw new Error(`Assessment ${row.metricId} cites a nonexistent trace event`);
    if (result !== 'unknown' && !row.evidence.length) throw new Error(`Assessment ${row.metricId} needs trace evidence for pass/fail`);
    return { ...row, result };
  });
}

/** Historical verdicts remain readable, but incomplete or stale receipts cannot support a comparison. */
export function hasCompleteJudgment(input: Input): boolean {
  if (!input.scenario) return false;
  const metrics = input.scenario.metrics ?? [];
  if (!metrics.length) return true;
  const audit = input.trial.judgeAudit;
  if (!audit || input.trial.assessmentError) return false;
  const applicable = metrics.filter(m => metricApplies(m, input.trial));
  const data = judgeInput({ ...input, scenario: { ...input.scenario, metrics: applicable } });
  if (audit.inputHash !== fingerprint(data)) return false;
  try { if (fingerprint(JSON.parse(audit.input)) !== audit.inputHash) return false; } catch { return false; }
  const isolated = audit.attempts.some(a => a.metricId !== undefined);
  if (audit.attempts.length !== (isolated ? applicable.length * 2 : applicable.length ? 2 : 0)) return false;
  try {
    for (const attempt of audit.attempts) {
      if (attempt.error || !attempt.raw?.trim()) return false;
      const requested = isolated ? applicable.filter(m => m.id === attempt.metricId) : applicable;
      if (isolated && (requested.length !== 1 || !attempt.input
        || fingerprint(JSON.parse(attempt.input)) !== fingerprint(judgeInput({ ...input, scenario: { ...input.scenario, metrics: requested } })))) return false;
      if (fingerprint(parseJudgment(attempt.raw, input, requested)) !== fingerprint(attempt.assessments)) return false;
    }
  } catch { return false; }
  return applicable.every(m => {
    const votes = audit.attempts.filter(a => !isolated || a.metricId === m.id).map(a => a.assessments?.find(v => v.metricId === m.id)?.result);
    if (votes.length !== 2 || votes.some(v => !v)) return false;
    const result = votes.every(v => v === votes[0]) ? votes[0] : 'unknown';
    return input.trial.assessments?.find(v => v.metricId === m.id)?.result === result;
  });
}

export async function assessRepeated(input: Input, model: { provider: string; id: string; configurationHash?: string; transport?: JudgeAudit['transport'] }, ctx: CallContext,
  respond: (prompt: string, input: string, recordPartial: (raw: string) => void) => Promise<string>): Promise<MetricAssessment[]> {
  const metrics = input.scenario.metrics ?? [];
  if (!metrics.length) return [];
  // Only the harness-owned reactive fidelity rubric has this applicability rule.
  const notApplicable = metrics.filter(m => !metricApplies(m, input.trial)).map(m => m.id);
  const applicable = metrics.filter(m => !notApplicable.includes(m.id));
  const data = judgeInput({ ...input, scenario: { ...input.scenario, metrics: applicable } });
  const audit: JudgeAudit = {
    protocolHash: model.configurationHash ? fingerprint({ protocol: JUDGE_PROTOCOL, configuration: model.configurationHash }) : JUDGE_PROTOCOL,
    inputHash: fingerprint(data), provider: model.provider, model: model.id,
    ...(model.transport ? { transport: model.transport } : {}),
    prompt: JUDGE_PROMPT, input: JSON.stringify(data), attempts: [], notApplicable,
  };
  const save = () => ctx.onJudgment?.(input.trial.id, structuredClone(audit));
  save();
  for (const metric of applicable) for (let repeat = 0; repeat < 2; repeat++) {
    ctx.signal.throwIfAborted();
    const attempt: JudgeAudit['attempts'][number] = { metricId: metric.id, startedAt: new Date().toISOString(),
      input: JSON.stringify(judgeInput({ ...input, scenario: { ...input.scenario, metrics: [metric] } })),
    };
    audit.attempts.push(attempt);
    save(); // A crash leaves a visible pending request, not a missing favorable/unfavorable vote.
    try {
      attempt.raw = await respond(JUDGE_PROMPT, attempt.input!, raw => { attempt.raw = raw; save(); });
    } catch (error) {
      attempt.error = error instanceof Error ? error.message.slice(0, 4000) : 'Judge request failed';
      save();
      throw error;
    }
    save(); // Persist the original response before parsing; never repair a judgment in-place.
    try {
      attempt.assessments = parseJudgment(attempt.raw, input, [metric]);
    } catch (error) {
      attempt.error = error instanceof Error ? error.message.slice(0, 4000) : 'Invalid judgment';
    }
    save();
  }
  if (audit.attempts.some(a => a.error)) throw new Error('Judge response rejected; original responses and errors are preserved in judgeAudit');
  return metrics.map(metric => {
    if (notApplicable.includes(metric.id)) return { metricId: metric.id, result: 'unknown', evidence: [], rationale: 'Не применяется: реактивный симулятор не вызывался.' };
    const votes = audit.attempts.filter(a => a.metricId === metric.id).map(a => a.assessments![0]!);
    if (votes.every(v => v.result === votes[0]!.result)) return { ...votes[0]!, rationale: `Совпало 2/2 оценок этой рубрики в свежих сессиях; это не проверка правильности. ${votes[0]!.rationale}`.slice(0, 4000) };
    return { metricId: metric.id, result: 'unknown', evidence: [...new Set(votes.flatMap(v => v.evidence))].slice(0, 30),
      rationale: `Судья разошёлся на неизменном входе: ${votes.map(v => v.result).join(' / ')}. Основания каждой оценки сохранены в judgeAudit.` };
  });
}
