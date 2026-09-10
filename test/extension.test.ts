import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import agentLab from '../extensions/agent-lab.ts';
import { createDemoRuntime, demoInput } from '../src/demo.js';

function registered(onUserMessage?: (message: unknown) => void) {
  const tools = new Map<string, ToolDefinition>();
  const contexts: { content: string; display: boolean }[] = [];
  const userMessages: unknown[] = [];
  let shutdown!: () => Promise<void>;
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  agentLab({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: { handler: typeof command }) => { assert.equal(name, 'agent-lab'); command = options.handler; },
    on: (name: string, handler: () => Promise<void>) => { assert.equal(name, 'session_shutdown'); shutdown = handler; },
    sendMessage: (message: { content: string; display: boolean }, options: { deliverAs: string }) => { assert.equal(options.deliverAs, 'followUp'); contexts.push(message); },
    sendUserMessage: (message: unknown, options: { deliverAs: string; expandPromptTemplates: boolean }) => { assert.equal(options.deliverAs, 'followUp'); assert.equal(options.expandPromptTemplates, false); userMessages.push(message); onUserMessage?.(message); },
  } as unknown as ExtensionAPI);
  assert.ok(shutdown); assert.ok(command);
  return { tools, shutdown, command, contexts, userMessages };
}
function output(result: Awaited<ReturnType<ToolDefinition['execute']>>) {
  return JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
}

test('Pi connects a new request, conversational correction, reviewed run, evidence discussion and repeat without UI JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-journey-fixture-'));
  const { tools, shutdown, command, contexts, userMessages } = registered(() => {
    assert.equal(existsSync(join(directory, '.agent-lab', '.lock')), false, 'conversation starts only after the board releases its writer lock');
  });
  const errors: string[] = []; const editorCommands: string[] = [];
  const ctx = { cwd: directory, model: undefined, mode: 'tui', hasUI: true } as ExtensionCommandContext;
  let steps: string[][] = []; let request = ''; let awaitResults = false; let editorText = '';
  ctx.ui = {
    getEditorText: () => editorText,
    setEditorText: (text: string) => { editorText = text; editorCommands.push(text); },
    editor: async () => request,
    confirm: async () => true, // Explicit scripted test consent; never used for a live user or model.
    notify: (message: string, type: string) => { if (type === 'error') errors.push(message); },
    custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Component & { dispose?(): void }) => new Promise((resolve, reject) => {
      const component = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {}, value => { component.dispose?.(); resolve(value); });
      void (async () => {
        const keys = steps.shift(); assert.ok(keys, 'unexpected board');
        if (awaitResults && keys[0] !== 'r') {
          const deadline = Date.now() + 5000;
          while (!component.render(120).join('\n').includes('ПРОВЕРЬТЕ РЕЗУЛЬТАТЫ')) {
            if (Date.now() > deadline) throw new Error('fixture did not finish');
            await new Promise(r => setTimeout(r, 100));
          }
          awaitResults = false;
        }
        if (keys[0] === 'x') assert.match(component.render(120).join('\n'), /Исправлено 1, сломалось 0/);
        for (const key of keys) component.handleInput!(key);
      })().catch(error => { component.dispose?.(); reject(error); });
    }),
  } as unknown as ExtensionContext['ui'];
  const call = async (name: string, params: object) => output(await tools.get(name)!.execute(name, params, undefined, undefined, ctx));
  try {
    await command('/fixture/agent', ctx);
    assert.equal(userMessages[0], 'Проверь агента в /fixture/agent'); assert.equal(contexts[0]!.display, false);
    // The outer Pi model's actions are scripted here; real tools and the native board execute every state transition.
    const sample = demoInput();
    const fixture = await createDemoRuntime().prepare({ task: sample.task, sources: sample.materials.map(m => ({ ...m, id: 'source-1', hash: 'fixture' })), workflow: 'compare' },
      { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} });
    const built = await call('agent_lab_build', { mode: 'demo', scenarioCount: 1, existingAgent: fixture.agent });
    assert.equal(built.phase, 'review', built.error ?? 'draft not ready');
    assert.equal(built.trialCount, 0); assert.equal(built.reviewMode, null); assert.equal(editorCommands.at(-1), `/agent-lab ${built.id}`);
    steps = [['a']]; request = 'Убери персону: хочу проверить только задачу.';
    await command(built.id, ctx); assert.equal(userMessages.at(-1), request);
    const selected = JSON.parse(contexts.at(-1)!.content); assert.equal(selected.experimentId, built.id); assert.ok(selected.scenarioId, JSON.stringify(selected));
    editorText = 'Ещё пишу уточнение';
    const draft = await call('agent_lab_inspect', { id: built.id });
    assert.equal(editorText, 'Ещё пишу уточнение', 'tool must preserve unfinished user input'); editorText = '';
    delete draft.scenarios[0].user.persona; delete draft.scenarios[0].user.characteristics;
    const edited = await call('agent_lab_edit', { id: built.id, expectedHash: draft.draftHash, patch: { scenarios: draft.scenarios } });
    assert.notEqual(edited.draftHash, draft.draftHash); assert.equal(edited.trialCount, 0);
    steps = [['r'], ['a']]; awaitResults = true; request = 'Почему этот диалог провалился и что нужно исправить?';
    await command(built.id, ctx); assert.equal(userMessages.at(-1), request);
    const discussion = JSON.parse(contexts.at(-1)!.content); assert.equal(discussion.experimentId, built.id); assert.ok(discussion.trialId);
    const evidence = await call('agent_lab_inspect', { id: built.id, trialId: discussion.trialId });
    assert.equal(evidence.outcome, 'fail'); assert.ok(evidence.events.length); assert.ok(evidence.checks.some((c: { passed: boolean }) => !c.passed));
    steps = [['3', 'n'], ['f'], ['q']];
    await command(built.id, ctx);
    const reviewed = await call('agent_lab_inspect', { id: built.id, export: true });
    assert.equal(reviewed.phase, 'complete'); assert.equal(reviewed.humanReviews.length, 1);
    const original = await call('agent_lab_inspect', { id: built.id, trialId: discussion.trialId }); assert.deepEqual(original, evidence);
    const repeated = await call('agent_lab_repeat', { id: built.id });
    assert.equal(repeated.parentRunId, built.id); assert.equal(repeated.phase, 'review'); assert.equal(repeated.trialCount, 0); assert.equal(repeated.reviewMode, null);
    assert.equal(editorCommands.at(-1), `/agent-lab ${repeated.id}`);
    await call('agent_lab_edit', { id: repeated.id, expectedHash: repeated.draftHash, patch: {
      agent: { ...fixture.agent, tools: [...fixture.agent.tools, 'update_record'] }, targetVersion: 'fixture-fixed',
    } });
    steps = [['r'], ['d'], ['x'], ['q']]; awaitResults = true;
    await command(repeated.id, ctx);
    const exportDir = join(directory, '.agent-lab', 'exports');
    const html = (await readdir(exportDir)).find(name => name.startsWith(repeated.id) && name.endsWith('.html'));
    assert.ok(html); assert.match(await readFile(join(exportDir, html), 'utf8'), /Исправлено 1, сломалось 0/);
    assert.deepEqual(errors, []); assert.equal(steps.length, 0);
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('headless model tools prepare and edit only; approvals and human assessments are not callable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-extension-'));
  const { tools, shutdown, command } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'print', hasUI: false } as ExtensionContext;
  const updates: string[] = [];
  try {
    assert.deepEqual([...tools.keys()], ['agent_lab_build', 'agent_lab_inspect', 'agent_lab_edit', 'agent_lab_repeat']);
    const report = output(await tools.get('agent_lab_build')!.execute('build-1', { mode: 'demo', scenarioCount: 2 }, undefined,
      value => { updates.push(JSON.stringify(value)); }, ctx));
    assert.equal(report.phase, 'review'); assert.equal(report.workflow, 'evaluate');
    assert.equal(report.reviewMode, null); assert.equal(report.trialCount, 0);
    assert.equal(report.comparison, undefined); assert.equal(report.scenarioCount, 2);
    assert.ok(updates.length >= 1); assert.match(report.nextStep, /Человеку/);
    const evidence = JSON.parse(await readFile(report.artifacts.evidence, 'utf8'));
    assert.equal(evidence.settings.repeats, 1); assert.equal(evidence.trials.length, 0);
    assert.equal(evidence.controlConsumedAt, null);
    assert.deepEqual(JSON.parse(await readFile(report.artifacts.agent, 'utf8')), evidence.revisions[0].spec);
    assert.match(await readFile(report.artifacts.report, 'utf8'), /Проверка карточек: ожидается/);
    const inspect = output(await tools.get('agent_lab_inspect')!.execute('inspect-1', { id: report.id }, undefined, undefined, ctx));
    assert.equal(inspect.scenarios.length, 2); assert.equal(inspect.draftHash, report.draftHash);
    const scenarios = inspect.scenarios;
    scenarios[0].user.persona = 'Пользователь отредактирован в черновике';
    const edited = output(await tools.get('agent_lab_edit')!.execute('edit-1', { id: report.id, expectedHash: report.draftHash, patch: { scenarios } }, undefined, undefined, ctx));
    assert.notEqual(edited.draftHash, report.draftHash); assert.equal(edited.reviewMode, null); assert.equal(edited.trialCount, 0);
    await assert.rejects(tools.get('agent_lab_edit')!.execute('edit-stale', { id: report.id, expectedHash: report.draftHash, patch: { settings: { repeats: 2 } } }, undefined, undefined, ctx), /изменился/);
    await assert.rejects(tools.get('agent_lab_edit')!.execute('edit-approval', { id: report.id, expectedHash: edited.draftHash, patch: { approved: true, reviewMode: 'human' } }, undefined, undefined, ctx));
    await assert.rejects(command(report.id, ctx as ExtensionCommandContext), /native Pi terminal/);
    const unchanged = JSON.parse(await readFile(report.artifacts.evidence, 'utf8'));
    assert.equal(unchanged.reviewMode, null); assert.equal(unchanged.phase, 'review');
    await assert.rejects(access(join(directory, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('native profile editor changes linked cards, detaches one and restores original evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-profile-ui-fixture-'));
  const { tools, shutdown, command } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'tui', hasUI: true } as ExtensionCommandContext;
  try {
    const report = output(await tools.get('agent_lab_build')!.execute('prepare', { mode: 'demo', scenarioCount: 2,
      dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'move A101 to 14:00 pls' }] }],
    }, undefined, undefined, ctx));
    const steps = [['2', 'e'], ['e'], ['s'], ['q']];
    const choices = ['Персона', 'Профиль пользователя · выбрать или убрать', 'Без профиля и персоны', 'Профили пользователей', 'observed_1', 'Восстановить исходный профиль'];
    const errors: string[] = [];
    ctx.ui = {
      custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Component & { dispose?(): void }) => new Promise(resolve => {
        const component = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {}, value => { component.dispose?.(); resolve(value); });
        const step = steps.shift(); assert.ok(step);
        if (steps.length === 2) assert.match(component.render(120).join('\n'), /правка черновика/);
        for (const key of step) component.handleInput!(key);
      }),
      select: async (_title: string, labels: string[]) => {
        const choice = choices.shift(); const value = labels.find(label => label.startsWith(choice!));
        assert.ok(value, `missing choice ${choice} in ${labels.join(', ')}`); return value;
      },
      editor: async (title: string) => { assert.match(title, /3 карточек/); return 'Уточнённая роль'; },
      notify: (message: string, type: string) => { if (type === 'error') errors.push(message); },
    } as unknown as ExtensionContext['ui'];
    await command(report.id, ctx);
    assert.deepEqual(errors, []); assert.equal(choices.length, 0); assert.equal(steps.length, 0);
    const inspected = output(await tools.get('agent_lab_inspect')!.execute('inspect', { id: report.id, export: true }, undefined, undefined, ctx));
    assert.equal(inspected.profiles[0].draftOverride, undefined);
    assert.equal(inspected.profiles[0].source, 'observed'); assert.deepEqual(inspected.profiles[0].evidenceDialogueIds, ['d1']);
    assert.equal(inspected.scenarios[0].profileId, undefined); assert.equal(inspected.scenarios[0].user.persona, undefined);
    assert.equal(inspected.scenarios[1].user.persona, inspected.profiles[0].persona);
    assert.equal(inspected.trialCount, 0); assert.equal(inspected.reviewMode, null);
    const html = await readFile(inspected.artifacts.htmlReport, 'utf8');
    assert.match(html, /Без персоны/); assert.match(html, /Исходные профили и правки/); assert.match(html, /Выведен из логов/);
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('native command demo fixture requires two separate confirmations and preserves human annotation separately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-human-ui-fixture-'));
  const { tools, shutdown, command } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'tui', hasUI: true } as ExtensionCommandContext;
  try {
    const report = output(await tools.get('agent_lab_build')!.execute('prepare', { mode: 'demo', scenarioCount: 1 }, undefined, undefined, ctx));
    const errors: string[] = [];
    const confirmations: string[] = [];
    let screen = 0;
    let selection = 0;
    const keys = ['r', 'r', 'v', 'f', 'f', 'q'];
    ctx.ui = {
      custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Component & { dispose?(): void }) => new Promise((resolve, reject) => {
        let component: Component & { dispose?(): void };
        const current = screen++;
        const finish = (value: unknown) => { component.dispose?.(); resolve(value); };
        component = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {}, finish);
        assert.match(component.render(100).join('\n'), /AGENT LAB/);
        // Scripted integration fixture only: emulate native keyboard/confirm callbacks, never a live model or real user consent.
        const drive = async () => {
          if (current === 2) {
            const deadline = Date.now() + 4000;
            while (!component.render(100).join('\n').includes('ПРОВЕРЬТЕ РЕЗУЛЬТАТЫ')) {
              if (Date.now() > deadline) throw new Error('Demo did not reach results review');
              await new Promise(r => setTimeout(r, 100));
            }
          }
          assert.ok(keys[current], `unexpected board ${current}`);
          component.handleInput!(keys[current]!);
        };
        void drive().catch(error => { component.dispose?.(); reject(error); });
      }),
      confirm: async (_title: string, message: string) => {
        confirmations.push(message);
        assert.match(message, /[a-f0-9]{64}/, 'confirmation binds the exact displayed version');
        return confirmations.length === 2 || confirmations.length === 4;
      },
      select: async (_title: string, choices: string[]) => { selection++; return selection === 1 ? choices[0] : choices[1]; },
      editor: async () => 'Human fixture: disagreement with the model; see #1.',
      notify: (message: string, type: string) => { if (type === 'error') errors.push(message); },
    } as unknown as ExtensionContext['ui'];
    await command(report.id, ctx);
    assert.deepEqual(errors, []); assert.equal(confirmations.length, 4);
    assert.match(confirmations[0]!, /карточек/); assert.match(confirmations[2]!, /результатов/);
    const evidence = JSON.parse(await readFile(report.artifacts.evidence, 'utf8'));
    assert.equal(evidence.phase, 'complete'); assert.equal(evidence.reviewMode, 'human');
    assert.ok(evidence.resultsReviewedAt); assert.ok(evidence.resultsReviewHash);
    assert.equal(evidence.trials.length, 1); assert.equal(evidence.humanReviews.length, 1);
    assert.equal(evidence.humanReviews[0].verdict, 'fail'); assert.match(evidence.humanReviews[0].note, /fixture/);
    assert.ok(evidence.trials[0].assessments.length, 'original rubric assessments remain present');
    const trial = output(await tools.get('agent_lab_inspect')!.execute('inspect-trial', { id: report.id, trialId: evidence.trials[0].id }, undefined, undefined, ctx));
    assert.deepEqual(trial.checks, evidence.trials[0].checks);
    assert.deepEqual(trial.assessments, evidence.trials[0].assessments);
    const exported = output(await tools.get('agent_lab_inspect')!.execute('export-reviewed', { id: report.id, export: true }, undefined, undefined, ctx));
    const markdown = await readFile(exported.artifacts.report, 'utf8');
    assert.match(markdown, /Сценарная оценка демо/); assert.doesNotMatch(markdown, /Оценка модели/);
    await assert.rejects(access(join(directory, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('native tool cancellation preserves partial preparation and releases ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-extension-cancel-'));
  const { tools, shutdown } = registered();
  const controller = new AbortController();
  try {
    const result = await tools.get('agent_lab_build')!.execute('build-cancel', { mode: 'demo' }, controller.signal,
      () => controller.abort(new Error('User cancelled')), { cwd: directory, model: undefined } as ExtensionContext);
    const report = output(result);
    assert.equal(report.cancelled, true); assert.equal(report.trialCount, 0);
    assert.notEqual(report.phase, 'complete');
    await assert.rejects(access(join(directory, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('actual Pi SDK loader imports native cards, preparation-only tools and embedded skill without discovered resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-loader-'));
  try {
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: join(directory, 'agent'),
      settingsManager: SettingsManager.inMemory({ packages: [], enableAnalytics: false, enableInstallTelemetry: false }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL('../extensions/agent-lab.ts', import.meta.url))],
      additionalSkillPaths: [fileURLToPath(new URL('../skills/agent-builder/SKILL.md', import.meta.url))],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 1);
    assert.deepEqual([...loaded.extensions[0]!.tools.keys()], ['agent_lab_build', 'agent_lab_inspect', 'agent_lab_edit', 'agent_lab_repeat']);
    assert.ok(loaded.extensions[0]!.commands.has('agent-lab'));
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
    const skills = loader.getSkills();
    assert.deepEqual(skills.diagnostics, []); assert.equal(skills.skills.length, 1);
    assert.equal(skills.skills[0]!.name, 'agent-builder');
    const protocol = await readFile(skills.skills[0]!.filePath, 'utf8');
    assert.match(protocol, /agent_lab_build|agent_lab_inspect/); assert.doesNotMatch(protocol, /https?:\/\//);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('build accepts an external module target, real dialogues and golden cases; inspect and exports carry the evidence summary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-extension-v2-'));
  const { tools, shutdown } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'print', hasUI: false } as ExtensionContext;
  try {
    const target = { kind: 'module', path: fileURLToPath(new URL('../examples/echo-agent.mjs', import.meta.url)), exportName: 'createSession' };
    const report = output(await tools.get('agent_lab_build')!.execute('build-v2', {
      mode: 'demo', scenarioCount: 1, target, settings: { userModes: ['static', 'reactive'] },
      goldenCases: [{ id: 'gold_move', goal: 'Move appointment A101 to 14:00', opening: 'Please move appointment A101 to 14:00.', successCriteria: 'A101 is at 14:00',
        initialState: { records: { A101: { time: '09:00', owner: 'Sample customer', status: 'booked' } }, writableFields: ['time'], transientFailures: 0 },
        checks: [{ id: 'time', kind: 'state_equals', description: 'moved', recordId: 'A101', field: 'time', value: '14:00' }] }],
      dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'move A101 to 14:00 pls' }], outcome: 'success' }],
    }, undefined, undefined, ctx));
    assert.equal(report.phase, 'review', report.error ?? '');
    assert.deepEqual(report.target, target);
    assert.equal(report.scenarioCount, 3);
    assert.equal(report.profileCount, 1);
    assert.equal(report.evidence.verdict.provenance.production.cards, 1);
    assert.equal(report.evidence.comparison, null);
    assert.deepEqual(report.evidence.modes.map((m: { userMode: string }) => m.userMode), ['static', 'reactive']);
    assert.ok(report.evidence.notes.some((n: string) => /Вердиктов человека по метрикам и проверкам ещё нет/.test(n)));
    const inspect = output(await tools.get('agent_lab_inspect')!.execute('inspect-v2', { id: report.id, export: true }, undefined, undefined, ctx));
    assert.equal(inspect.evidence.fidelity.realDialogues, 1);
    assert.equal(inspect.artifacts.agent, undefined, 'external agent is not exported as a sandbox AgentSpec');
    assert.match(await readFile(inspect.artifacts.htmlReport, 'utf8'), /<!doctype html>/);
    assert.equal(inspect.scenarios.filter((s: { provenance: string }) => s.provenance === 'curated').length, 1);
    const markdown = await readFile(inspect.artifacts.report, 'utf8');
    assert.match(markdown, /Наблюдаемый результат/); assert.match(markdown, /Режимы пользователя/); assert.match(markdown, /Калибровка судьи/); assert.match(markdown, /Верность симулятора/);
    assert.match(markdown, /Испытуемый: модуль/);
    await assert.rejects(access(join(directory, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('the plain verdict leads every surface and the thorough preset widens the run without extra knobs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-extension-verdict-'));
  const { tools, shutdown } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'print', hasUI: false } as ExtensionContext;
  try {
    const quick = output(await tools.get('agent_lab_build')!.execute('build-quick', { mode: 'demo', scenarioCount: 1, notes: 'Users rarely know their ID.' }, undefined, undefined, ctx));
    assert.equal(quick.phase, 'review');
    assert.deepEqual(quick.evidence.verdict.provenance.synthetic.cards, 1);
    assert.match(quick.evidence.verdict.headline, /Диалогов с оценкой ещё нет/);
    assert.ok(quick.evidence.verdict.nextSteps.length >= 1);
    const thorough = output(await tools.get('agent_lab_build')!.execute('build-thorough', { mode: 'demo', scenarioCount: 1, preset: 'thorough' }, undefined, undefined, ctx));
    const evidence = JSON.parse(await readFile(thorough.artifacts.evidence, 'utf8'));
    assert.deepEqual(evidence.settings.userModes, ['static', 'scripted', 'reactive']);
    assert.equal(evidence.settings.repeats, 2);
    const markdown = await readFile(thorough.artifacts.report, 'utf8');
    assert.ok(markdown.indexOf('## Итог') < markdown.indexOf('## Наблюдаемый результат'));
    assert.match(markdown, /Доверие: низкое/);
    assert.match(markdown, /Карточки: синтетических 1, golden 0, из продакшна 0/);
    await assert.rejects(access(join(directory, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});
