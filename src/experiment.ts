import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  VERSION, agentSchema, createInputSchema, draftPatchSchema, emptyUsage, experimentSchema, fingerprint, goalToScenario, goldenToScenario, humanReviewInputSchema, observedProfileSchema, proposalSchema, scriptIssue, settingsSchema, validateFailureModes, validateObservedGoals, validatePreparation,
  type CallContext, type CreateInput, type DraftPatch, type Experiment, type HumanReviewInput, type Revision, type Runtime,
} from './contracts.js';
import { ExperimentStore } from './store.js';
import { evaluateTrial } from './evaluation.js';
import { awaitingVerdict, compareTrials, isAgentFailure, plannedTrials } from './comparison.js';
import { targetFingerprint } from './target-version.js';
import { preflightTarget } from './targets.js';
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
    goldenCases: record.goldenCases, dialogues: record.dialogues, profiles: record.profiles, notes: record.notes,
    scenarios: record.scenarios, agent: record.revisions[0]?.spec,
    targetVersion: record.targetVersion, targetFingerprint: record.targetFingerprint });
}
export function resultHash(record: Experiment): string {
  return fingerprint({ draft: draftHash(record), trials: record.trials, humanReviews: record.humanReviews ?? [] });
}
export function measurementHash(record: Experiment): string {
  return fingerprint({ version: VERSION, workflow: record.workflow, task: record.task, baseline: record.revisions[0], mode: record.mode, sources: record.sources, requirements: record.requirements, scenarios: record.scenarios, settings: record.settings,
    target: record.target, goldenCases: record.goldenCases, dialogues: record.dialogues, profiles: record.profiles, notes: record.notes,
    targetVersion: record.targetVersion, targetFingerprint: record.targetFingerprint });
}
function revision(spec: Revision['spec'], parentId: string | null, hypothesis: string): Revision {
  return { id: fingerprint(spec), parentId, spec: structuredClone(spec), hypothesis, createdAt: new Date().toISOString() };
}

function freshDraft(previous: Experiment, scenarioIds?: string[]): Experiment {
  const record = structuredClone(previous);
  if (scenarioIds) {
    if (!scenarioIds.length || new Set(scenarioIds).size !== scenarioIds.length
      || scenarioIds.some(id => !record.scenarios.some(s => s.id === id))) throw new Error('Выберите существующие тесты без повторов.');
    record.scenarios = record.scenarios.filter(s => scenarioIds.includes(s.id));
    record.selectedScenarioIds = [...scenarioIds];
  }
  Object.assign(record, { id: randomUUID(), parentRunId: previous.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    phase: 'review', message: 'Тесты готовы. Проверьте подключение и запустите проверку.',
    trials: [], comparisons: [], iterations: [], humanReviews: [], usage: emptyUsage(),
    reviewedAt: null, reviewMode: null, manifestHash: null, controlConsumedAt: null, error: null });
  delete record.resultsReviewedAt; delete record.resultsReviewHash; delete record.failureModes;
  record.limitations = previous.limitations.filter(note => !note.startsWith('Scripted mode skipped') && !note.startsWith('Не удалось назвать типы провалов:'));
  return record;
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
    if (this.closed) throw new Error('Лаборатория не открыта.');
    // ponytail: one active local experiment; use per-experiment workers when concurrent runs are needed.
    if (this.active || (!ownsMutation && this.mutation)) throw new Error('Уже идёт другая операция над экспериментом. Дождитесь её или остановите.');
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
    if (input.workflow === 'compare' && input.settings.userModes.length !== 1) throw new Error('Сравнительный эксперимент идёт в одном режиме пользователя: выберите static, scripted или reactive.');
    if (input.workflow === 'compare' && input.target.kind !== 'sandbox') throw new Error('Для внешнего агента используйте evaluate и повтор набора; автоматический ремонт поддерживает только песочницу.');
    const now = new Date().toISOString();
    const record: Experiment = {
      schemaVersion: '1', id: randomUUID(), task: input.task, mode: input.mode, createdAt: now, updatedAt: now,
      phase: 'preparing', message: 'Подключаю агента и готовлю требования и первый тест.',
      sources: input.materials.map((m, i) => ({ id: `source-${i + 1}`, name: m.name, content: m.content, hash: fingerprint(m.content) })),
      settings: input.settings, requirements: [], questions: [], scenarios: [], revisions: [], selectedRevisionId: null,
      manifestHash: null, reviewedAt: null, reviewMode: null, controlConsumedAt: null, trials: [], comparisons: [], iterations: [],
      usage: emptyUsage(), error: null,
      workflow: input.workflow, humanReviews: [],
      target: input.target, goldenCases: input.goldenCases, dialogues: input.dialogues, profiles: input.profiles, notes: input.notes,
      ...(input.targetVersion ? { targetVersion: input.targetVersion } : {}),
      limitations: [
        input.target.kind === 'sandbox' ? 'Tools operate on isolated test records, not production systems. Only instructions and registered tool permissions are edited.' : 'External agent state and tool events are reported by its adapter. Isolation and reset of external services are the responsibility of that adapter.',
        'Scenario expectations require human review. Text matching checks measure literal content, not semantic correctness.',
        'Synthetic simulations do not establish performance with real users. Model rubric assessments are provisional and require human review.',
        'Model costs are observed usage estimates; unknown costs remain unknown. Call limits are not hard provider billing caps.',
        ...(input.mode === 'demo' ? ['Scripted demonstration: user/target behavior and the missing-tool repair are deterministic fixtures, not a measured LLM improvement.'] : []),
      ],
    };
    await this.launch(record, async ctx => {
      await preflightTarget(record.target);
      record.targetFingerprint = await targetFingerprint(record.target);
      const runtime = await this.runtime(record);
      if (record.dialogues.length && runtime.profiles) {
        // Observed persona text may only come from supplied dialogues; owner-written profiles stay first and keep their source label.
        const observed = (await runtime.profiles({ task: record.task, sources: structuredClone(record.sources), dialogues: structuredClone(record.dialogues) }, ctx)).map(p => observedProfileSchema.parse(p));
        const supplied = new Set(record.dialogues.map(d => d.id));
        for (const profile of observed) for (const id of profile.evidenceDialogueIds) if (!supplied.has(id)) throw new Error(`Profile ${profile.id} cites evidence dialogue ${id} that was not supplied`);
        record.profiles = [...record.profiles, ...observed];
      }
      if (new Set(record.profiles.map(p => p.id)).size !== record.profiles.length) throw new Error('У профилей повторяются идентификаторы.');
      // Real dialogues become production cards: the goal a real user pursued, opened with their own words.
      const observedGoals = record.dialogues.length && runtime.goals
        ? await runtime.goals({ task: record.task, sources: structuredClone(record.sources), dialogues: structuredClone(record.dialogues), profiles: structuredClone(record.profiles) }, ctx)
        : [];
      validateObservedGoals(observedGoals, record.dialogues, record.profiles);
      const generated = await runtime.prepare({
        task: record.task, sources: record.sources, existingAgent: input.existingAgent, workflow: input.workflow, scenarioCount: input.scenarioCount,
        profiles: structuredClone(record.profiles), goldenCases: structuredClone(record.goldenCases), notes: record.notes, observedGoals: structuredClone(observedGoals),
        targetKind: record.target.kind,
      }, ctx);
      const production = observedGoals.map(goal => goalToScenario(goal, record.profiles.find(p => p.id === goal.profileId)));
      const golden = record.goldenCases.map(goldenToScenario);
      const prepared = validatePreparation({ ...generated, scenarios: [...generated.scenarios, ...production, ...golden] }, record.sources, input.workflow, record.profiles);
      Object.assign(record, { requirements: prepared.requirements, questions: prepared.questions, scenarios: prepared.scenarios });
      const baseline = revision(input.existingAgent ?? prepared.agent, null, input.workflow === 'evaluate' ? 'Agent configuration selected for dialogue evaluation.' : 'Original agent before measured improvements.');
      record.revisions.push(baseline); record.selectedRevisionId = baseline.id;
      await this.checkpoint(record, 'review', 'Тест готов. Проверьте запрос, ожидаемый результат и план запуска.');
    });
    return structuredClone(record);
  }
  async updateDraft(id: string, expectedHash: string, raw: DraftPatch): Promise<Experiment> {
    return this.change(async () => {
      const record = await this.store.get(id);
      if (record.phase !== 'review') throw new Error('Править можно только незапущенный черновик. Готовые доказательства остаются как есть, для изменений создайте новый эксперимент.');
      if (draftHash(record) !== expectedHash) throw new Error('Черновик изменился. Откройте карточки заново, прежде чем править.');
      const patch = draftPatchSchema.parse(raw);
      const beforeCards = new Map(record.scenarios.map(s => [s.id, s]));
      const removed = new Set(patch.removeScenarioIds ?? []);
      for (const id of removed) if (!beforeCards.has(id)) throw new Error(`Нет карточки для удаления: ${id}`);
      for (const scenario of patch.scenarios ?? []) {
        const before = record.scenarios.find(s => s.id === scenario.id);
        if (before && scenario.successCriteria !== before.successCriteria
          && fingerprint([scenario.checks, scenario.metrics ?? []]) === fingerprint([before.checks, before.metrics ?? []])) {
          throw new Error(`Ожидание «${scenario.title}» изменилось, а исполняемые проверки остались прежними. Измените checks или metrics вместе с successCriteria; описание само по себе не меняет тест.`);
        }
        if (scenario.profileId && before?.profileId === scenario.profileId && !patch.profileEdits?.some(e => e.id === scenario.profileId)
          && fingerprint([scenario.user.persona, scenario.user.characteristics]) !== fingerprint([before.user.persona, before.user.characteristics])) {
          throw new Error(`Карточка ${scenario.id} связана с профилем ${scenario.profileId}. Измените profileEdits или уберите profileId, чтобы задать отдельную персону.`);
        }
      }
      for (const edit of patch.profileEdits ?? []) {
        const profile = record.profiles.find(p => p.id === edit.id);
        if (!profile) throw new Error(`Неизвестный профиль: ${edit.id}`);
        if (edit.override === null) delete profile.draftOverride;
        else profile.draftOverride = edit.override;
      }
      const agent = patch.agent ?? record.revisions[0]?.spec;
      const cards = new Map(record.scenarios.filter(s => !removed.has(s.id)).map(({ split: _split, ...s }) => [s.id, s]));
      for (const { split: _split, ...scenario } of patch.scenarios ?? []) cards.set(scenario.id, scenario);
      const scenarios = [...cards.values()];
      const prepared = validatePreparation({ requirements: record.requirements, questions: record.questions, agent, scenarios }, record.sources, record.workflow ?? 'compare', record.profiles);
      record.scenarios = prepared.scenarios;
      if (patch.agent) record.revisions = [revision(patch.agent, null, 'Agent configuration reviewed in the draft.')];
      record.settings = settingsSchema.parse({ ...record.settings, ...patch.settings });
      if (patch.target) record.target = patch.target;
      if (patch.targetVersion) record.targetVersion = patch.targetVersion;
      await preflightTarget(record.target);
      record.targetFingerprint = await targetFingerprint(record.target);
      record.selectedRevisionId = record.revisions[0]!.id;
      record.reviewedAt = null; record.reviewMode = null; record.manifestHash = null;
      const added = record.scenarios.filter(s => !beforeCards.has(s.id)).length;
      const changed = record.scenarios.filter(s => beforeCards.has(s.id) && fingerprint(s) !== fingerprint(beforeCards.get(s.id))).length;
      await this.checkpoint(record, 'review', `${patch.agent ? 'Агент обновлён. ' : ''}${patch.settings || patch.target || patch.targetVersion ? 'Настройки прогона обновлены. ' : ''}Карточки: изменено ${changed}, добавлено ${added}, удалено ${removed.size}. Проверьте черновик перед запуском.`);
      return structuredClone(record);
    });
  }
  /** Reuse the exact reviewed materials and cards; only evidence and approvals start afresh. */
  async repeat(id: string, scenarioIds?: string[]): Promise<Experiment> {
    return this.change(async () => {
      const previous = await this.store.get(id);
      if (previous.workflow !== 'evaluate' || !previous.reviewedAt || runningPhases.has(previous.phase)) {
        throw new Error('Повторить можно остановленный или завершённый прогон с утверждёнными карточками.');
      }
      const record = freshDraft(previous, scenarioIds);
      record.targetFingerprint = await targetFingerprint(record.target);
      await this.store.save(record);
      return structuredClone(record);
    });
  }
  /** A versionable local definition: provenance survives, run results and approvals do not. */
  async saveSuite(id: string, file: string, scenarioIds?: string[]): Promise<string> {
    const previous = await this.get(id);
    if (previous.workflow !== 'evaluate' || !previous.scenarios.length || runningPhases.has(previous.phase)) throw new Error('Сначала дождитесь готовых тестов.');
    const definition = freshDraft(previous, scenarioIds);
    const path = resolve(file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ format: 'agent-lab-suite-1', definition }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return path;
  }
  async loadSuite(file: string, scenarioIds?: string[]): Promise<Experiment> {
    return this.change(async () => {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      if (raw.format !== 'agent-lab-suite-1') throw new Error('Нужен файл тестов Agent Lab, сохранённый через save-suite.');
      const previous = experimentSchema.parse(raw.definition);
      if (previous.workflow !== 'evaluate') throw new Error('Файл должен содержать обычные тесты evaluate.');
      const record = freshDraft(previous, scenarioIds);
      // Keep the original run as the comparison source, not the exported draft's temporary ID.
      record.parentRunId = previous.parentRunId;
      const prepared = validatePreparation({ requirements: record.requirements, questions: record.questions,
        agent: record.revisions[0]?.spec, scenarios: record.scenarios.map(({ split: _split, ...s }) => s) }, record.sources, 'evaluate', record.profiles);
      record.scenarios = prepared.scenarios;
      await preflightTarget(record.target);
      record.targetFingerprint = await targetFingerprint(record.target);
      await this.store.save(record);
      return structuredClone(record);
    });
  }
  async addHumanReview(id: string, raw: HumanReviewInput): Promise<Experiment> {
    return this.change(async () => {
      const record = await this.store.get(id);
      if (record.workflow !== 'evaluate' || !['results_review', 'complete'].includes(record.phase)) throw new Error('Вердикты человека можно ставить только по завершённым диалогам.');
      const input = humanReviewInputSchema.parse(raw);
      const trial = record.trials.find(t => t.id === input.trialId);
      if (!trial) throw new Error('Такого диалога в этом эксперименте нет.');
      if (input.checkId && !trial.checks.some(c => c.id === input.checkId)) throw new Error('Такой объективной проверки в этом диалоге нет.');
      const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
      if (input.metricId && !scenario?.metrics?.some(m => m.id === input.metricId)) throw new Error('Такой рубрики в этой карточке нет.');
      (record.humanReviews ??= []).push({ ...input, id: randomUUID(), createdAt: new Date().toISOString() });
      delete record.resultsReviewedAt; delete record.resultsReviewHash;
      await this.checkpoint(record, 'results_review', 'Human annotation saved separately from the original assessment.');
      return structuredClone(record);
    });
  }
  async reviewResults(id: string, expectedHash: string): Promise<Experiment> {
    return this.change(async () => {
      const record = await this.store.get(id);
      if (record.workflow !== 'evaluate' || record.phase !== 'results_review') throw new Error('Нет завершённого набора диалогов, ожидающего аудита.');
      if (resultHash(record) !== expectedHash) throw new Error('Результаты изменились. Откройте их заново, прежде чем подтверждать аудит.');
      const pending = awaitingVerdict(record).size;
      if (pending) throw new Error(`Нельзя завершить разбор: ${pending} диалогов без решения. Оцените проваленные критерии или весь диалог. Если ошибочен сам тест, отметьте весь диалог «Невалидный тест» с причиной; «неясно» оставляет вопрос открытым.`);
      record.resultsReviewedAt = new Date().toISOString(); record.resultsReviewHash = expectedHash;
      await this.checkpoint(record, 'complete', 'Human review complete. Original checks, model estimates and human annotations remain separate.');
      return structuredClone(record);
    });
  }
  async start(id: string, options: { approved: boolean; reviewer?: 'human' | 'automated'; expectedHash?: string }): Promise<Experiment> {
    return this.change(async () => {
      const record = await this.store.get(id);
      if (record.phase !== 'review') throw new Error('Запустить можно только эксперимент, ожидающий проверки. Чтобы поменять набор карточек, создайте новый.');
      if (record.workflow === 'compare' && (record.target.kind !== 'sandbox' || record.settings.userModes.length !== 1)) throw new Error('Автоматическое сравнение поддерживает только песочницу и один режим пользователя.');
      if (!options.approved) throw new Error('Набор карточек замораживается только после вашего подтверждения.');
      if (record.workflow === 'evaluate' && options.expectedHash !== draftHash(record)) {
        throw new Error('Нужно подтверждение именно этой версии черновика. Откройте свежие тесты и план запуска.');
      }
      if (record.questions.length) throw new Error('Сначала ответьте на бизнес-вопросы из черновика: добавьте ответы в материалы и подготовьте новый эксперимент.');
      if (record.settings.userModes.includes('scripted')) for (const scenario of record.scenarios) {
        const issue = scriptIssue(scenario.user, record.settings.maxTurns);
        if (issue) throw new Error(`${scenario.title}: ${issue}`);
      }
      await preflightTarget(record.target);
      if (record.targetFingerprint && record.targetFingerprint !== await targetFingerprint(record.target)) {
        throw new Error('Код агента изменился после подготовки карточек. Обновите подключение в настройках и подтвердите новую версию.');
      }
      record.reviewedAt = new Date().toISOString();
      record.reviewMode = options.reviewer ?? 'human';
      if (record.reviewMode === 'automated') record.limitations.push('Generated scenario expectations were checked automatically, without human validation. Results are provisional synthetic evidence.');
      record.manifestHash = measurementHash(record);
      record.phase = record.workflow === 'evaluate' ? 'evaluating' : 'baseline';
      record.message = record.workflow === 'evaluate' ? 'Выполняю согласованный план проверки.' : 'Starting the frozen development comparison.';
      await this.launch(record, ctx => record.workflow === 'evaluate' ? this.evaluateReviewed(record, ctx) : this.execute(record, ctx), true);
      return structuredClone(record);
    });
  }
  async cancel(id: string): Promise<Experiment> {
    if (this.active?.record.id !== id) throw new Error('Этот эксперимент сейчас не идёт.');
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
    const planned = plannedTrials({ ...record, scenarios });
    let completed = 0;
    for (const userMode of record.settings.userModes) {
      const skipped: string[] = [];
      const prefix = record.settings.userModes.length > 1 ? `[${userMode}] ` : '';
      for (const scenario of scenarios) {
        if (userMode === 'scripted' && scenario.user.script === undefined) { skipped.push(scenario.id); continue; }
        for (let repeat = 0; repeat < record.settings.repeats; repeat++) {
          guard();
          if (record.targetFingerprint && record.targetFingerprint !== await targetFingerprint(record.target)) throw new Error('Код внешнего агента изменился во время прогона. Создайте повтор с новой версией.');
          const progress = `${label}${prefix}${scenario.title} · диалог ${completed + 1}/${planned}`;
          record.message = `${progress} · открываем сессию`;
          const trial = await evaluateTrial({ runtime, revision, scenario, repeat, manifestHash: hash, sources: record.sources, settings: record.settings,
            onStage: stage => { record.message = `${progress} · ${{ target: 'ответ агента', user: 'реплика пользователя', assessment: 'оценка критериев' }[stage]}`; },
            ctx: { ...ctx, onTrace: (trialId, event) => {
              ctx.onTrace?.(trialId, event);
              const stage = event.type === 'user' ? 'ждём ответ агента' : event.type === 'assistant' ? 'ответ получен · готовим следующий шаг'
                : event.type === 'simulator' ? 'реплика симулятора готова' : event.type === 'tool_call' ? `инструмент ${event.tool ?? ''}`
                : event.type === 'tool_result' ? 'инструмент завершён' : 'сбой диалога';
              record.message = `${progress} · ${stage}`;
            } }, userMode, target: record.target });
          record.trials.push(trial);
          completed++;
          await this.checkpoint(record, record.phase, `${label}${prefix}${scenario.title} · ${repeat + 1}/${record.settings.repeats}`);
          if (record.targetFingerprint && record.targetFingerprint !== await targetFingerprint(record.target)) throw new Error('Код внешнего агента изменился во время диалога. Результат сохранён, но сравнение недоступно.');
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
    await this.nameFailureModes(record, runtime, ctx);
    await this.checkpoint(record, 'results_review', 'Диалоги и оценки готовы. Разберите провалы и проверьте поведение симулятора, прежде чем принимать результат.');
  }
  /**
   * Naming the failure precisely is what turns an evaluation into an improvement loop, so the
   * failed dialogues of a finished run are clustered and named. A single failure is not a
   * pattern, and a failed clustering must not lose a completed run: it is recorded as a
   * limitation instead.
   */
  private async nameFailureModes(record: Experiment, runtime: Runtime, ctx: CallContext): Promise<void> {
    const failed = record.trials.filter(t => isAgentFailure(record, t));
    if (!runtime.failureModes || failed.length < 2) return;
    const failures = failed.map(trial => ({
      trialId: trial.id,
      card: record.scenarios.find(s => s.id === trial.scenarioId)?.title ?? trial.scenarioId,
      reason: trial.reason,
      failed: [
        ...trial.checks.filter(c => !c.passed).map(c => c.description),
        ...(trial.assessments ?? []).filter(a => a.result === 'fail').map(a => a.rationale),
      ],
      trace: trial.events.filter(e => e.type !== 'simulator')
        .map(e => `#${e.seq} ${e.type}${e.tool ? ` ${e.tool}` : ''}: ${e.text ?? JSON.stringify(e.result ?? e.args ?? '')}`).join('\n').slice(0, 12000),
    }));
    try {
      const modes = await runtime.failureModes({ task: record.task, failures }, ctx);
      validateFailureModes(modes, failed);
      record.failureModes = modes;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      record.limitations.push(`Не удалось назвать типы провалов: ${error instanceof Error ? error.message : String(error)}`);
    }
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
