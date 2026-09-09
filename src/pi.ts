import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type ResourceLoader, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { z } from 'zod';
import {
  agentSchema, metricAssessmentSchema, observedGoalSchema, preparationSchema, profileSchema, proposalSchema, requirementSchema, scenarioSchema,
  TOOL_NAMES, userTurnSchema, validateObservedGoals,
  type CallContext, type Runtime, type Settings, type TargetSession, type Tool,
} from './contracts.js';
import { AGENT_ROLE, ASSESS_ROLE, DATA_BOUNDARY, FAMILY_PLAN_ROLE, GOALS_ROLE, IMPROVE_ROLE, PROFILES_ROLE, REQUIREMENTS_ROLE, SIMULATOR_ROLE, TOOL_GUIDE, cardsRole } from './prompts.js';

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
const generatedScenarioSchema = (hasProfiles: boolean) => scenarioSchema.required({ successCriteria: true, assumptions: true, metrics: true })
  .extend({ user: scenarioSchema.shape.user.required({ maxFollowUps: true, persona: true, characteristics: true }) })
  .refine(s => s.metrics.some(m => m.subject === 'agent') && s.metrics.some(m => m.subject === 'simulator'), 'Agent-goal and simulator-fidelity metrics are both required')
  .refine(s => !hasProfiles || s.profileId !== undefined, { message: 'profileId must reference an observed profile', path: ['profileId'] });
const simulatorReplySchema = userTurnSchema.describe('A nonempty message is always delivered to the target. done:true with a nonempty message means deliver this final user message, receive the target response, then end. done:true with an empty message means stop now without another target response.');
const authHelp = 'Configure Pi with /login or set the selected provider API key, then select an authenticated model. Live mode never falls back to the demo.';

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
  ctx: CallContext, maxTokens = 16384,
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
    modelRuntime, model, thinkingLevel: 'off', resourceLoader: resources(systemPrompt),
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
        timeoutMs: ctx.timeoutMs, maxRetries: 0, maxTokens: Math.min(maxTokens, model.maxTokens),
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
      const text = event.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      if (text) emit({ type: 'assistant', text });
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
          throw new Error(`Pi did not finish a valid response (${last?.role === 'assistant' ? last.stopReason : 'missing response'}). Check provider access or raise the call limits.`);
        }
        const output = last.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
        if (!output) throw new Error('Pi returned an empty response');
        return output;
      } catch (error) {
        if (activeSignal.aborted) throw activeSignal.reason;
        if (boundaryError) throw boundaryError;
        // Provider errors may contain request headers or secret-bearing URLs. Do not persist their raw text.
        if (error instanceof Error && error.message.startsWith('Pi ')) throw error;
        throw new Error(`Pi request failed for ${model.provider}/${model.id}. Check authentication, model access and provider availability.`);
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

async function jsonResponse<S extends z.ZodType>(
  modelRuntime: ModelRuntime, model: Model, label: string, role: string, input: unknown, schema: S, ctx: CallContext,
): Promise<z.infer<S>> {
  const prompt = `${role}\n${DATA_BOUNDARY}\nReturn exactly one compact JSON object, without markdown fences or pretty-printing whitespace, matching this JSON schema:\n${JSON.stringify(z.toJSONSchema(schema))}`;
  // Only target sessions contribute target trace events; simulator/planner events cannot affect target grades.
  const session = await controlledSession(modelRuntime, model, prompt, [], { ...ctx, onTargetEvent: undefined });
  try {
    const output = await session.respond(JSON.stringify(input));
    let parsed: unknown;
    try { parsed = JSON.parse(output); }
    catch { throw new Error('Pi returned malformed JSON; the run is invalid. Inspect the role configuration and retry.'); }
    const validated = schema.safeParse(parsed);
    if (!validated.success) throw new Error(`Pi returned an invalid structured response: ${validated.error.issues.map(i => i.path.join('.') || 'root').join(', ')}`);
    return validated.data;
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : 'Pi role failed'}`);
  } finally { await session.close(); }
}

export async function getPiStatus(injectedRuntime?: ModelRuntime): Promise<{
  models: Array<{ provider: string; id: string; name: string }>; error?: string;
}> {
  try {
    const signal = AbortSignal.timeout(10000);
    const runtime = injectedRuntime ?? await ModelRuntime.create({ allowModelNetwork: false, signal });
    const available = await runtime.getAvailable(undefined, { signal });
    return {
      models: available.map(m => ({ provider: m.provider, id: m.id, name: m.name })),
      ...(available.length ? {} : { error: authHelp }),
    };
  } catch { return { models: [], error: `Cannot read Pi model availability. ${authHelp}` }; }
}

/** The optional SDK runtime is the integration seam for custom providers and offline SDK checks. */
export async function createPiRuntime(settings: Settings, injectedRuntime?: ModelRuntime): Promise<Runtime> {
  if (!settings.provider || !settings.model) throw new Error(`Select a provider and model. ${authHelp}`);
  const signal = AbortSignal.timeout(settings.timeoutMs);
  let modelRuntime: ModelRuntime;
  try { modelRuntime = injectedRuntime ?? await ModelRuntime.create({ allowModelNetwork: false, signal }); }
  catch { throw new Error(`Pi initialization failed. ${authHelp}`); }
  const model = modelRuntime.getModel(settings.provider, settings.model);
  if (!model) throw new Error(`Selected Pi model is unavailable: ${settings.provider}/${settings.model}. ${authHelp}`);
  let available: Awaited<ReturnType<ModelRuntime['getAvailable']>>;
  try { available = await modelRuntime.getAvailable(settings.provider, { signal }); }
  catch { throw new Error(`Cannot check Pi authentication. ${authHelp}`); }
  if (!available.some(m => m.id === model.id)) throw new Error(authHelp);
  const ask = <S extends z.ZodType>(label: string, role: string, input: unknown, schema: S, ctx: CallContext) =>
    jsonResponse(modelRuntime, model, label, role, input, schema, ctx);
  return {
    async prepare(input, ctx) {
      const grounding = await ask(
        'Requirements',
        REQUIREMENTS_ROLE,
        { task: input.task, sources: input.sources.map(({ id, name, content }) => ({ id, name, content })) },
        groundingSchema, ctx,
      );
      const evidence = { task: input.task, requirements: grounding.requirements, questions: grounding.questions };
      const requirementIds = new Set(grounding.requirements.map(r => r.id));
      if (requirementIds.size !== grounding.requirements.length) throw new Error('Requirements: duplicate requirement IDs');
      const compare = input.workflow === 'compare';
      const plan = compare ? await ask(
        'Scenario family plan',
        FAMILY_PLAN_ROLE,
        evidence, familyPlanSchema, ctx,
      ) : undefined;
      if (plan && new Set(plan.families.map(f => f.familyId)).size !== plan.families.length) throw new Error('Scenario family plan: duplicate family IDs');
      if (plan?.families.some(f => new Set(f.requirementIds).size !== f.requirementIds.length || f.requirementIds.some(id => !requirementIds.has(id)))) {
        throw new Error('Scenario family plan: unknown or duplicate requirement references');
      }
      const scenarios: z.infer<typeof scenarioSchema>[] = [];
      const scenarioIds = new Set<string>();
      const total = plan?.families.length ?? input.scenarioCount ?? 5;
      const batchLimit = compare ? 4 : 3;
      // Evaluation needs only the requested goals; a separate family plan is reserved for version comparison.
      for (let offset = 0; offset < total; offset += batchLimit) {
        const requestedFamilies = plan?.families.slice(offset, offset + batchLimit);
        const batchSize = Math.min(batchLimit, total - offset);
        const batchLabel = `Scenario cards batch ${Math.floor(offset / batchLimit) + 1}${requestedFamilies ? ` (${requestedFamilies.map(f => f.familyId).join(', ')})` : ''}`;
        const profiles = input.profiles ?? [];
        const observedGoals = input.observedGoals ?? [];
        const cards = await ask(
          batchLabel,
          cardsRole(compare, profiles.length > 0, observedGoals.length > 0),
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
          z.strictObject({ scenarios: z.array(generatedScenarioSchema(profiles.length > 0)).length(batchSize) }), ctx,
        );
        const seenFamilies = new Set<string>();
        for (const scenario of cards.scenarios) {
          const family = requestedFamilies?.find(f => f.familyId === scenario.familyId);
          if (requestedFamilies && (!family || seenFamilies.has(scenario.familyId))) throw new Error(`${batchLabel}: missing, duplicate or unrequested family`);
          if (scenarioIds.has(scenario.id)) throw new Error(`${batchLabel}: duplicate scenario ID`);
          if (scenario.profileId !== undefined && !profiles.some(p => p.id === scenario.profileId)) throw new Error(`${batchLabel}: unknown profileId ${scenario.profileId}`);
          if (new Set(scenario.requirementIds).size !== scenario.requirementIds.length
            || scenario.requirementIds.some(id => !requirementIds.has(id))
            || family?.requirementIds.some(id => !scenario.requirementIds.includes(id))) {
            throw new Error(`${batchLabel}: unknown, duplicate or missing requirement reference`);
          }
          seenFamilies.add(scenario.familyId); scenarioIds.add(scenario.id); scenarios.push(scenario);
        }
      }
      const agent = input.existingAgent ?? await ask(
        'Agent construction',
        AGENT_ROLE,
        evidence, agentSchema, ctx,
      );
      return preparationSchema.parse({ ...grounding, scenarios, agent });
    },
    async goals(input, ctx) {
      const result = await ask(
        'Observed goals',
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
    async profiles(input, ctx) {
      const supplied = new Set(input.dialogues.map(d => d.id));
      const result = await ask(
        'User profiles',
        PROFILES_ROLE,
        // Assistant turns stay out: a profile describes how the user writes, not what the business answered.
        { task: input.task, dialogues: input.dialogues.map(d => ({ id: d.id, outcome: d.outcome, userMessages: d.messages.filter(m => m.role === 'user').map(m => m.content) })) },
        z.strictObject({ profiles: z.array(profileSchema).min(1).max(6) }), ctx,
      );
      for (const profile of result.profiles) for (const id of profile.evidenceDialogueIds) if (!supplied.has(id)) throw new Error(`User profiles: profile ${profile.id} cites evidence dialogue ${id} that was not supplied`);
      return result.profiles;
    },
    async improve(input, ctx) {
      if (input.feedback.some(f => f.scenario.split !== 'dev' || f.trials.some(t => t.split !== 'dev'))) {
        throw new Error('Builder input must contain development evidence only');
      }
      return ask(
        'Agent improvement',
        IMPROVE_ROLE,
        { task: input.task, requirements: input.requirements, agent: input.agent, feedback: input.feedback },
        proposalSchema, ctx,
      );
    },
    async assess(input, ctx) {
      const metrics = input.scenario.metrics ?? [];
      if (!metrics.length) return [];
      const result = await ask(
        'Dialogue assessment',
        ASSESS_ROLE,
        {
          scenario: input.scenario,
          sources: input.sources.map(({ id, name, content }) => ({ id, name, content })),
          trial: { events: input.trial.events, initialState: input.trial.initialState, finalState: input.trial.finalState },
        },
        z.strictObject({ assessments: z.array(metricAssessmentSchema).length(metrics.length) }), ctx,
      );
      return result.assessments;
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
      return ask(
        'User simulation',
        SIMULATOR_ROLE,
        {
          user: {
            goal: input.user.goal, persona: input.user.persona, characteristics: input.user.characteristics,
            facts: input.user.facts, behavior: input.user.behavior, opening: input.user.opening, maxFollowUps: input.user.maxFollowUps,
          },
          messages: input.messages.map(({ role, content }) => ({ role, content })), turn: input.turn,
        }, simulatorReplySchema, ctx,
      );
    },
  };
}
