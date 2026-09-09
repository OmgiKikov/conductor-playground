import { fingerprint, type Comparison, type Experiment, type HumanReview, type Scenario, type Trial, type UserMode } from './contracts.js';

/*
 * Pure statistics over persisted records. Nothing here performs I/O or model calls,
 * so every number shown in Pi, the CLI or an export comes from one place.
 *
 *   compareTrials      trials ──pair by (scenario, repeat)──► family deltas ──► delta · bootstrap interval · sign test
 *   compareUserModes   trials ──group by userMode──► pass rate · turns · cost · failures only one mode found
 *   judgeCalibration   assessments × latest human verdicts ──► TP/TN/FP/FN per metric and check (fail = positive class)
 *   simulatorFidelity  reactive dialogues vs real dialogues ──► turn count · message length · question rate · disengagement
 *   evidenceSummary    everything above in one object, with the caveats spelled out
 */
const mean = (values: number[]): number | null => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
const graded = (trial: Trial) => trial.outcome === 'pass' || trial.outcome === 'fail';

function clusterInterval(values: number[], seed: string): [number, number] | null {
  if (values.length < 2) return null;
  let state = 2166136261;
  for (const c of seed) state = Math.imul(state ^ c.charCodeAt(0), 16777619) >>> 0;
  state ||= 1;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const means: number[] = [];
  for (let i = 0; i < 4000; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) sum += values[Math.floor(random() * values.length)]!;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [means[99]!, means[3899]!];
}

export function compareTrials(input: {
  baselineId: string; candidateId: string; manifestHash: string; scenarios: Scenario[]; repeats: number;
  trials: Trial[]; split: 'dev' | 'control'; mode: 'demo' | 'live';
}): Comparison {
  const { baselineId, candidateId, manifestHash, repeats, split } = input;
  const scenarios = input.scenarios.filter(s => s.split === split);
  const validRepeats = Number.isInteger(repeats) && repeats >= 1 && repeats <= 5;
  const result: Comparison = {
    baselineId, candidateId, manifestHash, split, plannedPairs: validRepeats ? scenarios.length * repeats : 0, validPairs: 0,
    invalidPairs: 0, families: 0, baselinePasses: 0, candidatePasses: 0, fixed: 0, regressed: 0, tied: 0,
    delta: null, interval: null, verdict: 'insufficient', reasons: [], cases: [],
  };
  if (!validRepeats) return { ...result, verdict: 'incomparable', reasons: ['Repeats must be an integer from 1 to 5.'] };
  const relevant = input.trials.filter(t => (t.revisionId === baselineId || t.revisionId === candidateId) && t.split === split);
  const scenarioMap = new Map(scenarios.map(s => [s.id, s]));
  const initialStates = new Map(scenarios.map(s => [s.id, fingerprint(s.initialState)]));
  const seenTrialIds = new Set<string>();
  const trialMap = new Map<string, Trial[]>();
  let incompatible = scenarios.length !== scenarioMap.size;
  if (incompatible) result.reasons.push('Invalid or duplicate planned cases/repeats');
  for (const trial of relevant) {
    const scenario = scenarioMap.get(trial.scenarioId);
    if (seenTrialIds.has(trial.id)) incompatible = true;
    seenTrialIds.add(trial.id);
    if (!scenario || trial.familyId !== scenario.familyId || trial.manifestHash !== manifestHash || fingerprint(trial.initialState) !== initialStates.get(trial.scenarioId)
      || !Number.isInteger(trial.repeat) || trial.repeat < 0 || trial.repeat >= repeats) {
      incompatible = true;
      continue;
    }
    const key = `${trial.revisionId}:${trial.scenarioId}:${trial.repeat}`;
    const trials = trialMap.get(key) ?? [];
    trials.push(trial);
    trialMap.set(key, trials);
    if (trials.length > 1) incompatible = true;
  }
  if (incompatible) result.reasons.push('Reused/duplicate trials, unknown cases, or mismatched manifest/family/initial-state/repeat prevent a comparable experiment');
  const families = new Map<string, number[]>();
  for (const scenario of scenarios) {
    const row = { scenarioId: scenario.id, baselinePasses: 0, candidatePasses: 0, repeats };
    const deltas: number[] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const base = trialMap.get(`${baselineId}:${scenario.id}:${repeat}`);
      const candidate = trialMap.get(`${candidateId}:${scenario.id}:${repeat}`);
      if (base?.length !== 1 || candidate?.length !== 1 || !['pass', 'fail'].includes(base[0]!.outcome) || !['pass', 'fail'].includes(candidate[0]!.outcome)) continue;
      const a = Number(base[0]!.outcome === 'pass');
      const b = Number(candidate[0]!.outcome === 'pass');
      result.validPairs += 1;
      result.baselinePasses += a;
      result.candidatePasses += b;
      row.baselinePasses += a;
      row.candidatePasses += b;
      if (b > a) result.fixed += 1;
      else if (b < a) result.regressed += 1;
      else result.tied += 1;
      deltas.push(b - a);
    }
    result.cases.push(row);
    if (deltas.length > 0) {
      const group = families.get(scenario.familyId) ?? [];
      group.push(deltas.reduce((sum, d) => sum + d, 0) / deltas.length);
      families.set(scenario.familyId, group);
    }
  }
  result.invalidPairs = result.plannedPairs - result.validPairs;
  const familyDeltas = [...families.values()].map(values => values.reduce((sum, v) => sum + v, 0) / values.length);
  result.families = familyDeltas.length;
  const positiveFamilies = familyDeltas.filter(delta => delta > 0).length;
  // With no regressions, the two-sided paired sign test has p = 2 / 2^positiveFamilies.
  const signP = positiveFamilies ? Math.min(1, 2 ** (1 - positiveFamilies)) : 1;
  if (familyDeltas.length) {
    result.delta = familyDeltas.reduce((sum, d) => sum + d, 0) / familyDeltas.length;
    result.interval = clusterInterval(familyDeltas, manifestHash);
  }
  result.reasons.push('Delta weights scenario families equally; 95% percentile interval resamples whole families. Repeats do not create independent families.');
  if (input.mode === 'demo') result.reasons.push('Scripted offline demonstration: observed repairs do not establish model quality or real-user performance.');
  else result.reasons.push('Synthetic user evidence does not establish performance with real users.');
  if (incompatible) result.verdict = 'incomparable';
  else if (result.invalidPairs > 0 || result.plannedPairs === 0) {
    result.verdict = 'insufficient';
    result.reasons.push(`${result.invalidPairs} planned pair(s) are missing, invalid, or cancelled; positive improvement claims are blocked.`);
  } else if (result.regressed > 0) {
    result.verdict = 'regressed';
    result.reasons.push('At least one previously passing trial now fails; conservative selection rejects this revision.');
  } else if (result.fixed === 0) result.verdict = 'no_change';
  else if (split === 'dev' || input.mode === 'demo' || result.families < 8 || signP > 0.05 || !result.interval || result.interval[0] <= 0) {
    result.verdict = 'insufficient';
    result.reasons.push('Observed fixes are descriptive; confirmation requires final control evaluation in live mode, at least eight independent families, a positive interval lower bound, and a two-sided paired sign-test p ≤ 0.05.');
    if (split === 'dev') result.reasons.push('Development data guides candidate selection; its uncertainty estimates are descriptive and cannot confirm an improvement independently.');
  } else {
    result.verdict = 'improved';
    result.reasons.push(`The no-regression family sign test has two-sided p = ${signP.toPrecision(3)} (ties excluded). This assumes independent case families.`);
  }
  return result;
}

export interface ModeComparison {
  userMode: UserMode; trials: number; valid: number; passed: number; passRate: number | null;
  failedChecks: string[]; uniqueFailedChecks: string[]; avgUserTurns: number | null; calls: number; costUsd: number | null;
}
/** Same cards under each user mode: what the reactive simulator finds that a static basket or a script does not. */
export function compareUserModes(record: Experiment): ModeComparison[] {
  const failedBy = new Map<UserMode, Set<string>>();
  for (const mode of record.settings.userModes) {
    failedBy.set(mode, new Set(record.trials.filter(t => t.userMode === mode).flatMap(t => t.checks.filter(c => !c.passed).map(c => c.id))));
  }
  return record.settings.userModes.map(userMode => {
    const trials = record.trials.filter(t => t.userMode === userMode);
    const valid = trials.filter(graded);
    const passed = valid.filter(t => t.outcome === 'pass').length;
    const failedChecks = [...failedBy.get(userMode)!].sort();
    const elsewhere = new Set(record.settings.userModes.filter(m => m !== userMode).flatMap(m => [...failedBy.get(m)!]));
    return {
      userMode, trials: trials.length, valid: valid.length, passed, passRate: valid.length ? passed / valid.length : null,
      failedChecks, uniqueFailedChecks: failedChecks.filter(id => !elsewhere.has(id)),
      avgUserTurns: mean(valid.map(t => t.events.filter(e => e.type === 'user').length)),
      calls: trials.reduce((sum, t) => sum + t.usage.calls, 0),
      costUsd: trials.some(t => t.usage.costUsd === null) ? null : trials.reduce((sum, t) => sum + (t.usage.costUsd ?? 0), 0),
    };
  });
}

export interface CalibrationRow {
  key: string; subject: 'agent' | 'simulator' | 'check'; n: number; tp: number; tn: number; fp: number; fn: number;
  tpr: number | null; tnr: number | null; agreement: number | null; sufficient: boolean;
}
/** The latest human verdict per review target (whole dialogue, one metric or one check); earlier verdicts on the same target are superseded. */
function latestHumanReviews(record: Experiment): Map<string, HumanReview> {
  const latest = new Map<string, HumanReview>();
  for (const review of [...record.humanReviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    latest.set(`${review.trialId}|${review.metricId ? `metric:${review.metricId}` : review.checkId ? `check:${review.checkId}` : 'dialogue'}`, review);
  }
  return latest;
}

/** Judge agreement with the latest human verdict per trial and metric/check. "fail" is the positive class, so TPR is the share of human-confirmed failures the judge caught. */
export function judgeCalibration(record: Experiment): CalibrationRow[] {
  const latest = latestHumanReviews(record);
  const rows = new Map<string, CalibrationRow>();
  const row = (key: string, subject: CalibrationRow['subject']): CalibrationRow => {
    const existing = rows.get(key);
    if (existing) return existing;
    const created: CalibrationRow = { key, subject, n: 0, tp: 0, tn: 0, fp: 0, fn: 0, tpr: null, tnr: null, agreement: null, sufficient: false };
    rows.set(key, created);
    return created;
  };
  for (const scenario of record.scenarios) {
    for (const metric of scenario.metrics ?? []) row(metric.id, metric.subject);
    for (const check of scenario.checks) row(`check:${check.id}`, 'check');
  }
  const count = (target: CalibrationRow, human: 'pass' | 'fail', model: 'pass' | 'fail') => {
    target.n += 1;
    if (human === 'fail') { if (model === 'fail') target.tp += 1; else target.fn += 1; }
    else if (model === 'fail') target.fp += 1;
    else target.tn += 1;
  };
  const decided = (review: HumanReview | undefined): review is HumanReview & { verdict: 'pass' | 'fail' } => !!review && (review.verdict === 'pass' || review.verdict === 'fail');
  for (const trial of record.trials) {
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    for (const assessment of trial.assessments ?? []) {
      const human = latest.get(`${trial.id}|metric:${assessment.metricId}`);
      if (!decided(human) || assessment.result === 'unknown') continue;
      const metric = scenario?.metrics?.find(m => m.id === assessment.metricId);
      count(row(assessment.metricId, metric?.subject ?? 'agent'), human.verdict, assessment.result);
    }
    for (const check of trial.checks) {
      const human = latest.get(`${trial.id}|check:${check.id}`);
      if (!decided(human)) continue;
      count(row(`check:${check.id}`, 'check'), human.verdict, check.passed ? 'pass' : 'fail');
    }
  }
  for (const entry of rows.values()) {
    entry.tpr = entry.tp + entry.fn ? entry.tp / (entry.tp + entry.fn) : null;
    entry.tnr = entry.tn + entry.fp ? entry.tn / (entry.tn + entry.fp) : null;
    entry.agreement = entry.n ? (entry.tp + entry.tn) / entry.n : null;
    entry.sufficient = entry.n >= 60;
  }
  return [...rows.values()];
}

export type FidelityMetric = 'userTurns' | 'userMessageLength' | 'questionRate' | 'disengagementRate';
export interface FidelityReport {
  metrics: { metric: FidelityMetric; real: number | null; simulated: number | null; gap: number | null }[];
  realDialogues: number; simulatedDialogues: number; humanFidelity: { reviewed: number; passed: number };
}
/** Descriptive gaps between reactive simulated dialogues and the supplied real ones. Small gaps do not prove fidelity; large gaps disprove it. */
export function simulatorFidelity(record: Experiment): FidelityReport | null {
  if (!record.dialogues.length) return null;
  const simulated = record.trials.filter(t => t.userMode === 'reactive' && (graded(t) || t.outcome === 'ungraded'));
  const style = (turns: string[][], disengaged: boolean[]) => turns.length ? {
    userTurns: mean(turns.map(t => t.length)),
    userMessageLength: mean(turns.flat().map(m => m.length)),
    questionRate: mean(turns.flat().map(m => m.includes('?') ? 1 : 0)),
    disengagementRate: mean(disengaged.map(d => d ? 1 : 0)),
  } : null;
  const real = style(record.dialogues.map(d => d.messages.filter(m => m.role === 'user').map(m => m.content)), record.dialogues.map(d => d.outcome === 'abandoned'));
  const sim = style(simulated.map(t => t.events.filter(e => e.type === 'user').map(e => e.text ?? '')), simulated.map(t => {
    const last = t.events.filter(e => e.type === 'simulator').at(-1)?.result as { done?: boolean } | undefined;
    return !!last?.done && t.outcome !== 'pass';
  }));
  const metrics = (['userTurns', 'userMessageLength', 'questionRate', 'disengagementRate'] as const).map(metric => {
    const r = real?.[metric] ?? null;
    const s = sim?.[metric] ?? null;
    return { metric, real: r, simulated: s, gap: r === null || s === null ? null : s - r };
  });
  const simulatorMetrics = new Set(record.scenarios.flatMap(s => (s.metrics ?? []).filter(m => m.subject === 'simulator').map(m => m.id)));
  const verdicts = record.humanReviews.filter(r => r.metricId && simulatorMetrics.has(r.metricId) && (r.verdict === 'pass' || r.verdict === 'fail'));
  return { metrics, realDialogues: record.dialogues.length, simulatedDialogues: simulated.length, humanFidelity: { reviewed: verdicts.length, passed: verdicts.filter(r => r.verdict === 'pass').length } };
}

export interface VerdictNote { code: string; text: string; count?: number; detail?: string }
export interface VerdictSummary {
  headline: string; passed: number; graded: number; invalid: number; passRate: number | null;
  /** Model rubric estimates over every completed dialogue, including those without objective checks. Unverified until humans agree. */
  rubric: { assessed: number; passed: number; failed: number; unknown: number };
  /** Completed dialogues where the model flagged the simulated user as breaking role. */
  simulatorFlagged: number;
  provenance: Record<Scenario['provenance'], { cards: number; passed: number; graded: number }>;
  weakSpots: { kind: 'check' | 'metric'; description: string; failures: number }[];
  confidence: 'low' | 'medium' | 'high'; confidenceReasons: VerdictNote[]; nextSteps: VerdictNote[];
}
/**
 * The plain-language layer: "is my agent good, and how much should I trust that?"
 * Confidence rules are deliberately simple and stated in the reasons:
 *   low     – fewer than 5 objectively graded dialogues (rubric-only runs included), or every card is synthetic, or more than a quarter of dialogues were invalid
 *   medium  – real or golden cards exist but human review is missing, not finalized, or some failed dialogues lack a decisive (pass/fail) verdict
 *   high    – review finalized, every failed dialogue carries a decisive human verdict, at least one non-synthetic card, 10+ graded dialogues, no invalid ones
 *   unknown/invalid human verdicts never decide anything; they stay listed as undecided
 */
export function verdictSummary(record: Experiment): VerdictSummary {
  const gradedTrials = record.trials.filter(graded);
  const passed = gradedTrials.filter(t => t.outcome === 'pass').length;
  const invalid = record.trials.filter(t => t.outcome === 'invalid').length;
  const gradedCount = gradedTrials.length;
  const provenance: VerdictSummary['provenance'] = { synthetic: { cards: 0, passed: 0, graded: 0 }, curated: { cards: 0, passed: 0, graded: 0 }, production: { cards: 0, passed: 0, graded: 0 } };
  for (const scenario of record.scenarios) provenance[scenario.provenance].cards += 1;
  for (const trial of gradedTrials) {
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    if (!scenario) continue;
    provenance[scenario.provenance].graded += 1;
    if (trial.outcome === 'pass') provenance[scenario.provenance].passed += 1;
  }
  // Rubric estimates cover every completed dialogue, including those without objective checks. They are model estimates, never verified results.
  const completed = record.trials.filter(t => graded(t) || t.outcome === 'ungraded');
  const checkFailures = new Map<string, number>();
  const metricFailures = new Map<string, number>();
  const rubric = { assessed: 0, passed: 0, failed: 0, unknown: 0 };
  const rubricFailed = new Set<string>();
  let simulatorFlagged = 0;
  for (const trial of completed) {
    for (const check of trial.checks) if (!check.passed) checkFailures.set(check.description, (checkFailures.get(check.description) ?? 0) + 1);
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    const subjectOf = (metricId: string) => scenario?.metrics?.find(m => m.id === metricId)?.subject ?? 'agent';
    const agentResults = (trial.assessments ?? []).filter(a => subjectOf(a.metricId) === 'agent');
    if (agentResults.length) {
      rubric.assessed += 1;
      if (agentResults.some(a => a.result === 'fail')) { rubric.failed += 1; rubricFailed.add(trial.id); }
      else if (agentResults.some(a => a.result === 'unknown')) rubric.unknown += 1;
      else rubric.passed += 1;
    }
    if ((trial.assessments ?? []).some(a => subjectOf(a.metricId) === 'simulator' && a.result === 'fail')) simulatorFlagged += 1;
    for (const assessment of agentResults) if (assessment.result === 'fail') {
      const name = scenario?.metrics?.find(m => m.id === assessment.metricId)?.name ?? assessment.metricId;
      metricFailures.set(name, (metricFailures.get(name) ?? 0) + 1);
    }
  }
  const weakSpots = [
    ...[...checkFailures].map(([description, failures]) => ({ kind: 'check' as const, description, failures })),
    ...[...metricFailures].map(([description, failures]) => ({ kind: 'metric' as const, description, failures })),
  ].sort((a, b) => b.failures - a.failures).slice(0, 3);
  const allSynthetic = provenance.curated.cards + provenance.production.cards === 0;
  const humanVerdicts = record.humanReviews.length > 0;
  // Only the latest verdict per target counts, and only pass/fail decides anything; unknown and invalid record that a person looked and could not confirm the result.
  const decisive = (r: HumanReview) => r.verdict === 'pass' || r.verdict === 'fail';
  const current = [...latestHumanReviews(record).values()];
  const decisiveVerdicts = current.some(decisive);
  const finalized = !!record.resultsReviewedAt;
  // A failed dialogue is one that failed objectively or by the agent rubrics; every one of them needs a decisive human verdict before the result is trusted.
  const failedTrials = completed.filter(t => t.outcome === 'fail' || rubricFailed.has(t.id));
  const reviewsFor = (trialId: string) => current.filter(r => r.trialId === trialId);
  const unreviewed = failedTrials.filter(t => reviewsFor(t.id).length === 0).length;
  const undecided = failedTrials.filter(t => { const reviews = reviewsFor(t.id); return reviews.length > 0 && !reviews.some(decisive); }).length;
  const reasons: VerdictNote[] = [];
  if (gradedCount === 0 && rubric.assessed === 0) reasons.push({ code: 'none_graded', text: 'No graded dialogues yet.' });
  else if (gradedCount === 0) reasons.push({ code: 'rubric_only', text: 'Only model rubric estimates, no objective checks; nothing here is verified by code.' });
  else if (gradedCount < 5) reasons.push({ code: 'few_graded', text: `Only ${gradedCount} graded dialogue(s); too few to judge the agent.`, count: gradedCount });
  if (invalid) reasons.push({ code: 'invalid', text: `${invalid} dialogue(s) were invalid and could not measure the agent.`, count: invalid });
  if (allSynthetic) reasons.push({ code: 'all_synthetic', text: 'All cards are synthetic; nothing here comes from real users or a reviewed golden set.' });
  if (simulatorFlagged) reasons.push({ code: 'simulator_flagged', text: `The model flagged ${simulatorFlagged} dialogue(s) where the simulated user may have broken role.`, count: simulatorFlagged });
  if (!humanVerdicts) reasons.push({ code: 'no_human', text: 'No human verdicts yet; model estimates are unchecked.' });
  else if (!decisiveVerdicts) reasons.push({ code: 'no_decisive_verdicts', text: 'Human verdicts so far are all unknown or invalid; nothing has been confirmed or refuted.' });
  else if (!finalized) reasons.push({ code: 'not_finalized', text: 'Human review of the results is not finalized.' });
  else {
    if (unreviewed) reasons.push({ code: 'unreviewed_failures', text: `${unreviewed} failed dialogue(s) have no human verdict.`, count: unreviewed });
    if (undecided) reasons.push({ code: 'undecided_failures', text: `${undecided} failed dialogue(s) carry only unknown or invalid human verdicts.`, count: undecided });
  }
  const invalidShare = record.trials.length ? invalid / record.trials.length : 0;
  const confidence: VerdictSummary['confidence'] = gradedCount < 5 || allSynthetic || invalidShare > 0.25 ? 'low'
    : finalized && decisiveVerdicts && unreviewed === 0 && undecided === 0 && gradedCount >= 10 && invalid === 0 ? 'high' : 'medium';
  const nextSteps: VerdictNote[] = [];
  if (gradedCount === 0 && rubric.assessed === 0) nextSteps.push({ code: 'approve_and_run', text: 'Approve the cards in /agent-lab and run the dialogues.' });
  if (allSynthetic) nextSteps.push({ code: 'add_real_data', text: 'Add golden cases or real dialogues so the result does not rest on synthetic cards alone.' });
  const awaiting = unreviewed + undecided;
  if (awaiting) nextSteps.push({ code: 'record_verdicts', text: `Open the ${awaiting} failed dialogue(s) without a decisive human verdict (pass or fail) in /agent-lab and record your verdicts.`, count: awaiting });
  if (record.target.kind === 'sandbox') nextSteps.push({ code: 'connect_agent', text: 'Point target at your own agent (http or module) to test the agent you ship.' });
  if (weakSpots[0]) nextSteps.push({ code: 'fix_weakest', text: `Start with the weakest spot: ${weakSpots[0].description} (${weakSpots[0].failures} failures).`, detail: weakSpots[0].description, count: weakSpots[0].failures });
  if (gradedCount > 0 && gradedCount < 10) nextSteps.push({ code: 'run_more', text: `Run more cards or repeats; ${gradedCount} graded dialogue(s) is a small sample.`, count: gradedCount });
  const passRate = gradedCount ? passed / gradedCount : null;
  const estimates = rubric.assessed ? ` ${record.mode === 'demo' ? 'Scripted demo estimates' : 'Model estimates'} (unverified): ${rubric.passed} of ${rubric.assessed} dialogues passed all agent rubrics.` : '';
  const headline = gradedCount ? `${passed} of ${gradedCount} graded dialogues passed (${Math.round((passRate ?? 0) * 100)}%). Confidence ${confidence}.${estimates}`
    : rubric.assessed ? `No objective checks.${estimates} Confidence ${confidence}.` : 'No graded dialogues yet.';
  return { headline, passed, graded: gradedCount, invalid, passRate, rubric, simulatorFlagged, provenance, weakSpots, confidence, confidenceReasons: reasons, nextSteps };
}

export interface EvidenceSummary {
  verdict: VerdictSummary;
  comparison: { observed: string; status: string } | null;
  modes: ModeComparison[]; calibration: CalibrationRow[]; fidelity: FidelityReport | null; notes: string[];
}
/** The one object every surface renders: the plain verdict first, observed numbers next, then what they cannot yet support. */
export function evidenceSummary(record: Experiment): EvidenceSummary {
  const final = record.comparisons.findLast(c => c.split === 'control');
  const fmt = (n: number | null) => n === null ? 'unknown' : n.toFixed(2);
  const comparison = final ? {
    observed: `Candidate fixed ${final.fixed} of ${final.validPairs} valid pairs (${final.plannedPairs} planned) with ${final.regressed} regression(s); family-weighted delta ${fmt(final.delta)}${final.interval ? ` (95% interval ${fmt(final.interval[0])} to ${fmt(final.interval[1])})` : ''} across ${final.families} declared families.`,
    status: `Verdict ${final.verdict}: ${final.reasons[0] ?? 'no reason recorded'}`,
  } : null;
  const modes = compareUserModes(record);
  const calibration = judgeCalibration(record);
  const fidelity = simulatorFidelity(record);
  const notes: string[] = [];
  const thin = calibration.filter(r => r.n > 0 && !r.sufficient).map(r => r.key);
  if (thin.length) notes.push(`Judge calibration has fewer than 60 labeled pairs for: ${thin.join(', ')}. Treat model estimates as provisional.`);
  if (calibration.length && calibration.every(r => r.n === 0)) notes.push('No human verdicts on metrics or checks yet; judge agreement is unknown.');
  if (!fidelity) notes.push('No real dialogues supplied; simulator fidelity cannot be estimated.');
  else if (!fidelity.simulatedDialogues) notes.push('No completed reactive dialogues yet; simulator fidelity gaps are not available.');
  notes.push(...record.limitations.filter(l => l.startsWith('Scripted mode skipped')));
  const reactive = modes.find(m => m.userMode === 'reactive');
  if (record.settings.userModes.length > 1 && reactive?.uniqueFailedChecks.length) notes.push(`Only the reactive simulator exposed failing checks: ${reactive.uniqueFailedChecks.join(', ')}.`);
  return { verdict: verdictSummary(record), comparison, modes, calibration, fidelity, notes };
}
