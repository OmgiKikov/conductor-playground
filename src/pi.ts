import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type ResourceLoader, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { assessRepeated, JUDGE_PROTOCOL, JUDGE_RESPONSE_FORMAT } from './judge.js';
import { z } from 'zod';
import {
  agentSchema, failureModeSchema, observedGoalSchema, observedProfileSchema, preparationSchema, proposalSchema, requirementSchema, scenarioSchema,
  TOOL_NAMES, VERSION, fingerprint, simulatorFidelity, userTurnSchema, validateObservedGoals,
  type CallContext, type Runtime, type Settings, type TargetSession, type Tool,
} from './contracts.js';
import { GIGA_PROVIDER_ID, registerGigaProvider } from './giga-provider.js';
import { AGENT_ROLE, ASSESS_ROLE, DATA_BOUNDARY, EXTERNAL_CARDS_CLAUSE, FAILURE_MODES_ROLE, FAMILY_PLAN_ROLE, GOALS_ROLE, IMPROVE_ROLE, PROFILES_ROLE, REQUIREMENTS_ROLE, SIMULATOR_ROLE, TOOL_GUIDE, cardsRole } from './prompts.js';

type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;
const groundingSchema = z.strictObject({
  requirements: z.array(requirementSchema).min(1).max(30),
  questions: z.array(z.string().trim().min(1).max(2000)).max(12),
});
const familyPlanSchema = z.strictObject({ families: z.array(z.strictObject({
  familyId: scenarioSchema.shape.familyId,
  mechanism: z.string().trim().min(1).max(300),
  requirementIds: scenarioSchema.shape.requirementIds,
})).min(4).max(16) });
// New generated cards require an explicit interaction budget; older saved cards keep their original semantics.
// With observed profiles the model may only choose a profileId; persona text is copied from the profile later.
const generatedScenarioSchema = (external: boolean) => scenarioSchema.required({ successCriteria: true, assumptions: true, metrics: true })
  .extend({ user: scenarioSchema.shape.user.required({ maxFollowUps: true }) })
  .refine(s => external ? s.checks.length > 0 || s.metrics.some(m => m.subject === 'agent')
    : s.metrics.some(m => m.subject === 'agent') && s.metrics.some(m => m.subject === 'simulator'),
    'Provide an agent-goal rubric, or literal answer checks for an external goal; sandbox cards also need simulator fidelity')
  .refine(s => !external || s.checks.every(c => ['answer_equals', 'answer_contains', 'answer_omits'].includes(c.kind))
    && !Object.keys(s.initialState.records).length && !s.initialState.writableFields.length && !s.initialState.transientFailures,
    'Without an external state/tool contract use only source-grounded answer checks and an empty initialState; assess semantic answers with agent rubrics')
  .refine(s => !external || s.metrics.length < 8 && s.metrics.every(m => m.subject === 'agent' && m.id !== simulatorFidelity.id),
    'External generation uses at most 7 agent rubrics only; the harness adds user_fidelity for the simulator');
const simulatorReplySchema = z.strictObject({ done: userTurnSchema.shape.done, message: userTurnSchema.shape.message.optional() })
  .refine(v => v.done || !!v.message?.trim(), 'A continuing user turn needs a message')
  .describe('To stop immediately, return done:true and omit message. A nonempty message is always delivered to the target. done:true with a nonempty message means deliver this final user message, receive the target response, then end. done:true with an empty message means stop now without another target response.');
const authHelp = 'Войдите в Pi через /login или задайте ключ выбранного провайдера, затем выберите доступную модель. Живой прогон никогда не подменяется демо.';

export const evaluatorVersion = (settings: Settings): string => fingerprint({ protocol: VERSION, judge: JUDGE_PROTOCOL, simulator: SIMULATOR_ROLE,
  provider: settings.provider, model: settings.model, roles: settings.roles ?? {}, judgeModel: settings.judge });

/** Explicit resources avoid global/project extensions, skills, AGENTS files and prompt discovery. */
function resources(systemPrompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function controlledSession(
  modelRuntime: ModelRuntime, model: Model, systemPrompt: string, tools: Tool[],
  ctx: CallContext, maxTokens = 16384, temperature?: number, structuredJudge = false, thinkingLevel: 'off' | 'medium' = 'off',
): Promise<TargetSession> {
  ctx.signal.throwIfAborted();
  if (new Set(tools.map(t => t.name)).size !== tools.length
    || tools.some(t => !TOOL_NAMES.includes(t.name))) throw new Error('Unapproved or duplicate target tool');
  const executedCalls = new Set<string>();
  const pendingCalls = new Map<string, { tool: string; args: unknown }>();
  const customTools: ToolDefinition[] = tools.map(tool => ({
    name: tool.name, label: tool.name, description: tool.description,
    parameters: Type.Unsafe(tool.parameters), executionMode: 'sequential',
    async execute(id, args, signal) {
      ctx.signal.throwIfAborted();
      signal?.throwIfAborted();
      executedCalls.add(id);
      const result = await tool.execute(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) ?? 'null' }], details: {} };
    },
  }));
  const { session } = await createAgentSession({
    modelRuntime, model, thinkingLevel, resourceLoader: resources(systemPrompt),
    tools: tools.map(t => t.name), noTools: 'builtin', customTools,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
      enableAnalytics: false, enableInstallTelemetry: false, transport: 'sse',
    }),
  });
  let activeSignal = ctx.signal;
  let boundaryError: unknown;
  let closed = false;
  let responding = false;
  let pendingUsage = 0;
  const stream = session.agent.streamFunction;
  // Count every provider request, including continuations after tool calls. SDK/provider retries are disabled.
  session.agent.streamFunction = async (m, context, options) => {
    try {
      activeSignal.throwIfAborted();
      try { ctx.beforeCall(); }
      catch (error) { boundaryError = error; throw error; }
      pendingUsage++;
      return await stream(m, { ...context, systemPrompt }, {
        ...options, signal: AbortSignal.any([activeSignal, ...(options?.signal ? [options.signal] : [])]),
        timeoutMs: ctx.timeoutMs, maxRetries: 0, maxTokens: Math.min(maxTokens, model.maxTokens), ...(temperature === undefined ? {} : { temperature }),
        ...(structuredJudge ? { onPayload: (payload: unknown) => ({ ...(payload as Record<string, unknown>), response_format: JUDGE_RESPONSE_FORMAT }) } : {}),
      });
    } catch (error) {
      // Preserve our own budget/cancellation error; provider errors are sanitized at the response boundary.
      if (activeSignal.aborted) boundaryError = activeSignal.reason;
      throw error;
    }
  };
  const unsubscribe = session.subscribe(event => {
    const emit = (value: Parameters<NonNullable<CallContext['onTargetEvent']>>[0]) => {
      try { ctx.onTargetEvent?.(value); }
      catch (error) { boundaryError = error; session.agent.abort(); throw error; }
    };
    if (event.type === 'tool_execution_start') {
      pendingCalls.set(event.toolCallId, { tool: event.toolName, args: event.args });
    }
    if (event.type === 'tool_execution_end') {
      const call = pendingCalls.get(event.toolCallId);
      // Trusted tools record their own state snapshots. Record only attempts rejected before execution here.
      if (call && !executedCalls.has(event.toolCallId)) {
        emit({ type: 'tool_call', ...call });
        emit({ type: 'tool_result', tool: call.tool, result: { ok: false, rejected: true, detail: event.result } });
      }
      pendingCalls.delete(event.toolCallId);
      executedCalls.delete(event.toolCallId);
    }
    if (event.type !== 'message_end' || event.message.role !== 'assistant') return;
    if (event.message.stopReason !== 'stop' || event.message.content.some(c => c.type === 'toolCall')) {
      const text = event.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (text.trim()) emit({ type: 'assistant', text });
    }
    if (!pendingUsage) return; // A rejected budget check can produce a synthetic SDK error, with no request dispatched.
    pendingUsage--;
    const usage = event.message.usage;
    const validCount = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    const cost = usage?.cost?.total;
    const hasUsage = usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(validCount);
    ctx.addUsage({
      inputTokens: hasUsage ? usage.input + usage.cacheRead + usage.cacheWrite : 0,
      outputTokens: hasUsage ? usage.output : 0,
      costUsd: hasUsage && validCount(cost) && usage.totalTokens > 0
        && Object.values(model.cost).some(n => typeof n === 'number' && n > 0)
        ? cost : null,
    });
  });
  return {
    async respond(message) {
      if (closed) throw new Error('Pi session is closed');
      if (responding) throw new Error('Pi session already has an active response');
      ctx.signal.throwIfAborted();
      responding = true;
      boundaryError = undefined;
      const deadline = new AbortController();
      activeSignal = AbortSignal.any([ctx.signal, deadline.signal]);
      const timer = setTimeout(() => deadline.abort(new Error('Pi request deadline exceeded')), ctx.timeoutMs);
      const start = session.messages.length;
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => { session.agent.abort(); reject(activeSignal.reason); };
        activeSignal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        await Promise.race([session.prompt(message, { expandPromptTemplates: false }), aborted]);
        activeSignal.throwIfAborted();
        if (boundaryError) throw boundaryError;
        const last = session.messages.slice(start).findLast(m => m.role === 'assistant');
        if (!last || last.role !== 'assistant' || last.stopReason !== 'stop') {
          // Persist only a fixed diagnostic category; SDK errors can contain credentials and URLs.
          const detail = last?.role === 'assistant' ? last.errorMessage ?? '' : '';
          const category = /429|rate.?limit/i.test(detail) ? 'rate limit'
            : /402|credit|balance/i.test(detail) ? 'insufficient credit'
            : /401|403|unauthorized|forbidden/i.test(detail) ? 'access denied'
            : /timeout|timed out/i.test(detail) ? 'timeout'
            : /fetch failed|connection|socket|network/i.test(detail) ? 'connection failure'
            : /context.?length|too many tokens/i.test(detail) ? 'context limit'
            : last?.role === 'assistant' ? last.stopReason : 'missing response';
          throw new Error(`Pi provider response incomplete: ${category}`);
        }
        const output = last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        if (!output.trim()) throw new Error('Модель вернула пустой ответ.');
        return output;
      } catch (error) {
        if (activeSignal.aborted) throw activeSignal.reason;
        if (boundaryError) throw boundaryError;
        // Provider errors may contain request headers or secret-bearing URLs. Do not persist their raw text.
        if (error instanceof Error && error.message.startsWith('Pi ')) throw error;
        throw new Error(`Запрос к ${model.provider}/${model.id} не прошёл. Проверьте доступ, права на модель и доступность провайдера.`);
      } finally {
        clearTimeout(timer);
        activeSignal.removeEventListener('abort', onAbort);
        responding = false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      session.agent.abort();
      unsubscribe();
      session.dispose();
      if (pendingUsage) {
        pendingUsage = 0;
        ctx.addUsage({ inputTokens: 0, outputTokens: 0, costUsd: null });
      }
    },
  };
}

/**
 * Models routinely wrap the object in a markdown fence, often after a sentence of
 * preamble, despite the instruction. A fence is an explicit delimiter, so the first
 * fenced block is taken as the answer. Bare JSON buried in prose stays a failure:
 * guessing where an object starts is not the same as reading a delimiter. The schema
 * still decides what is valid.
 */
function parseJsonOutput(output: string): unknown {
  try { return JSON.parse(output); } catch { /* fall through to the fenced form */ }
  const fenced = /```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```/.exec(output);
  if (!fenced?.[1]) throw new Error('Output is not JSON');
  return JSON.parse(fenced[1].trim());
}

/**
 * Repairing a nearly correct object is a much easier task for a model than writing one
 * from scratch, so a rejected answer goes back into the same session with the exact
 * reason. Attempts are bounded: after the third the run fails out loud instead of
 * spinning and spending the owner's budget. Rejection text is model-facing and stays
 * English, like the roles; what the owner reads is translated at the throw site.
 */
const REPAIR_ATTEMPTS = 3;

async function jsonResponse<S extends z.ZodType>(
  modelRuntime: ModelRuntime, model: Model, label: string, role: string, input: unknown, schema: S, ctx: CallContext,
  review?: (value: z.infer<S>) => string | undefined,
): Promise<z.infer<S>> {
  const prompt = `${role}\n${DATA_BOUNDARY}\nReturn exactly one compact JSON object, without markdown fences or pretty-printing whitespace, matching this JSON schema:\n${JSON.stringify(z.toJSONSchema(schema))}`;
  // Only target sessions contribute target trace events; simulator/planner events cannot affect target grades.
  const session = await controlledSession(modelRuntime, model, prompt, [], { ...ctx, onTargetEvent: undefined });
  try {
    let message = JSON.stringify(input);
    let rejection = '';
    for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt++) {
      const output = await session.respond(message);
      let parsed: unknown;
      try { parsed = parseJsonOutput(output); rejection = ''; }
      catch { rejection = 'The reply was not a single JSON object.'; }
      if (!rejection) {
        const validated = schema.safeParse(parsed);
        if (!validated.success) {
          rejection = `These fields do not match the schema: ${validated.error.issues.map(i => `${i.path.join('.') || 'root'} (${i.message})`).join('; ')}.`;
        } else {
          const problem = review?.(validated.data);
          if (!problem) return validated.data;
          rejection = problem;
        }
      }
      message = `Your previous answer was rejected. ${rejection}\nReturn the corrected object in full, as one compact JSON object and nothing else.`;
    }
    throw new Error(`модель ${REPAIR_ATTEMPTS} раза подряд вернула ответ, который не проходит проверку. Последняя причина: ${rejection}`);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : 'шаг не удался'}`);
  } finally { await session.close(); }
}

export async function getPiStatus(injectedRuntime?: ModelRuntime): Promise<{
  models: Array<{ provider: string; id: string; name: string }>; error?: string;
}> {
  try {
    const signal = AbortSignal.timeout(10000);
    const runtime = injectedRuntime ?? await ModelRuntime.create({ allowModelNetwork: false, signal });
    if (!injectedRuntime) await registerGigaProvider(runtime, undefined, undefined, signal);
    const available = await runtime.getAvailable(undefined, { signal });
    return {
      models: available.map(m => ({ provider: m.provider, id: m.id, name: m.name })),
      ...(available.length ? {} : { error: authHelp }),
    };
  } catch { return { models: [], error: `Не удалось прочитать список доступных моделей. ${authHelp}` }; }
}

/** The optional SDK runtime is the integration seam for custom providers and offline SDK checks. */
export async function createPiRuntime(settings: Settings, injectedRuntime?: ModelRuntime): Promise<Runtime> {
  if (!settings.provider || !settings.model) throw new Error(`Выберите провайдера и модель. ${authHelp}`);
  const signal = AbortSignal.timeout(settings.timeoutMs);
  let modelRuntime: ModelRuntime;
  try { modelRuntime = injectedRuntime ?? await ModelRuntime.create({ allowModelNetwork: false, signal }); }
  catch { throw new Error(`Не удалось инициализировать Pi. ${authHelp}`); }
  if (!injectedRuntime) await registerGigaProvider(modelRuntime, undefined, undefined, signal);
  const model = modelRuntime.getModel(settings.provider, settings.model);
  if (!model) throw new Error(`Выбранная модель недоступна: ${settings.provider}/${settings.model}. ${authHelp}`);
  let available: Awaited<ReturnType<ModelRuntime['getAvailable']>>;
  try { available = await modelRuntime.getAvailable(settings.provider, { signal }); }
  catch { throw new Error(`Не удалось проверить доступ к моделям. ${authHelp}`); }
  if (!available.some(m => m.id === model.id)) throw new Error(authHelp);
  const ask = async <S extends z.ZodType>(label: string, role: string, input: unknown, schema: S, ctx: CallContext,
    review?: (value: z.infer<S>) => string | undefined): Promise<z.infer<S>> => {
    const choice = settings.roles?.[role === ASSESS_ROLE ? 'judge' : role === SIMULATOR_ROLE ? 'simulator' : 'builder'];
    let selected = model;
    if (choice) {
      const override = modelRuntime.getModel(choice.provider, choice.model);
      const models = await modelRuntime.getAvailable(choice.provider, { signal: ctx.signal });
      if (!override || !models.some(m => m.id === override.id)) throw new Error(`Модель роли недоступна: ${choice.provider}/${choice.model}. ${authHelp}`);
      selected = override;
    }
    return jsonResponse(modelRuntime, selected, label, role, input, schema, ctx, review);
  };
  return {
    async prepare(input, ctx) {
      const grounding = await ask(
        'Требования',
        REQUIREMENTS_ROLE,
        { task: input.task, sources: input.sources.map(({ id, name, content }) => ({ id, name, content })) },
        groundingSchema, ctx,
        value => {
          for (const requirement of value.requirements) {
            const source = input.sources.find(s => s.id === requirement.sourceId);
            if (!source) return `Requirement ${requirement.id} cites source ${requirement.sourceId}, which was not supplied.`;
            if (!source.content.includes(requirement.quote)) {
              return `Requirement ${requirement.id}: the quote is not a verbatim substring of "${source.name}". Copy the exact characters from that source instead of paraphrasing.`;
            }
          }
          return undefined;
        },
      );
      const evidence = { task: input.task, requirements: grounding.requirements, questions: grounding.questions };
      const requirementIds = new Set(grounding.requirements.map(r => r.id));
      if (requirementIds.size !== grounding.requirements.length) throw new Error('Requirements: duplicate requirement IDs');
      const compare = input.workflow === 'compare';
      const external = !!input.targetKind && input.targetKind !== 'sandbox';
      const plan = compare ? await ask(
        'План семейств сценариев',
        FAMILY_PLAN_ROLE,
        evidence, familyPlanSchema, ctx,
        value => {
          if (new Set(value.families.map(f => f.familyId)).size !== value.families.length) return 'Two families share the same familyId; each family must be distinct.';
          for (const family of value.families) {
            if (new Set(family.requirementIds).size !== family.requirementIds.length) return `Family "${family.familyId}" lists the same requirement twice.`;
            const unknown = family.requirementIds.filter(id => !requirementIds.has(id));
            if (unknown.length) return `Family "${family.familyId}" references requirements that do not exist: ${unknown.join(', ')}.`;
          }
          return undefined;
        },
      ) : undefined;
      const scenarios: z.infer<typeof scenarioSchema>[] = [];
      const scenarioIds = new Set<string>();
      const total = plan?.families.length ?? input.scenarioCount ?? 5;
      const batchLimit = compare ? 4 : 3;
      // Evaluation needs only the requested goals; a separate family plan is reserved for version comparison.
      for (let offset = 0; offset < total; offset += batchLimit) {
        const requestedFamilies = plan?.families.slice(offset, offset + batchLimit);
        const batchSize = Math.min(batchLimit, total - offset);
        const batchLabel = `Карточки, партия ${Math.floor(offset / batchLimit) + 1}${requestedFamilies ? ` (${requestedFamilies.map(f => f.familyId).join(', ')})` : ''}`;
        const profiles = input.profiles ?? [];
        const observedGoals = input.observedGoals ?? [];
        const cards = await ask(
          batchLabel,
          cardsRole(compare, profiles.length > 0, observedGoals.length > 0) + (external ? `\n${EXTERNAL_CARDS_CLAUSE}` : ''),
          {
            ...evidence,
            ...(input.notes ? { ownerNotes: input.notes } : {}),
            ...(profiles.length ? { observedProfiles: profiles } : {}),
            ...(observedGoals.length ? { observedGoals: observedGoals.map(g => ({ id: g.id, goal: g.goal, profileId: g.profileId })) } : {}),
            ...(plan ? { familyPlan: plan.families, requestedFamilies } : {
              scenarioCount: total, requestedCount: batchSize,
              earlierGoals: scenarios.map(s => ({ id: s.id, familyId: s.familyId, goal: s.user.goal })),
            }),
          },
          z.strictObject({ scenarios: z.array(generatedScenarioSchema(external)).length(batchSize) }), ctx,
          // Pure review: attribution problems are a reason for the model to rewrite the
          // batch, not a reason to lose the whole run. Nothing is recorded until it passes.
          value => {
            const seen = new Set<string>();
            for (const scenario of value.scenarios) {
              const family = requestedFamilies?.find(f => f.familyId === scenario.familyId);
              if (requestedFamilies && !family) return `Card ${scenario.id} claims family "${scenario.familyId}", which was not requested in this batch.`;
              if (requestedFamilies && seen.has(scenario.familyId)) return `Family "${scenario.familyId}" is used by two cards in this batch; each requested family needs exactly one card.`;
              if (scenarioIds.has(scenario.id)) return `Card id "${scenario.id}" was already used by an earlier card; ids must be unique across the suite.`;
              if (scenario.profileId !== undefined && !profiles.some(p => p.id === scenario.profileId)) {
                return `Card ${scenario.id} references profile "${scenario.profileId}", which does not exist. Choose one of: ${profiles.map(p => p.id).join(', ') || 'none supplied'}.`;
              }
              if (new Set(scenario.requirementIds).size !== scenario.requirementIds.length) return `Card ${scenario.id} lists the same requirement twice.`;
              const unknown = scenario.requirementIds.filter(id => !requirementIds.has(id));
              if (unknown.length) return `Card ${scenario.id} references requirements that do not exist: ${unknown.join(', ')}.`;
              const missing = family?.requirementIds.filter(id => !scenario.requirementIds.includes(id)) ?? [];
              if (missing.length) return `Card ${scenario.id} must cover the requirements of its family: ${missing.join(', ')}.`;
              seen.add(scenario.familyId);
            }
            return undefined;
          },
        );
        for (const scenario of cards.scenarios) {
          if (external) scenario.metrics.push({ ...simulatorFidelity });
          scenarioIds.add(scenario.id); scenarios.push(scenario);
        }
      }
      // An external target answers with its own agent, so a sandbox AgentSpec would be
      // built, paid for and never used.
      const agent = input.existingAgent
        ?? (input.targetKind && input.targetKind !== 'sandbox'
          ? { name: 'External agent', instructions: 'The agent under evaluation runs outside Agent Lab and keeps its own instructions and tools.', tools: [] }
          : await ask('Сборка агента', AGENT_ROLE, evidence, agentSchema, ctx));
      return preparationSchema.parse({ ...grounding, scenarios, agent });
    },
    async goals(input, ctx) {
      const result = await ask(
        'Цели из реальных диалогов',
        GOALS_ROLE,
        {
          task: input.task,
          profiles: input.profiles.map(({ id, persona, characteristics }) => ({ id, persona, characteristics })),
          dialogues: input.dialogues.map(d => ({ id: d.id, outcome: d.outcome, userMessages: d.messages.filter(m => m.role === 'user').map(m => m.content) })),
        },
        z.strictObject({ goals: z.array(observedGoalSchema).min(1).max(20) }), ctx,
      );
      try { validateObservedGoals(result.goals, input.dialogues, input.profiles); }
      catch (error) { throw new Error(`Observed goals: ${error instanceof Error ? error.message : String(error)}`); }
      return result.goals;
    },
    async failureModes(input, ctx) {
      const known = new Set(input.failures.map(f => f.trialId));
      const result = await ask(
        'Разбор провалов',
        FAILURE_MODES_ROLE,
        { task: input.task, failures: input.failures },
        z.strictObject({ modes: z.array(failureModeSchema).min(1).max(12) }), ctx,
        value => {
          for (const mode of value.modes) {
            const unknown = mode.trialIds.filter(id => !known.has(id));
            if (unknown.length) return `Cluster ${mode.id} cites dialogues that are not in the supplied failures: ${unknown.join(', ')}.`;
            if (/^(bad|poor|wrong|incorrect|quality|agent failed|плохой|неверный)/i.test(mode.name.trim())) {
              return `Cluster ${mode.id} is named "${mode.name}", which does not say what went wrong. Name the specific behaviour visible in the traces.`;
            }
          }
          return undefined;
        },
      );
      return result.modes;
    },
    async profiles(input, ctx) {
      const supplied = new Set(input.dialogues.map(d => d.id));
      const result = await ask(
        'Профили пользователей',
        PROFILES_ROLE,
        // Assistant turns stay out: a profile describes how the user writes, not what the business answered.
        { task: input.task, dialogues: input.dialogues.map(d => ({ id: d.id, outcome: d.outcome, userMessages: d.messages.filter(m => m.role === 'user').map(m => m.content) })) },
        z.strictObject({ profiles: z.array(observedProfileSchema).max(6) }), ctx,
      );
      for (const profile of result.profiles) for (const id of profile.evidenceDialogueIds) if (!supplied.has(id)) throw new Error(`User profiles: profile ${profile.id} cites evidence dialogue ${id} that was not supplied`);
      return result.profiles;
    },
    async improve(input, ctx) {
      if (input.feedback.some(f => f.scenario.split !== 'dev' || f.trials.some(t => t.split !== 'dev'))) {
        throw new Error('Builder input must contain development evidence only');
      }
      return ask(
        'Улучшение агента',
        IMPROVE_ROLE,
        { task: input.task, requirements: input.requirements, agent: input.agent, feedback: input.feedback },
        proposalSchema, ctx,
      );
    },
    async assess(input, ctx) {
      const judge = settings.roles?.judge ?? settings.judge ?? { provider: settings.provider, model: settings.model };
      const upstream = settings.roles?.judge ? undefined : settings.judge?.upstream;
      const resolved = modelRuntime.getModel(judge.provider, judge.model);
      if (!resolved) throw new Error(`Judge model unavailable: ${judge.provider}/${judge.model}`);
      // Pi's catalog selects the Anthropic-native endpoint for Sonnet. OpenRouter
      // routing options belong to the Chat Completions adapter; use that adapter
      // explicitly instead of recording a routing preference the transport ignores.
      const judgeModel: Model = judge.provider === 'openrouter' ? {
        ...resolved, api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1',
        compat: { ...resolved.compat, supportsDeveloperRole: false, maxTokensField: 'max_tokens', ...(upstream ? {
          openRouterRouting: { only: [upstream], allow_fallbacks: false },
        } : {}) },
      } : resolved;
      // giga speaks the same strict-schema contract as the OpenRouter adapter (see
      // normalizeResponseFormat in giga-protocol.ts); without this the judge hook below
      // never installs and the judge falls back to unstructured free-form output.
      const structuredJudge = judge.provider === 'openrouter' || judge.provider === GIGA_PROVIDER_ID;
      return assessRepeated(input, { ...judgeModel,
        configurationHash: fingerprint({ api: judgeModel.api, baseUrl: judgeModel.baseUrl, compat: judgeModel.compat,
          temperature: judgeModel.reasoning ? 'default' : 0, thinking: judgeModel.reasoning ? 'medium' : 'off' }),
        transport: { api: judgeModel.api, upstream, structured: structuredJudge },
      }, ctx, async (prompt, data, recordPartial) => {
        const session = await controlledSession(modelRuntime, judgeModel, prompt, [], { ...ctx, onTargetEvent: event => {
          if (event.type === 'assistant' && event.text) recordPartial(event.text);
        } }, 16384, judgeModel.reasoning ? undefined : 0, structuredJudge, judgeModel.reasoning ? 'medium' : 'off');
        try { return await session.respond(data); } finally { await session.close(); }
      });
    },
    async openTarget(agent, sources, tools, ctx) {
      agentSchema.parse(agent);
      const allowed = tools.filter(t => agent.tools.includes(t.name));
      if (agent.tools.some(name => !allowed.some(t => t.name === name))) throw new Error('Target requested an unregistered tool');
      return controlledSession(modelRuntime, model,
        `${agent.instructions}\n\n${DATA_BOUNDARY}\n${TOOL_GUIDE}\nAvailable material names: ${JSON.stringify(sources.map(s => s.name))}. Use search_materials when needed.`,
        allowed, ctx, 4096,
      );
    },
    async userTurn(input, ctx) {
      const reply = await ask(
        'Реплика пользователя',
        SIMULATOR_ROLE,
        {
          user: {
            goal: input.user.goal, persona: input.user.persona, characteristics: input.user.characteristics,
            facts: input.user.facts, behavior: input.user.behavior, opening: input.user.opening, maxFollowUps: input.user.maxFollowUps,
          },
          messages: input.messages.map(({ role, content }) => ({ role, content })), turn: input.turn,
        }, simulatorReplySchema, ctx,
      );
      return { ...reply, message: reply.message ?? '' };
    },
  };
}
