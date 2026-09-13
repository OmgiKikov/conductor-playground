import { z } from 'zod';
import { assessmentEventContent, assessmentFindingSchema, validateAssessments, type MetricAssessment, type Rubric, type Scenario, type Source, type Trial } from './contracts.js';

export const judgeResponseSchema = z.strictObject({ findings: z.array(assessmentFindingSchema).min(1).max(12) });

/** One rubric per isolated call; previous scores, human labels and version names are deliberately absent. */
export function judgeInput(metric: Rubric, scenario: Scenario, sources: Source[], trial: Trial) {
  return {
    rubric: metric,
    task: { goal: scenario.user.goal, successCriteria: scenario.successCriteria,
      user: trial.userMode === 'static' ? { ...scenario.user, script: [], maxFollowUps: 0 } : scenario.user },
    evaluationScope: trial.userMode === 'static'
      ? 'Opening and first answer ONLY. Planned follow-ups were not delivered. Never penalize the agent for their absence.'
      : 'Evaluate only requests delivered in the events, within the rubric stage. Planned or private user facts are not delivered requests.',
    sources: sources.map(({ id, name, content }) => ({ id, name, content })),
    // Definitions express the contract; outcomes are not supplied as hints to the model grader.
    checks: scenario.checks,
    trial: { userMode: trial.userMode, observation: trial.observation ?? { state: 'missing', tools: 'partial' },
      initialState: trial.initialState,
      finalState: trial.observation && trial.observation.state !== 'missing' ? trial.finalState : null,
      events: trial.events.map(event => ({ seq: event.seq, type: event.type, content: assessmentEventContent(event) })) },
  };
}

/** Validate quoted evidence and reduce the findings in code. A supported failure cannot be averaged away. */
export function judgeAssessment(metric: Rubric, trial: Trial, raw: unknown): MetricAssessment {
  const { findings } = judgeResponseSchema.parse(raw);
  const result = findings.some(f => f.result === 'fail') ? 'fail' : findings.some(f => f.result === 'unknown') ? 'unknown' : 'pass';
  const assessment = { metricId: metric.id, result, findings,
    rationale: findings.map(f => `[${f.result}] ${f.criterion}: ${f.rationale}`).join('\n').slice(0, 4000),
    evidence: [...new Set(findings.flatMap(f => f.citations.map(c => c.seq)))] };
  return validateAssessments([metric], trial.events, [assessment])[0]!;
}
