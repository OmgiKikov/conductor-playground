import { randomUUID } from 'node:crypto';
import {
  VERSION, agentSchema, createInputSchema, draftPatchSchema, emptyUsage, fingerprint, goldenToScenario, humanReviewInputSchema, proposalSchema, settingsSchema, validatePreparation,
  type CallContext, type CreateInput, type DraftPatch, type Experiment, type HumanReviewInput, type Revision, type Runtime,
} from './contracts.js';
import { ExperimentStore } from './store.js';
import { evaluateTrial } from './evaluation.js';
import { compareTrials } from './comparison.js';
import { createDemoRuntime } from './demo.js';
import { createPiRuntime } from './pi.js';

/*
 * Phase machine owned by ExperimentLab. Every transition is an atomic checkpoint.
 *
 *   preparing ─► review ─┬─► evaluating ─► results_review ─► complete      (workflow: evaluate)
 *                        └─► baseline ─► improving* ─► control ─► complete (workflow: compare)
 *   any running phase ─► cancelled | error | interrupted
 *
 * runSuite is the only trial loop; both workflows call it.
 */
const runningPhases = new Set(['preparing', 'evaluating', 'baseline', 'improving', 'control']);
export function draftHash(record: Experiment): string {
  return fingerprint({ task: record.task, workflow: record.workflow, mode: record.mode, sources: record.sources,
    settings: record.settings, target: record.target, requirements: record.requirements, questions: record.questions,
    goldenCases: record.goldenCases, dialogues: record.dialogues, profiles: record.profiles,
    scenarios: record.scenarios, agent: record.revisions[0]?.spec });
}
export function resultHash(record: Experiment): string {
  return fingerprint({ draft: draftHash(record), trials: record.trials, humanReviews: record.humanReviews ?? [] });
}
export function measurementHash(record: Experiment): string {
  return fingerprint({ version: VERSION, workflow: record.workflow, task: record.task, baseline: record.revisions[0], mode: record.mode, sources: record.sources, requirements: record.requirements, scenarios: record.scenarios, settings: record.settings,
    target: record.target, goldenCases: record.goldenCases, dialogues: record.dialogues, profiles: record.profiles });
}
function revision(spec: Revision['spec'], parentId: string | null, hypothesis: string): Revision {
  return { id: fingerprint(spec), parentId, spec: structuredClone(spec), hypothesis, createdAt: new Date().toISOString() };
}

export class ExperimentLab {
  readonly store: ExperimentStore;
  private active: { record: Experiment; controller: AbortController; done: Promise<void> } | null = null;
  private lastTask: Promise<void> = Promise.resolve();
  private closed = true;
  private closing = false;
  private initializing: Promise<void> | undefined;
  private mutation: Promise<unknown> | undefined;
  constructor(directory: string, private readonly injectedRuntime?: Runtime) { this.store = new ExperimentStore(directory); }
  init(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Experiment Lab is closing.'));
    return this.initializing ??= this.initialize();
  }
  private async initialize(): Promise<void> {
    await this.store.init();
    try {
      for (const record of await this.store.list()) if (runningPhases.has(record.phase)) {
        record.phase = 'interrupted'; record.message = 'The previous process stopped. Partial evidence has been preserved.';
        record.usage.costUsd = null;
        record.limitations.push('The process stopped between checkpoints; observed call and token counts may be incomplete.');
        record.error = record.message; record.updatedAt = new Date().toISOString(); await this.store.save(record);
      }
      if (!this.closing) this.closed = false;
    } catch (error) { await this.store.close(); throw error; }
  }
  async get(id: string): Promise<Experiment> {
    return this.active?.record.id === id ? structuredClone(this.active.record) : this.store.get(id);
  }
  async list(): Promise<Experiment[]> {
    const records = await this.store.list();
    return records.map(r => this.active?.record.id === r.id ? structuredClone(this.active.record) : r);
  }
  private ensureIdle(ownsMutation = false): void {
    if (this.closed) throw new Error('Experiment Lab is not open.');
    // ponytail: one active local experiment; use per-experiment workers when concurrent runs are needed.
    if (this.active || (!ownsMutation && this.mutation)) throw new Error('Another experiment operation is active. Finish or cancel it first.');
  }
  private async change<T>(work: () => Promise<T>): Promise<T> {
    this.ensureIdle();
    const pending = Promise.resolve().then(work);
    this.mutation = pending;
    try { return await pending; } finally { if (this.mutation === pending) this.mutation = undefined; }
  }
  async create(raw: CreateInput): Promise<Experiment> {
    this.ensureIdle();
    const input = createInputSchema.parse(raw);
    if (input.workflow === 'compare' && input.settings.userModes.length !== 1) throw new Error('A comparison experiment runs exactly one user mode; choose static, scripted or reactive.');
    const now = new Date().toISOString();
    const record: Experiment = {
      schemaVersion: '1', id: randomUUID(), task: input.task, mode: input.mode, createdAt: now, updatedAt: now,
      phase: 'preparing', message: 'Reading materials and preparing requirements and scenarios.',
      sources: input.materials.map((m, i) => ({ id: `source-${i + 1}`, name: m.name, content: m.content, hash: fingerprint(m.content) })),
      settings: input.settings, requirements: [], questions: [], scenarios: [], revisions: [], selectedRevisionId: null,
      manifestHash: null, reviewedAt: null, reviewMode: null, controlConsumedAt: null, trials: [], comparisons: [], iterations: [],
      usage: emptyUsage(), error: null,
      workflow: input.workflow, humanReviews: [],
      target: input.target, goldenCases: input.goldenCases, dialogues: input.dialogues, profiles: [],
      limitations: [
        'Tools operate on isolated test records, not production systems. Only instructions and registered tool permissions are edited.',
        'Scenario expectations require human review. Text matching checks measure literal content, not semantic correctness.',
        'Synthetic simulations do not establish performance with real users. Model rubric assessments are provisional and require human review.',
        'Model costs are observed usage estimates; unknown costs remain unknown. Call limits are not hard provider billing caps.',
        ...(input.mode === 'demo' ? ['Scripted demonstration: user/target behavior and the missing-tool repair are deterministic fixtures, not a measured LLM improvement.'] : []),
      ],
    };
    await this.launch(record, async ctx => {
      const runtime = await this.runtime(record);
      if (record.dialogues.length && runtime.profiles) {
        // Persona text may only come from observed dialogues; every profile must cite dialogues that were actually supplied.
        const profiles = await runtime.profiles({ task: record.task, sources: structuredClone(record.sources), dialogues: structuredClone(record.dialogues) }, ctx);
        const supplied = new Set(record.dialogues.map(d => d.id));
        if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error('Observed profiles have duplicate IDs');
        for (const profile of profiles) for (const id of profile.evidenceDialogueIds) if (!supplied.has(id)) throw new Error(`Profile ${profile.id} cites evidence dialogue ${id} that was not supplied`);
        record.profiles = profiles;
      }
      const generated = await runtime.prepare({
        task: record.task, sources: record.sources, existingAgent: input.existingAgent, workflow: input.workflow, scenarioCount: input.scenarioCount,
        profiles: structuredClone(record.profiles), goldenCases: structuredClone(record.goldenCases),
      }, ctx);
      const golden = record.goldenCases.map(goldenToScenario);
      const prepared = validatePreparation({ ...generated, scenarios: [...generated.scenarios, ...golden] }, record.sources, input.workflow, record.profiles);
      Object.assign(record, { requirements: prepared.requirements, questions: prepared.questions, scenarios: prepared.scenarios });
      const baseline = revision(input.existingAgent ?? prepared.agent, null, input.workflow === 'evaluate' ? 'Agent configuration selected for dialogue evaluation.' : 'Original agent before measured improvements.');
      record.revisions.push(baseline); record.selectedRevisionId = baseline.id;
      await this.checkpoint(record, 'review', 'Draft ready. Review goals, users and metrics before approving a run.');
    });
    return structuredClone(record);
  }
  async updateDraft(id: string, expectedHash: string, raw: DraftPatch): Promise<Experiment> {
    return this.change(async () => {
      const record = await this.store.get(id);
      if (record.phase !== 'review') throw new Error('Only an unstarted draft can be edited. Keep completed evidence and create a new experiment.');
      if (draftHash(record) !== expectedHash) throw new Error('The draft changed. Reopen the current cards before editing.');
      const patch = draftPatchSchema.parse(raw);
      const agent = patch.agent ?? record.revisions[0]?.spec;
      const scenarios = (patch.scenarios ?? record.scenarios).map(({ split: _split, ...s }) => s);
      const prepared = validatePreparation({ requirements: record.requirements, questions: record.questions, agent, scenarios }, record.sources, record.workflow ?? 'compare');
      record.scenarios = prepared.scenarios;
      if (patch.agent) record.revisions = [revision(patch.agent, null, 'Agent configuration reviewed in the draft.')];
      record.settings = settingsSchema.parse({ ...record.settings, ...patch.settings });
      record.selectedRevisionId = record.revisions[0]!.id;
      record.reviewedAt = null; record.reviewMode = null; record.manifestHash = null;
      await this.checkpoint(record, 'review', 'Draft updated. The current goals, users and metrics need human confirmation.');
      return structuredClone(record);
    });
  }
  async addHumanReview(id: string, raw: HumanReviewInput): Promise<Experiment> {
    return this.change(async () => {
      const record = await this.store.get(id);
      if (record.workflow !== 'evaluate' || !['results_review', 'complete'].includes(record.phase)) throw new Error('Human result review requires finished evaluation dialogues.');
      const input = humanReviewInputSchema.parse(raw);
      const trial = record.trials.find(t => t.id === input.trialId);
      if (!trial) throw new Error('Trial not found in this experiment.');
      if (input.checkId && !trial.checks.some(c => c.id === input.checkId)) throw new Error('Objective check not found in this trial.');
      const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
      if (input.metricId && !scenario?.metrics?.some(m => m.id === input.metricId)) throw new Error('Metric not found in this scenario.');
      (record.humanReviews ??= []).push({ ...input, id: randomUUID(), createdAt: new Date().toISOString() });
      delete record.resultsReviewedAt; delete record.resultsReviewHash;
      await this.checkpoint(record, 'results_review', 'Human annotation saved separately from the original assessment.');
      return structuredClone(record);
    });
  }
  async reviewResults(id: string, expectedHash: string): Promise<Experiment> {
    return this.change(async () => {
      const record = await this.store.get(id);
      if (record.workflow !== 'evaluate' || record.phase !== 'results_review') throw new Error('No completed dialogue set is awaiting human review.');
      if (resultHash(record) !== expectedHash) throw new Error('The results changed. Reopen the current evidence before confirming.');
      record.resultsReviewedAt = new Date().toISOString(); record.resultsReviewHash = expectedHash;
      await this.checkpoint(record, 'complete', 'Human review complete. Original checks, model estimates and human annotations remain separate.');
      return structuredClone(record);
    });
  }
  async start(id: string, options: { approved: boolean; reviewer?: 'human' | 'automated'; expectedHash?: string }): Promise<Experiment> {
    return this.change(async () => {
      const record = await this.store.get(id);
      if (record.phase !== 'review') throw new Error('Only an experiment awaiting review can start. Create a new experiment to change the suite.');
      if (!options.approved) throw new Error('Review approval is required before freezing the scenario suite.');
      if (record.workflow === 'evaluate' && (options.reviewer !== 'human' || options.expectedHash !== draftHash(record))) {
        throw new Error('Human confirmation of the current draft is required. Open the cards in Pi and approve their exact version.');
      }
      if (record.questions.length) throw new Error('Resolve the listed business questions in your materials and create a new experiment first.');
      record.reviewedAt = new Date().toISOString();
      record.reviewMode = options.reviewer ?? 'human';
      if (record.reviewMode === 'automated') record.limitations.push('Generated scenario expectations were checked automatically, without human validation. Results are provisional synthetic evidence.');
      record.manifestHash = measurementHash(record);
      record.phase = record.workflow === 'evaluate' ? 'evaluating' : 'baseline';
      record.message = record.workflow === 'evaluate' ? 'Running the human-approved dialogue set.' : 'Starting the frozen development comparison.';
      await this.launch(record, ctx => record.workflow === 'evaluate' ? this.evaluateReviewed(record, ctx) : this.execute(record, ctx), true);
      return structuredClone(record);
    });
  }
  async cancel(id: string): Promise<Experiment> {
    if (this.active?.record.id !== id) throw new Error('This experiment is not running.');
    this.active.controller.abort(new Error('Cancelled by the user.'));
    this.active.record.message = 'Cancelling; preserving recorded evidence.';
    return structuredClone(this.active.record);
  }
  async waitForIdle(): Promise<void> { await this.lastTask; }
  async close(): Promise<void> {
    this.closed = true; this.closing = true;
    this.active?.controller.abort(new Error('Application is closing.'));
    try { await this.initializing; await this.waitForIdle(); await this.mutation; } finally { await this.store.close(); }
  }
  private async runtime(record: Experiment): Promise<Runtime> {
    if (this.injectedRuntime) return this.injectedRuntime;
    return record.mode === 'demo' ? createDemoRuntime() : createPiRuntime(record.settings);
  }
  private async launch(record: Experiment, work: (ctx: CallContext) => Promise<void>, ownsMutation = false): Promise<void> {
    this.ensureIdle(ownsMutation);
    const controller = new AbortController();
    const active = { record, controller, done: Promise.resolve() };
    this.active = active; // Reserve before the first await, including the initial checkpoint.
    let saved = false;
    let ready!: () => void;
    let failed!: (error: unknown) => void;
    const initialCheckpoint = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    const timer = setTimeout(() => controller.abort(new Error('Experiment time limit reached.')), record.settings.maxDurationMs);
    const ctx: CallContext = {
      signal: controller.signal, timeoutMs: record.settings.timeoutMs,
      beforeCall: () => {
        controller.signal.throwIfAborted();
        if (record.usage.calls >= record.settings.maxCalls) {
          controller.abort(new Error('Model call budget exhausted.')); controller.signal.throwIfAborted();
        }
        record.usage.calls++;
      },
      addUsage: usage => {
        record.usage.inputTokens += usage.inputTokens;
        record.usage.outputTokens += usage.outputTokens;
        record.usage.costUsd = usage.costUsd === null || record.usage.costUsd === null ? null : record.usage.costUsd + usage.costUsd;
      },
      onTrace: (trialId, event) => this.store.appendTrace(record.id, trialId, event),
    };
    active.done = (async () => {
      try {
        await this.store.save(record); saved = true; ready();
        controller.signal.throwIfAborted();
        await work(ctx); controller.signal.throwIfAborted();
      }
      catch (error) {
        if (!saved) { failed(error); throw error; }
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        record.error = reason instanceof Error ? reason.message : String(reason);
        record.phase = controller.signal.aborted && /user|closing/i.test(record.error) ? 'cancelled' : 'error';
        record.message = record.error;
      } finally {
        clearTimeout(timer); record.updatedAt = new Date().toISOString();
        try { if (saved) await this.store.save(record); }
        finally { if (this.active === active) this.active = null; }
      }
    })();
    this.lastTask = active.done;
    // Errors saving the final checkpoint remain observable through waitForIdle and diagnostics.
    void active.done.catch(error => { process.stderr.write(`Agent Lab checkpoint failed: ${error instanceof Error ? error.message : String(error)}\n`); });
    await initialCheckpoint;
  }
  private async checkpoint(record: Experiment, phase: Experiment['phase'], message: string): Promise<void> {
    record.phase = phase; record.message = message; record.updatedAt = new Date().toISOString();
    // ponytail: full JSON checkpoints keep one canonical record; split trial storage when runs exceed local-scale sizes.
    await this.store.save(record);
  }
  /** Re-checks the frozen manifest before and after every trial; a drifted suite stops the run instead of grading it. */
  private frozenGuard(record: Experiment, hash: string, ctx: CallContext): () => void {
    const message = record.workflow === 'evaluate'
      ? 'The approved evaluation conditions changed. Create a fresh reviewed run.'
      : 'The frozen measurement changed; a fresh baseline is required.';
    return () => {
      ctx.signal.throwIfAborted();
      if (measurementHash(record) !== hash) throw new Error(message);
    };
  }
  /** The single trial loop: every user mode, every scenario of the split, every repeat, one checkpoint per trial. */
  private async runSuite(record: Experiment, runtime: Runtime, revision: Revision, split: 'dev' | 'control', label: string, ctx: CallContext): Promise<void> {
    const hash = record.manifestHash;
    if (!hash) throw new Error('Missing measurement manifest.');
    const guard = this.frozenGuard(record, hash, ctx);
    const scenarios = record.scenarios.filter(s => s.split === split);
    for (const userMode of record.settings.userModes) {
      const skipped: string[] = [];
      const prefix = record.settings.userModes.length > 1 ? `[${userMode}] ` : '';
      for (const scenario of scenarios) {
        if (userMode === 'scripted' && !scenario.user.script?.length) { skipped.push(scenario.id); continue; }
        for (let repeat = 0; repeat < record.settings.repeats; repeat++) {
          guard();
          const trial = await evaluateTrial({ runtime, revision, scenario, repeat, manifestHash: hash, sources: record.sources, settings: record.settings, ctx, userMode, target: record.target });
          record.trials.push(trial);
          await this.checkpoint(record, record.phase, `${label}${prefix}${scenario.title} · ${repeat + 1}/${record.settings.repeats}`);
          guard();
        }
      }
      if (skipped.length) {
        const note = `Scripted mode skipped ${skipped.length} card(s) without a script: ${skipped.join(', ')}.`;
        if (!record.limitations.includes(note)) record.limitations.push(note);
      }
    }
  }
  private async evaluateReviewed(record: Experiment, ctx: CallContext): Promise<void> {
    const runtime = await this.runtime(record);
    const agent = record.revisions[0];
    if (!agent || !record.manifestHash) throw new Error('Missing reviewed agent or measurement manifest.');
    await this.runSuite(record, runtime, agent, 'dev', '', ctx);
    this.frozenGuard(record, record.manifestHash, ctx)();
    await this.checkpoint(record, 'results_review', 'Dialogues and assessments are ready. Review simulator fidelity and evidence before accepting the results.');
  }
  private async execute(record: Experiment, ctx: CallContext): Promise<void> {
    const runtime = await this.runtime(record);
    const baseline = record.revisions[0];
    if (!baseline || !record.manifestHash) throw new Error('Missing frozen baseline or measurement manifest.');
    const hash = record.manifestHash;
    const guard = this.frozenGuard(record, hash, ctx);
    const evaluate = (current: Revision, split: 'dev' | 'control') =>
      this.runSuite(record, runtime, current, split, split === 'dev' ? 'Development: ' : 'Control: ', ctx);
    await this.checkpoint(record, 'baseline', 'Measuring the original agent on development scenarios.');
    await evaluate(baseline, 'dev');
    let best = baseline;
    for (let iteration = 0; iteration < record.settings.maxIterations; iteration++) {
      guard();
      const currentTrials = record.trials.filter(t => t.revisionId === best.id && t.split === 'dev');
      if (currentTrials.some(t => t.outcome === 'invalid' || t.outcome === 'cancelled')) throw new Error('Development trials are invalid; inspect the evidence before improving.');
      if (currentTrials.every(t => t.outcome === 'pass')) break;
      await this.checkpoint(record, 'improving', `Building candidate ${iteration + 1}/${record.settings.maxIterations} from development evidence only.`);
      const proposal = proposalSchema.parse(await runtime.improve({
        task: record.task, sources: structuredClone(record.sources), requirements: structuredClone(record.requirements), agent: structuredClone(best.spec),
        feedback: record.scenarios.filter(s => s.split === 'dev').map(s => ({ scenario: structuredClone(s), trials: structuredClone(currentTrials.filter(t => t.scenarioId === s.id)) })),
      }, ctx));
      guard();
      const candidate = revision(agentSchema.parse(proposal.agent), best.id, proposal.hypothesis);
      if (record.revisions.some(r => r.id === candidate.id)) {
        record.iterations.push({ revisionId: candidate.id, accepted: false, reason: 'No new agent revision was proposed.' }); break;
      }
      record.revisions.push(candidate);
      await evaluate(candidate, 'dev');
      const comparison = compareTrials({ baselineId: best.id, candidateId: candidate.id, manifestHash: hash, scenarios: record.scenarios, repeats: record.settings.repeats, trials: record.trials, split: 'dev', mode: record.mode });
      record.comparisons.push(comparison);
      const accepted = comparison.verdict !== 'incomparable' && comparison.validPairs === comparison.plannedPairs && comparison.invalidPairs === 0 && comparison.regressed === 0 && comparison.fixed > 0;
      record.iterations.push({ revisionId: candidate.id, accepted, reason: accepted ? 'More passing development trials with no regression and complete valid pairs.' : 'Candidate did not improve all required development conditions; retaining the previous best.' });
      if (accepted) { best = candidate; record.selectedRevisionId = best.id; }
    }
    guard();
    record.selectedRevisionId = best.id; record.controlConsumedAt = new Date().toISOString();
    await this.checkpoint(record, 'control', 'Candidate selected. Running the final control comparison; results will not return to the builder.');
    await evaluate(baseline, 'control');
    if (best.id !== baseline.id) await evaluate(best, 'control');
    guard();
    const final = compareTrials({ baselineId: baseline.id, candidateId: best.id, manifestHash: hash, scenarios: record.scenarios, repeats: record.settings.repeats, trials: record.trials, split: 'control', mode: record.mode });
    if (record.reviewMode !== 'human') {
      final.reasons.push('Scenario expectations have not been validated by a human; this comparison is provisional.');
      if (final.verdict === 'improved') final.verdict = 'insufficient';
    }
    record.comparisons.push(final);
    await this.checkpoint(record, 'complete', 'Comparison complete. Inspect observed changes, regressions and evidence limits.');
  }
}
