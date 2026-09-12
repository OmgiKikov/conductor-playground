import { fingerprint, type Comparison, type Experiment, type HumanReview, type Scenario, type Tier, type Trial, type UserMode } from './contracts.js';

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
const runningPhases = new Set(['preparing', 'evaluating', 'baseline', 'improving', 'control']);

/** Legacy optimization runs contain several agents; their headline describes only the selected version. */
export function observedRecord(record: Experiment): Experiment {
  if (record.workflow !== 'compare') return record;
  const split = record.controlConsumedAt && !runningPhases.has(record.phase) ? 'control' : 'dev';
  const selected = record.selectedRevisionId ?? record.revisions[0]?.id;
  const trials = record.trials.filter(t => t.revisionId === selected && t.split === split);
  const ids = new Set(trials.map(t => t.id));
  return { ...record, trials, scenarios: record.scenarios.filter(s => s.split === split), humanReviews: record.humanReviews.filter(r => ids.has(r.trialId)) };
}

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
/** Descriptive differences only, restricted to measured counterparts of the same trial. */
export function compareUserModes(record: Experiment): ModeComparison[] {
  record = observedRecord(record);
  const reviews = latestHumanReviews(record);
  const usable = (t: Trial) => measured(t) && reviews.get(`${t.id}|dialogue`)?.verdict !== 'invalid'
    && !record.scenarios.find(s => s.id === t.scenarioId)?.metrics?.some(m => m.subject === 'simulator'
      && t.assessments?.some(a => a.metricId === m.id && a.result !== 'pass'));
  const criteria = (t: Trial) => new Map<string, 'pass' | 'fail' | 'unknown'>([
    ...t.checks.map(c => [`${t.scenarioId}/check:${c.id}`, c.passed ? 'pass' : 'fail'] as const),
    ...(record.scenarios.find(s => s.id === t.scenarioId)?.metrics ?? []).filter(m => m.subject === 'agent')
      .map(m => [`${t.scenarioId}/metric:${m.id}`, t.assessments?.find(a => a.metricId === m.id)?.result ?? 'unknown'] as const),
  ]);
  const key = (t: Trial, mode = t.userMode) => `${t.revisionId}|${t.scenarioId}|${t.repeat}|${mode}`;
  const paired = new Map<string, Trial[]>();
  for (const t of record.trials) paired.set(key(t), [...paired.get(key(t)) ?? [], t]);
  const failedBy = new Map<UserMode, Set<string>>();
  for (const mode of record.settings.userModes) {
    failedBy.set(mode, new Set(record.trials.filter(t => t.userMode === mode && usable(t))
      .flatMap(t => [...criteria(t)].filter(([, result]) => result === 'fail').map(([id]) => id))));
  }
  return record.settings.userModes.map(userMode => {
    const trials = record.trials.filter(t => t.userMode === userMode);
    const valid = trials.filter(graded);
    const passed = valid.filter(t => t.outcome === 'pass').length;
    const failedChecks = [...failedBy.get(userMode)!].sort();
    const others = record.settings.userModes.filter(m => m !== userMode);
    const uniqueFailedChecks = failedChecks.filter(id => others.length > 0 && others.every(mode =>
      !failedBy.get(mode)!.has(id) && trials.filter(t => criteria(t).has(id)).every(t => {
        const matches = paired.get(key(t, mode)) ?? [];
        return usable(t) && paired.get(key(t))?.length === 1 && matches.length === 1
          && usable(matches[0]!) && criteria(matches[0]!).get(id) === 'pass';
      })));
    return {
      userMode, trials: trials.length, valid: valid.length, passed, passRate: valid.length ? passed / valid.length : null,
      failedChecks, uniqueFailedChecks,
      avgUserTurns: mean(trials.filter(measured).map(t => t.events.filter(e => e.type === 'user').length)),
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
  const trials = new Set(record.trials.map(t => t.id));
  for (const review of [...record.humanReviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!trials.has(review.trialId)) continue;
    latest.set(`${review.trialId}|${review.metricId ? `metric:${review.metricId}` : review.checkId ? `check:${review.checkId}` : 'dialogue'}`, review);
  }
  return latest;
}

/** Judge agreement with the latest human verdict per trial and metric/check. "fail" is the positive class, so TPR is the share of human-confirmed failures the judge caught. */
export function judgeCalibration(record: Experiment): CalibrationRow[] {
  record = observedRecord(record);
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
  record = observedRecord(record);
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
  const verdicts = [...latestHumanReviews(record).values()].filter(r => r.metricId && simulatorMetrics.has(r.metricId) && (r.verdict === 'pass' || r.verdict === 'fail'));
  return { metrics, realDialogues: record.dialogues.length, simulatedDialogues: simulated.length, humanFidelity: { reviewed: verdicts.length, passed: verdicts.filter(r => r.verdict === 'pass').length } };
}

export interface VerdictNote { code: string; text: string; count?: number; detail?: string }
export interface HumanFinding {
  trialId: string; reviewId: string; target: string; subject: 'agent' | 'simulator' | 'check' | 'test';
  verdict: 'pass' | 'fail' | 'invalid'; automatic: 'pass' | 'fail' | 'unknown'; disagreement: boolean; note: string;
}
export interface RepeatResult {
  scenarioId: string; title: string; userMode: UserMode; planned: number; passed: number; failed: number; unknown: number;
  status: 'single' | 'mixed' | 'all_pass' | 'all_fail' | 'incomplete'; trialIds: string[];
}
export function humanFindingText(finding: HumanFinding): string {
  const label = { pass: 'пройдено', fail: 'не пройдено', unknown: 'неясно', invalid: 'невалидный тест' };
  return `${finding.subject === 'test' ? 'Тест' : finding.subject === 'simulator' ? 'Симулятор' : finding.subject === 'check' ? 'Кодовая проверка' : 'Агент'} · ${finding.target}: человек — ${label[finding.verdict]}, автоматически — ${label[finding.automatic]}.${finding.disagreement ? ' Расхождение оценок.' : ''} ${finding.note}`;
}
export function repeatResultText(row: RepeatResult): string {
  const label = { single: 'одна попытка', mixed: 'разные результаты', all_pass: 'все повторы пройдены', all_fail: 'все повторы провалены', incomplete: 'неполные данные' };
  return `${row.title} · ${row.userMode}: ${row.passed}/${row.planned} пройдено, ${row.failed} провалов, ${row.unknown} без оценки — ${label[row.status]}.`;
}
export interface VerdictSummary {
  headline: string; passed: number; graded: number; invalid: number; passRate: number | null;
  execution: { planned: number; completed: number; invalid: number; cancelled: number; missing: number; running: boolean };
  /** reviewed counts resolved whole-dialogue classifications, including invalid tests. */
  review: { status: 'not_started' | 'pending' | 'complete'; pending: number; reviewed: number; total: number;
    passed: number; failed: number; invalid: number; flagged: number; disagreements: number; findings: HumanFinding[] };
  repeats: RepeatResult[];
  /** Model rubric estimates over every completed dialogue, including those without objective checks. Unverified until humans agree. */
  rubric: { assessed: number; passed: number; failed: number; unknown: number };
  /** Completed dialogues where the model flagged the simulated user as breaking role. */
  simulatorFlagged: number;
  provenance: Record<Scenario['provenance'], { cards: number; passed: number; graded: number }>;
  /** Per job of the agent: which link of the chain broke, not just whether the chain broke. */
  stages: { stage: string; passed: number; evaluated: number }[];
  /** Per rung: smoke must never fail, regression must not get worse, frontier is where failures teach. */
  tiers: { tier: Tier; cards: number; passed: number; graded: number }[];
  weakSpots: { kind: 'check' | 'metric'; description: string; failures: number; stage?: string }[];
  confidence: 'low' | 'medium' | 'high'; confidenceReasons: VerdictNote[]; nextSteps: VerdictNote[];
}
/** Rubric outcomes stay separate from objective checks everywhere they are presented. */
export function agentRubricResult(scenario: Scenario | undefined, trial: Trial): 'pass' | 'fail' | 'unknown' | undefined {
  const metrics = scenario?.metrics?.filter(m => m.subject === 'agent') ?? [];
  if (!metrics.length) return undefined;
  const results = metrics.map(m => trial.assessments?.find(a => a.metricId === m.id)?.result);
  return results.includes('fail') ? 'fail' : results.every(r => r === 'pass') ? 'pass' : 'unknown';
}
export function isAgentFailure(record: Experiment, trial: Trial): boolean {
  return !['invalid', 'cancelled'].includes(trial.outcome) && (trial.outcome === 'fail'
    || agentRubricResult(record.scenarios.find(s => s.id === trial.scenarioId), trial) === 'fail');
}
/** Combined automatic result for triage, never a replacement for the separate code and rubric scores. */
function automaticTrialResult(scenario: Scenario | undefined, trial: Trial): 'pass' | 'fail' | 'unknown' {
  if (!scenario || !measured(trial)) return 'unknown';
  const rubric = agentRubricResult(scenario, trial);
  if (trial.outcome === 'fail' || rubric === 'fail') return 'fail';
  return (!scenario.checks.length || trial.outcome === 'pass')
    && (rubric === 'pass' || (rubric === undefined && scenario.checks.length > 0)) ? 'pass' : 'unknown';
}
/** Human reports and disagreements remain visible even when every automatic score is green. */
export function humanFindings(record: Experiment): HumanFinding[] {
  record = observedRecord(record);
  return [...latestHumanReviews(record).values()].flatMap(review => {
    const trial = record.trials.find(t => t.id === review.trialId);
    if (!trial || !['pass', 'fail', 'invalid'].includes(review.verdict)) return [];
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    const metric = scenario?.metrics?.find(m => m.id === review.metricId);
    const check = trial.checks.find(c => c.id === review.checkId);
    const automatic = !measured(trial) ? 'unknown' : review.metricId ? trial.assessments?.find(a => a.metricId === review.metricId)?.result ?? 'unknown'
      : review.checkId ? check ? check.passed ? 'pass' : 'fail' : 'unknown' : automaticTrialResult(scenario, trial);
    const disagreement = automatic !== 'unknown' && review.verdict !== automatic;
    if (review.verdict !== 'fail' && review.verdict !== 'invalid' && !disagreement) return [];
    return [{ trialId: trial.id, reviewId: review.id, target: metric?.name ?? check?.description ?? review.metricId ?? review.checkId ?? 'Весь диалог',
      subject: review.verdict === 'invalid' ? 'test' : review.checkId ? 'check' : metric?.subject ?? 'agent', verdict: review.verdict as 'pass' | 'fail' | 'invalid', automatic, disagreement, note: review.note }];
  });
}
/** Observed repeats of the same card and user mode; no independence or future-success probability is inferred. */
export function repeatResults(record: Experiment): RepeatResult[] {
  record = observedRecord(record);
  return record.scenarios.flatMap(scenario => record.settings.userModes.filter(mode => mode !== 'scripted' || scenario.user.script !== undefined).map(userMode => {
    const trials = record.trials.filter(t => t.scenarioId === scenario.id && t.userMode === userMode);
    const outcomes = Array.from({ length: record.settings.repeats }, (_, repeat) => {
      const matches = trials.filter(t => t.repeat === repeat);
      return matches.length === 1 ? automaticTrialResult(scenario, matches[0]!) : 'unknown';
    });
    const passed = outcomes.filter(o => o === 'pass').length;
    const failed = outcomes.filter(o => o === 'fail').length;
    const unknown = outcomes.length - passed - failed;
    const incompatible = runCompleteness({ ...record, scenarios: [scenario], trials, settings: { ...record.settings, userModes: [userMode] } }, true).length > 0;
    const status = unknown || incompatible ? 'incomplete' : outcomes.length === 1 ? 'single' : passed && failed ? 'mixed' : failed ? 'all_fail' : 'all_pass';
    return { scenarioId: scenario.id, title: scenario.title, userMode, planned: outcomes.length, passed, failed, unknown, status, trialIds: trials.map(t => t.id) };
  }));
}
/** A label on a passing or simulator criterion does not resolve an agent's failed criteria. */
export function awaitingVerdict(record: Experiment): Set<string> {
  record = observedRecord(record);
  const latest = latestHumanReviews(record);
  const decided = (key: string) => ['pass', 'fail'].includes(latest.get(key)?.verdict ?? '');
  return new Set(record.trials.filter(trial => {
    if (!isAgentFailure(record, trial) || decided(`${trial.id}|dialogue`) || latest.get(`${trial.id}|dialogue`)?.verdict === 'invalid') return false;
    const failed = [
      ...trial.checks.filter(c => !c.passed).map(c => `check:${c.id}`),
      ...(record.scenarios.find(s => s.id === trial.scenarioId)?.metrics ?? [])
        .filter(m => m.subject === 'agent' && trial.assessments?.some(a => a.metricId === m.id && a.result === 'fail'))
        .map(m => `metric:${m.id}`),
    ];
    return !failed.length || failed.some(key => !decided(`${trial.id}|${key}`));
  }).map(t => t.id));
}

/**
 * Enough labeled pairs to notice a badly worded rubric, long before there are enough to
 * trust a rate. A judge that disagrees with the owner more than a quarter of the time is
 * usually measuring something other than what the rubric meant to say.
 */
const DISAGREEMENT_SIGNAL = { pairs: 20, agreement: 0.75 };
function disagreeing(calibration: CalibrationRow[]): CalibrationRow[] {
  return calibration.filter(row => row.n >= DISAGREEMENT_SIGNAL.pairs && row.agreement !== null && row.agreement < DISAGREEMENT_SIGNAL.agreement);
}

// ponytail: audit heuristics, not statistical confidence; use a calibrated estimator for population claims.
const MIN_GRADED = 5;
const TRUSTED_SAMPLE = 30;
/** High confidence requires a complete, diverse sample and individual human review; repeats add no coverage. */
export function verdictSummary(record: Experiment): VerdictSummary {
  record = observedRecord(record);
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
  const tiers: VerdictSummary['tiers'] = (['smoke', 'regression', 'frontier'] as const)
    .map(tier => ({ tier, cards: record.scenarios.filter(s => s.tier === tier).length, passed: 0, graded: 0 }));
  const tierOf = (scenarioId: string) => record.scenarios.find(s => s.id === scenarioId)?.tier ?? 'regression';
  for (const trial of gradedTrials) {
    const row = tiers.find(t => t.tier === tierOf(trial.scenarioId))!;
    row.graded += 1;
    if (trial.outcome === 'pass') row.passed += 1;
  }
  // A smoke card is the floor of the product: if it fails, nothing above it is worth reading yet.
  const smokeFailures = record.trials.filter(t => isAgentFailure(record, t) && tierOf(t.scenarioId) === 'smoke').length;

  // Per stage: every criterion that named a job of the agent, counted where it was evaluated.
  const stageTally = new Map<string, { passed: number; evaluated: number }>();
  const countStage = (stage: string | undefined, ok: boolean) => {
    if (!stage) return;
    const row = stageTally.get(stage) ?? { passed: 0, evaluated: 0 };
    row.evaluated += 1;
    if (ok) row.passed += 1;
    stageTally.set(stage, row);
  };
  for (const trial of record.trials) {
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    if (!scenario) continue;
    for (const result of trial.checks) countStage(scenario.checks.find(c => c.id === result.id)?.stage, result.passed);
    for (const assessment of trial.assessments ?? []) {
      const metric = scenario.metrics?.find(m => m.id === assessment.metricId);
      if (metric?.subject === 'agent' && assessment.result !== 'unknown') countStage(metric.stage, assessment.result === 'pass');
    }
  }
  const stages = [...stageTally.entries()].map(([stage, row]) => ({ stage, ...row }))
    .sort((a, b) => (a.passed / a.evaluated) - (b.passed / b.evaluated) || a.stage.localeCompare(b.stage));

  // Rubric estimates cover every completed dialogue, including those without objective checks. They are model estimates, never verified results.
  const completed = record.trials.filter(t => graded(t) || t.outcome === 'ungraded');
  const checkFailures = new Map<string, number>();
  const metricFailures = new Map<string, number>();
  const rubric = { assessed: 0, passed: 0, failed: 0, unknown: 0 };
  const failureStage = new Map<string, string>();
  let simulatorFlagged = 0;
  for (const trial of completed) {
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    for (const check of trial.checks) if (!check.passed) {
      checkFailures.set(check.description, (checkFailures.get(check.description) ?? 0) + 1);
      const at = scenario?.checks.find(c => c.id === check.id)?.stage;
      if (at) failureStage.set(check.description, at);
    }
    const subjectOf = (metricId: string) => scenario?.metrics?.find(m => m.id === metricId)?.subject ?? 'agent';
    const agentResults = (trial.assessments ?? []).filter(a => subjectOf(a.metricId) === 'agent');
    if (agentResults.length) {
      rubric.assessed += 1;
      if (agentRubricResult(scenario, trial) === 'fail') rubric.failed += 1;
      else if (agentRubricResult(scenario, trial) !== 'pass') rubric.unknown += 1;
      else rubric.passed += 1;
    }
    if ((trial.assessments ?? []).some(a => subjectOf(a.metricId) === 'simulator' && a.result === 'fail')) simulatorFlagged += 1;
    for (const assessment of agentResults) if (assessment.result === 'fail') {
      const metric = scenario?.metrics?.find(m => m.id === assessment.metricId);
      const name = metric?.name ?? assessment.metricId;
      metricFailures.set(name, (metricFailures.get(name) ?? 0) + 1);
      if (metric?.stage) failureStage.set(name, metric.stage);
    }
  }
  const weakSpots = [
    ...[...checkFailures].map(([description, failures]) => ({ kind: 'check' as const, description, failures })),
    ...[...metricFailures].map(([description, failures]) => ({ kind: 'metric' as const, description, failures })),
  ].map((spot): VerdictSummary['weakSpots'][number] => {
    const at = failureStage.get(spot.description);
    return at ? { ...spot, stage: at } : spot;
  }).sort((a, b) => b.failures - a.failures).slice(0, 3);
  const allSynthetic = provenance.curated.cards + provenance.production.cards === 0;
  const humanVerdicts = record.humanReviews.length > 0;
  // Only the latest verdict per target counts, and only pass/fail decides anything; unknown and invalid record that a person looked and could not confirm the result.
  const decisive = (r: HumanReview) => r.verdict === 'pass' || r.verdict === 'fail';
  const current = [...latestHumanReviews(record).values()];
  const decisiveVerdicts = current.some(decisive);
  const finalized = !!record.resultsReviewedAt;
  // A failed dialogue is one that failed objectively or by the agent rubrics; every one of them needs a decisive human verdict before the result is trusted.
  const failedTrials = completed.filter(t => isAgentFailure(record, t));
  const pending = awaitingVerdict(record);
  const attempted = new Set(record.trials.map(attemptKey));
  const expected = expectedAttempts(record);
  const execution: VerdictSummary['execution'] = {
    planned: plannedTrials(record), completed: completed.length, invalid,
    cancelled: record.trials.filter(t => t.outcome === 'cancelled').length,
    missing: [...expected].filter(key => !attempted.has(key)).length,
    running: runningPhases.has(record.phase),
  };
  const review: VerdictSummary['review'] = {
    status: !record.trials.length ? 'not_started' : finalized && pending.size === 0 ? 'complete' : 'pending',
    pending: pending.size,
    reviewed: record.trials.filter(t => current.some(r => r.trialId === t.id && !r.metricId && !r.checkId && (decisive(r) || r.verdict === 'invalid'))).length,
    total: record.trials.length,
    passed: current.filter(r => !r.metricId && !r.checkId && r.verdict === 'pass').length,
    failed: current.filter(r => !r.metricId && !r.checkId && r.verdict === 'fail').length,
    invalid: current.filter(r => !r.metricId && !r.checkId && r.verdict === 'invalid').length,
    findings: humanFindings(record), flagged: 0, disagreements: 0,
  };
  review.flagged = new Set(review.findings.filter(f => f.verdict === 'fail').map(f => f.trialId)).size;
  review.disagreements = review.findings.filter(f => f.disagreement).length;
  const repeats = repeatResults(record);
  const mixed = repeats.filter(r => r.passed > 0 && r.failed > 0);
  const reviewsFor = (trialId: string) => current.filter(r => r.trialId === trialId);
  const unreviewed = failedTrials.filter(t => reviewsFor(t.id).length === 0).length;
  const undecided = failedTrials.filter(t => reviewsFor(t.id).length > 0 && pending.has(t.id)).length;
  const reasons: VerdictNote[] = [];
  if (review.disagreements) reasons.push({ code: 'human_disagreement', text: `Расхождений автоматической и ручной оценки: ${review.disagreements}. Проверьте основания каждого; это ещё не оценка точности судьи.`, count: review.disagreements });
  if (gradedCount === 0 && rubric.assessed === 0) reasons.push({ code: 'none_graded', text: 'Диалогов с оценкой ещё нет.' });
  else if (gradedCount === 0) reasons.push({ code: 'rubric_only', text: 'Только оценки модели по рубрикам, объективных проверок нет: кодом ничего не подтверждено.' });
  else if (gradedCount < MIN_GRADED) reasons.push({ code: 'few_graded', text: `Оценено ${gradedCount} диалог(ов) — слишком мало, чтобы судить об агенте.`, count: gradedCount });
  if (invalid) reasons.push({ code: 'invalid', text: `${invalid} диалог(ов) не удалось измерить: сломалась симуляция или инфраструктура.`, count: invalid });
  if (allSynthetic) reasons.push({ code: 'all_synthetic', text: 'Все карточки синтетические: ни реальных пользователей, ни проверенного golden set.' });
  if (simulatorFlagged) reasons.push({ code: 'simulator_flagged', text: `Модель отметила ${simulatorFlagged} диалог(ов), где симулированный пользователь мог выйти из роли.`, count: simulatorFlagged });
  if (!humanVerdicts) reasons.push({ code: 'no_human', text: 'Ни одного вердикта человека: оценки модели никем не проверены.' });
  else if (!decisiveVerdicts) reasons.push({ code: 'no_decisive_verdicts', text: 'Нет решающей оценки качества агента. Невалидный тест требует исправления и повторного запуска.' });
  else if (!finalized) reasons.push({ code: 'not_finalized', text: 'Аудит результатов человеком не завершён.' });
  else {
    if (unreviewed) reasons.push({ code: 'unreviewed_failures', text: `${unreviewed} провалившихся диалог(ов) без вердикта человека.`, count: unreviewed });
    if (undecided) reasons.push({ code: 'undecided_failures', text: `${undecided} провалившихся диалог(ов) ещё без решающего вердикта на диалог или все проваленные критерии.`, count: undecided });
  }
  const invalidShare = record.trials.length ? invalid / record.trials.length : 0;
  const uniqueCards = new Set(gradedTrials.map(t => t.scenarioId)).size;
  const families = new Set(gradedTrials.map(t => t.familyId)).size;
  const reviewedCards = new Set(record.trials.filter(t => current.some(r => r.trialId === t.id && !r.metricId && !r.checkId && decisive(r))).map(t => t.scenarioId)).size;
  const reviewComplete = finalized && decisiveVerdicts && pending.size === 0 && invalid === 0 && review.disagreements === 0;
  if (gradedCount >= MIN_GRADED && uniqueCards < TRUSTED_SAMPLE) reasons.push({ code: 'small_sample', text: `Проверено ${uniqueCards} разных карточек. Для высокого доверия нужны ${TRUSTED_SAMPLE}; повторы не расширяют покрытие.`, count: uniqueCards });
  if (families < 8 && gradedCount >= MIN_GRADED) reasons.push({ code: 'few_families', text: `Покрыто ${families} семейств ситуаций из ориентира 8.`, count: families });
  if (reviewedCards < TRUSTED_SAMPLE && gradedCount >= MIN_GRADED) reasons.push({ code: 'few_reviews', text: `Индивидуально разобрано ${reviewedCards} разных карточек из ${TRUSTED_SAMPLE}.`, count: reviewedCards });
  const incomplete = record.workflow === 'evaluate' ? runCompleteness(record) : [];
  if (incomplete.length && record.trials.length) reasons.push({ code: 'incomplete_run', text: 'Прогон неполный или содержит невалидные попытки: итог описывает только сохранённую часть.' });
  if (record.mode === 'demo') reasons.push({ code: 'demo', text: 'Сценарное демо проверяет механику, а не качество модели.' });
  const confidence: VerdictSummary['confidence'] = gradedCount < MIN_GRADED || allSynthetic || invalidShare > 0.25 || record.mode === 'demo' ? 'low'
    : reviewComplete && uniqueCards >= TRUSTED_SAMPLE && families >= 8 && reviewedCards >= TRUSTED_SAMPLE && !incomplete.length && !simulatorFlagged ? 'high' : 'medium';
  const nextSteps: VerdictNote[] = [];
  if (record.phase === 'review') nextSteps.push(record.questions.length
    ? { code: 'clarify_requirements', text: 'Ответьте на вопросы по требованиям и подготовьте обновлённый черновик.' }
    : { code: 'approve_and_run', text: 'Посмотрите запрос и ожидаемый результат, затем запустите проверку из разговора. /agent-lab — подробности.' });
  else if (execution.running) nextSteps.push({ code: 'wait_for_run', text: 'Прогон продолжается. Дождитесь результата или остановите его; записанные диалоги сохранятся.' });
  else if (invalid) nextSteps.push({ code: 'repair_execution', text: `Исправьте сбой подключения или симуляции и повторите прогон. Причина: ${record.trials.find(t => t.outcome === 'invalid')?.reason || 'откройте невалидный диалог и его трассу'}`, count: invalid });
  else if (record.phase === 'error') nextSteps.push({ code: 'repair_preparation', text: `Исправьте причину сбоя и подготовьте новый черновик: ${record.error ?? record.message}` });
  else if (execution.cancelled || record.phase === 'cancelled' || record.phase === 'interrupted') nextSteps.push({ code: 'repeat_run', text: 'Сохранена только часть прогона. Откройте повтор, проверьте подключение и запустите набор заново.' });
  const hasResults = completed.length > 0 && !execution.running && record.phase !== 'review';
  if (hasResults && review.invalid) nextSteps.unshift({ code: 'repair_test', text: `Невалидных тестов: ${review.invalid}. Исправьте сценарий или ожидание и повторите проверку. Исходные оценки сохранены; они не подтверждают ошибку агента.`, count: review.invalid });
  if (hasResults && review.findings.length) nextSteps.push({ code: 'inspect_human_findings', text: `Разберите замечания человека (${review.flagged} диалогов) и расхождения с автоматикой (${review.disagreements} оценок). Откройте диалог в /agent-lab → 3; a — обсудить основания и исправление.`, count: review.findings.length });
  if (hasResults && mixed.length) nextSteps.push({ code: 'inspect_repeats', text: `На ${mixed.length} сочетаниях карточки и режима есть и успехи, и провалы. Сравните эти попытки; общий процент скрывает различия.`, count: mixed.length });
  const awaiting = unreviewed + undecided;
  if (hasResults && awaiting) nextSteps.push({ code: 'record_verdicts', text: `Разберите ${awaiting} провалившихся диалог(ов) без решающего вердикта: в /agent-lab клавиши p — пройдено, n — не пройдено.`, count: awaiting });
  else if (hasResults && !finalized && record.workflow === 'evaluate' && record.phase === 'results_review') nextSteps.push({ code: 'finalize_review', text: 'Проверьте ответы и основания оценок, затем завершите разбор. Отсутствие замечаний модели ещё не означает проверку человеком.' });
  if (hasResults && smokeFailures) nextSteps.push({ code: 'smoke_failed', text: `Провалено ${smokeFailures} попыток на дымовых карточках: сначала восстановите базовое поведение.`, count: smokeFailures });
  if (hasResults && weakSpots[0]) nextSteps.push({ code: 'fix_weakest', text: `Начните с самого слабого места${weakSpots[0].stage ? ` на этапе «${weakSpots[0].stage}»` : ''}: ${weakSpots[0].description} (${weakSpots[0].failures} провал(ов)).`, detail: weakSpots[0].description, count: weakSpots[0].failures });
  if (hasResults && allSynthetic) nextSteps.push({ code: 'add_real_data', text: 'Добавьте golden set или реальные диалоги, чтобы результат не держался на одной синтетике.' });
  if (hasResults && record.target.kind === 'sandbox') nextSteps.push({ code: 'connect_agent', text: 'Подключите своего агента вместо песочницы, чтобы проверять то, что реально работает.' });
  for (const row of hasResults ? disagreeing(judgeCalibration(record)) : []) {
    nextSteps.push({ code: 'rewrite_rubric', text: `Перепишите рубрику «${row.key}»: судья расходится с вашими вердиктами в ${Math.round((1 - (row.agreement ?? 0)) * 100)}% случаев.`, detail: row.key, count: row.n });
  }
  if (hasResults && gradedCount > 0 && uniqueCards < TRUSTED_SAMPLE) nextSteps.push({ code: 'run_more', text: `Добавьте новые ситуации: проверено ${uniqueCards} разных карточек; ориентир для аудита — ${TRUSTED_SAMPLE}. Это не статистическая гарантия.`, count: uniqueCards });
  const passRate = gradedCount ? passed / gradedCount : null;
  const estimates = rubric.assessed ? ` ${record.mode === 'demo' ? 'Сценарная оценка демо' : 'Оценка модели'} (не проверена): ${rubric.passed} из ${rubric.assessed} диалогов без замечаний по рубрикам агента.` : '';
  let headline = gradedCount ? `По кодовым проверкам пройдено ${passed} из ${gradedCount} диалогов (${Math.round((passRate ?? 0) * 100)}%).${estimates}`
    : rubric.assessed ? `${estimates.trim()} Провалов: ${rubric.failed}; неясно: ${rubric.unknown}. Объективных проверок нет.` : 'Диалогов с оценкой ещё нет.';
  if (record.phase === 'preparing') headline = 'Готовим карточки и критерии. Диалоги ещё не запущены.';
  else if (record.phase === 'review') headline = `Черновик готов: ${record.scenarios.length} карточек, ${execution.planned} диалогов после подтверждения.`;
  else if (execution.running) headline = `Идёт прогон: завершено ${execution.completed} из ${execution.planned} диалогов; сбоев ${invalid}.`;
  else if (!completed.length && invalid) headline = `Не удалось измерить агента: ${invalid} диалогов завершились сбоем. ${record.trials.find(t => t.outcome === 'invalid')?.reason ?? ''}`;
  else if (!completed.length && record.phase === 'error') headline = `Работа остановилась с ошибкой: ${record.error ?? record.message}`;
  else if (!completed.length && (execution.cancelled || record.phase === 'cancelled' || record.phase === 'interrupted')) headline = 'Прогон остановлен. Завершённых измерений нет; частичные диалоги сохранены.';
  if (hasResults && review.invalid) headline = `Невалидных тестов: ${review.invalid}. Качество агента по ним не установлено. Исходные оценки: ${headline}`;
  else if (hasResults && review.flagged) headline = `Человек отметил проблемы: ${review.flagged} диалог(ов). ${headline}`;
  else if (hasResults && review.disagreements) headline = `Есть расхождения с ручной оценкой: ${review.disagreements}. ${headline}`;
  return { headline, passed, graded: gradedCount, invalid, passRate, execution, review, repeats, rubric, simulatorFlagged, provenance, stages, tiers, weakSpots, confidence, confidenceReasons: reasons, nextSteps };
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
  if (thin.length) notes.push(`Калибровка судьи опирается меньше чем на 60 размеченных пар: ${thin.join(', ')}. Оценки модели пока предварительные.`);
  if (calibration.length && calibration.every(r => r.n === 0)) notes.push('Вердиктов человека по метрикам и проверкам ещё нет: согласие судьи неизвестно.');
  for (const row of disagreeing(calibration)) {
    notes.push(`Судья расходится с человеком в ${Math.round((1 - (row.agreement ?? 0)) * 100)}% размеченных случаев по «${row.key}» (${row.n} пар). Проверьте рубрику, основания оценок и ручную разметку; причина ещё не установлена.`);
  }
  if (!fidelity) notes.push('Реальные диалоги не загружены: верность симулятора оценить нечем.');
  else if (!fidelity.simulatedDialogues) notes.push('Завершённых реактивных диалогов ещё нет: разрывы верности недоступны.');
  notes.push(...record.limitations.filter(l => l.startsWith('Scripted mode skipped')));
  const reactive = modes.find(m => m.userMode === 'reactive');
  if (record.settings.userModes.length > 1 && reactive?.uniqueFailedChecks.length) notes.push(`Критерии с провалом только в реактивном режиме среди сопоставленных попыток (не доказательство дополнительной пользы): ${reactive.uniqueFailedChecks.join(', ')}.`);
  return { verdict: verdictSummary(record), comparison, modes, calibration, fidelity, notes };
}

/**
 * Two runs of the same cards, before and after a change. This is the everyday question —
 * "did my edit help?" — and a single average answers it badly: an improvement on easy cards
 * hides a regression on the one that matters. So the comparison is per card, per stage and
 * per rung, and it states out loud when the two runs are not actually comparable.
 */
export interface RunComparison {
  headline: string; comparable: boolean;
  pairs: { scenarioId: string; userMode: UserMode; repeat: number; beforeTrialId: string; afterTrialId: string;
    change: 'fixed' | 'regressed' | 'unchanged' | 'unknown'; reviewNote?: string }[];
  coverage: { plannedPairs: number; validPairs: number; excludedPairs: number; missingBefore: number; missingAfter: number; invalidBefore: number; invalidAfter: number };
  cards: { shared: number; onlyBefore: string[]; onlyAfter: string[] };
  fixed: { scenarioId: string; title: string; tier: Tier }[];
  regressed: { scenarioId: string; title: string; tier: Tier }[];
  unchanged: { passing: number; failing: number };
  ungraded: number; includesRubrics: boolean;
  stages: { stage: string; before: number | null; after: number | null }[];
  tiers: { tier: Tier; before: { passed: number; graded: number }; after: { passed: number; graded: number } }[];
  notes: string[];
}

/** Expected attempts, including all repeats. Missing/invalid attempts never disappear from a comparison. */
export function plannedTrials(record: Experiment): number {
  return record.scenarios.reduce((sum, s) => sum + record.settings.userModes.filter(m => m !== 'scripted' || s.user.script !== undefined).length * record.settings.repeats, 0);
}
const attemptKey = (trial: Trial) => `${trial.scenarioId}|${trial.userMode}|${trial.repeat}`;
const measured = (trial: Trial) => graded(trial) || trial.outcome === 'ungraded';
function expectedAttempts(record: Experiment): Set<string> {
  return new Set(record.scenarios.flatMap(s => record.settings.userModes.filter(m => m !== 'scripted' || s.user.script !== undefined)
    .flatMap(mode => Array.from({ length: record.settings.repeats }, (_, i) => `${s.id}|${mode}|${i}`))));
}
function runCompleteness(record: Experiment, allowPartial = false): string[] {
  const expected = expectedAttempts(record);
  const seen = new Set<string>();
  const ids = new Set<string>();
  let invalid = false;
  let unmeasured = false;
  for (const trial of record.trials) {
    const key = attemptKey(trial);
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    if (!expected.has(key) || seen.has(key) || ids.has(trial.id) || !scenario
      || trial.familyId !== scenario.familyId || fingerprint(trial.initialState) !== fingerprint(scenario.initialState)
      || trial.split !== scenario.split
      || measured(trial) && (trial.checks.length !== scenario.checks.length || new Set(trial.checks.map(c => c.id)).size !== scenario.checks.length
        || trial.checks.some(c => !scenario.checks.some(expected => expected.id === c.id)))
      || trial.outcome === 'pass' && (!trial.checks.length || trial.checks.some(c => !c.passed))
      || (record.manifestHash && trial.manifestHash !== record.manifestHash)) invalid = true;
    if (!measured(trial)) unmeasured = true;
    seen.add(key); ids.add(trial.id);
  }
  const notes: string[] = [];
  if (!['results_review', 'complete'].includes(record.phase)) notes.push('Прогон не завершён.');
  if (invalid || !expected.size) notes.push('Есть повторяющиеся или несовместимые попытки.');
  if (!allowPartial && (unmeasured || seen.size !== expected.size || record.trials.length !== expected.size)) notes.push('Есть пропущенные или невалидные попытки.');
  return notes;
}
function cardOutcome(record: Experiment, scenario: Scenario): 'pass' | 'fail' | 'unknown' {
  const trials = record.trials.filter(t => t.scenarioId === scenario.id);
  if (!trials.length) return 'unknown';
  const outcomes = trials.map(t => automaticTrialResult(scenario, t));
  return outcomes.includes('fail') ? 'fail' : outcomes.every(o => o === 'pass') ? 'pass' : 'unknown';
}

export function compareRuns(before: Experiment, after: Experiment): RunComparison {
  if (after.parentRunId === before.id && after.selectedScenarioIds?.length
    && after.scenarios.length < before.scenarios.length
    && after.scenarios.length === after.selectedScenarioIds.length
    && after.scenarios.every(s => after.selectedScenarioIds!.includes(s.id) && before.scenarios.some(b => b.id === s.id))) {
    const selected = new Set(after.selectedScenarioIds);
    const result = compareRuns({ ...before, scenarios: before.scenarios.filter(s => selected.has(s.id)), trials: before.trials.filter(t => selected.has(t.scenarioId)) }, after);
    result.cards.onlyBefore = before.scenarios.filter(s => !selected.has(s.id)).map(s => s.id);
    result.headline = `Выбранные тесты (${selected.size}/${before.scenarios.length}). ${result.headline}`;
    result.notes.push('Сравнение относится только к явно выбранным тестам. Остальной регрессионный набор не проверен.');
    return result;
  }
  const beforeIds = new Set(before.scenarios.map(s => s.id));
  const afterIds = new Set(after.scenarios.map(s => s.id));
  const shared = after.scenarios.filter(s => beforeIds.has(s.id));
  const beforeReviews = latestHumanReviews(before), afterReviews = latestHumanReviews(after);
  const validBefore = (t: Trial) => measured(t) && beforeReviews.get(`${t.id}|dialogue`)?.verdict !== 'invalid';
  const validAfter = (t: Trial) => measured(t) && afterReviews.get(`${t.id}|dialogue`)?.verdict !== 'invalid';
  const result: RunComparison = {
    headline: '', comparable: false, pairs: [], cards: { shared: shared.length,
      onlyBefore: before.scenarios.filter(s => !afterIds.has(s.id)).map(s => s.id),
      onlyAfter: after.scenarios.filter(s => !beforeIds.has(s.id)).map(s => s.id) },
    fixed: [], regressed: [], unchanged: { passing: 0, failing: 0 }, ungraded: 0,
    includesRubrics: shared.some(s => s.metrics?.some(m => m.subject === 'agent')),
    stages: [], tiers: [], notes: [],
    coverage: { plannedPairs: plannedTrials(before), validPairs: 0, excludedPairs: plannedTrials(before),
      missingBefore: Math.max(0, plannedTrials(before) - before.trials.length), missingAfter: Math.max(0, plannedTrials(after) - after.trials.length),
      invalidBefore: before.trials.filter(t => !validBefore(t)).length, invalidAfter: after.trials.filter(t => !validAfter(t)).length },
  };
  const { notes } = result;
  if (before.id === after.id) notes.push('Выбран один и тот же прогон.');
  if (before.workflow !== 'evaluate' || after.workflow !== 'evaluate') notes.push('Сравнение поддерживает отдельные оценочные прогоны.');
  if (before.mode !== after.mode) notes.push('Демо и живые прогоны несравнимы.');
  if (fingerprint(before.target) !== fingerprint(after.target) && after.parentRunId !== before.id) notes.push('Испытуемый в прогонах разный: выберите повтор того же агента.');
  if (fingerprint(before.settings) !== fingerprint(after.settings)) notes.push('Настройки, модель, режимы пользователя или число повторов отличаются.');
  if (fingerprint(before.sources) !== fingerprint(after.sources) || fingerprint(before.requirements) !== fingerprint(after.requirements)) notes.push('Материалы или требования изменились.');
  if (result.cards.onlyBefore.length || result.cards.onlyAfter.length) notes.push('Набор карточек изменился.');
  const changed = shared.filter(s => fingerprint(s) !== fingerprint(before.scenarios.find(b => b.id === s.id)));
  if (changed.length) notes.push(`Содержимое карточек изменилось: ${changed.map(s => s.title).join(', ')}.`);
  for (const [name, record] of [['До', before], ['После', after]] as const) notes.push(...runCompleteness(record, true).map(n => `${name}: ${n}`));
  if (notes.length) { result.headline = 'Прогоны несравнимы. Исправления и регрессии не подсчитываются.'; return result; }
  const afterAttempts = new Map(after.trials.map(t => [attemptKey(t), t]));
  const pairs = before.trials.filter(t => validBefore(t) && afterAttempts.has(attemptKey(t)) && validAfter(afterAttempts.get(attemptKey(t))!));
  result.coverage.validPairs = pairs.length;
  result.coverage.excludedPairs -= pairs.length;
  if (result.coverage.excludedPairs) notes.push(`Сопоставлено ${pairs.length} из ${result.coverage.plannedPairs} пар попыток. Исключено ${result.coverage.excludedPairs}: до — ${result.coverage.invalidBefore} невалидных и ${result.coverage.missingBefore} пропущенных; после — ${result.coverage.invalidAfter} невалидных и ${result.coverage.missingAfter} пропущенных. Сбои могут скрывать регрессии; вывод относится только к сопоставленной части.`);
  if (!pairs.length) { result.headline = 'Нет совпадающих валидных попыток. Повторите неудавшиеся диалоги, чтобы получить сравнение.'; return result; }
  result.pairs = pairs.map(trial => {
    const scenario = shared.find(s => s.id === trial.scenarioId);
    const was = automaticTrialResult(scenario, trial);
    const following = afterAttempts.get(attemptKey(trial))!;
    const now = automaticTrialResult(scenario, following);
    const change: RunComparison['pairs'][number]['change'] = was === 'unknown' || now === 'unknown' ? 'unknown'
      : was === now ? 'unchanged' : now === 'pass' ? 'fixed' : 'regressed';
    const replies = trial.events.filter(e => e.type === 'assistant').map(e => e.text);
    const rubricFlipped = scenario?.metrics?.some(m => m.subject === 'agent'
      && trial.assessments?.some(a => a.metricId === m.id && a.result !== 'unknown'
        && following.assessments?.some(b => b.metricId === m.id && b.result !== 'unknown' && b.result !== a.result)));
    const reviewNote = rubricFlipped && replies.length
      && fingerprint(replies) === fingerprint(following.events.filter(e => e.type === 'assistant').map(e => e.text))
      ? 'Ответы агента совпали, оценки по рубрикам различаются. Проверьте запросы пользователя, действия и критерии: рост оценки сам по себе не доказывает улучшение агента.' : undefined;
    if (reviewNote) notes.push(`${scenario!.title} · ${trial.userMode} #${trial.repeat + 1}: ${reviewNote}`);
    return { scenarioId: trial.scenarioId, userMode: trial.userMode, repeat: trial.repeat,
      beforeTrialId: trial.id, afterTrialId: following.id, change, ...(reviewNote ? { reviewNote } : {}) };
  });
  // Open the actual changed attempt, not an unchanged repeat of a changed card.
  const rank = { regressed: 0, fixed: 1, unchanged: 2, unknown: 2 };
  result.pairs.sort((a, b) => rank[a.change] - rank[b.change]);
  before = { ...before, trials: pairs };
  after = { ...after, trials: pairs.map(t => afterAttempts.get(attemptKey(t))!) };
  result.comparable = true;
  for (const scenario of shared) {
    const was = cardOutcome(before, scenario);
    const now = cardOutcome(after, scenario);
    if (was === 'unknown' || now === 'unknown') { result.ungraded++; continue; }
    const row = { scenarioId: scenario.id, title: scenario.title, tier: scenario.tier ?? 'regression' };
    if (was === 'fail' && now === 'pass') result.fixed.push(row);
    else if (was === 'pass' && now === 'fail') result.regressed.push(row);
    else if (now === 'pass') result.unchanged.passing++;
    else result.unchanged.failing++;
  }
  const bv = verdictSummary(before);
  const av = verdictSummary(after);
  const rate = (v: VerdictSummary, stage: string) => { const s = v.stages.find(s => s.stage === stage); return s ? s.passed / s.evaluated : null; };
  result.stages = [...new Set([...bv.stages, ...av.stages].map(s => s.stage))].sort().map(stage => ({ stage, before: rate(bv, stage), after: rate(av, stage) }));
  result.tiers = av.tiers.map(row => ({ tier: row.tier, before: bv.tiers.find(t => t.tier === row.tier)!, after: row }));
  const compared = shared.length - result.ungraded;
  result.headline = compared ? `${result.includesRubrics ? `Оценка выросла у ${result.fixed.length}, снизилась у ${result.regressed.length}` : `Исправлено ${result.fixed.length}, сломалось ${result.regressed.length}`}, без изменений ${result.unchanged.passing + result.unchanged.failing} из ${compared} карточек.` : 'Общих оценённых карточек нет, сравнивать нечего.';
  if (result.coverage.excludedPairs) result.headline = `Частичное сравнение (${pairs.length}/${result.coverage.plannedPairs} пар). ${result.headline}`;
  if (result.includesRubrics) result.headline = `Предварительно: ${result.headline}`;
  const disputed = result.pairs.filter(p => p.reviewNote).length;
  if (disputed) result.headline += ` Пар с совпавшими ответами и разными оценками: ${disputed}. Нужна проверка.`;
  if (result.ungraded) notes.push(`${result.ungraded} карточек без решающей оценки; они не считаются пройденными.`);
  if (result.includesRubrics) notes.push('Сравнение включает предварительные оценки по рубрикам. Это не подтверждённое улучшение.');
  const smoke = result.regressed.filter(r => r.tier === 'smoke').length;
  if (smoke) notes.push(`Сломано ${smoke} дымовых карточек: сначала восстановите базовое поведение.`);
  if (compared < TRUSTED_SAMPLE) notes.push(`Сравнение по ${compared} карточкам: разница может быть случайной. Повторы не создают новые ситуации.`);
  if (before.target.kind !== 'sandbox' && (!before.targetVersion || !after.targetVersion)) notes.push('Не все версии внешнего агента названы. Локальный отпечаток не учитывает удалённые сервисы и переменные окружения.');
  return result;
}
