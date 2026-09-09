import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import agentLab from '../extensions/agent-lab.ts';

function registered() {
  const tools = new Map<string, ToolDefinition>();
  let shutdown!: () => Promise<void>;
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  agentLab({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: { handler: typeof command }) => { assert.equal(name, 'agent-lab'); command = options.handler; },
    on: (name: string, handler: () => Promise<void>) => { assert.equal(name, 'session_shutdown'); shutdown = handler; },
  } as unknown as ExtensionAPI);
  assert.ok(shutdown); assert.ok(command);
  return { tools, shutdown, command };
}
function output(result: Awaited<ReturnType<ToolDefinition['execute']>>) {
  return JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
}

test('headless model tools prepare and edit only; approvals and human assessments are not callable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-extension-'));
  const { tools, shutdown, command } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'print', hasUI: false } as ExtensionContext;
  const updates: string[] = [];
  try {
    assert.deepEqual([...tools.keys()], ['agent_lab_build', 'agent_lab_inspect', 'agent_lab_edit']);
    const report = output(await tools.get('agent_lab_build')!.execute('build-1', { mode: 'demo', scenarioCount: 2 }, undefined,
      value => { updates.push(JSON.stringify(value)); }, ctx));
    assert.equal(report.phase, 'review'); assert.equal(report.workflow, 'evaluate');
    assert.equal(report.reviewMode, null); assert.equal(report.trialCount, 0);
    assert.equal(report.comparison, undefined); assert.equal(report.scenarioCount, 2);
    assert.ok(updates.length >= 1); assert.match(report.nextStep, /human|Human/);
    const evidence = JSON.parse(await readFile(report.artifacts.evidence, 'utf8'));
    assert.equal(evidence.settings.repeats, 1); assert.equal(evidence.trials.length, 0);
    assert.equal(evidence.controlConsumedAt, null);
    assert.deepEqual(JSON.parse(await readFile(report.artifacts.agent, 'utf8')), evidence.revisions[0].spec);
    assert.match(await readFile(report.artifacts.report, 'utf8'), /Draft review: pending/);
    const inspect = output(await tools.get('agent_lab_inspect')!.execute('inspect-1', { id: report.id }, undefined, undefined, ctx));
    assert.equal(inspect.scenarios.length, 2); assert.equal(inspect.draftHash, report.draftHash);
    const scenarios = inspect.scenarios;
    scenarios[0].user.persona = 'Пользователь отредактирован в черновике';
    const edited = output(await tools.get('agent_lab_edit')!.execute('edit-1', { id: report.id, expectedHash: report.draftHash, patch: { scenarios } }, undefined, undefined, ctx));
    assert.notEqual(edited.draftHash, report.draftHash); assert.equal(edited.reviewMode, null); assert.equal(edited.trialCount, 0);
    await assert.rejects(tools.get('agent_lab_edit')!.execute('edit-stale', { id: report.id, expectedHash: report.draftHash, patch: { settings: { repeats: 2 } } }, undefined, undefined, ctx), /changed/);
    await assert.rejects(tools.get('agent_lab_edit')!.execute('edit-approval', { id: report.id, expectedHash: edited.draftHash, patch: { approved: true, reviewMode: 'human' } }, undefined, undefined, ctx));
    await assert.rejects(command(report.id, ctx as ExtensionCommandContext), /native Pi terminal/);
    const unchanged = JSON.parse(await readFile(report.artifacts.evidence, 'utf8'));
    assert.equal(unchanged.reviewMode, null); assert.equal(unchanged.phase, 'review');
    await assert.rejects(access(join(directory, '.agent-lab', '.lock')));
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
    const keys = ['r', 'r', 'n', 'f', 'f', 'q'];
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
    assert.match(markdown, /Scripted demo assessment/); assert.doesNotMatch(markdown, /Model estimate/);
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
    assert.deepEqual([...loaded.extensions[0]!.tools.keys()], ['agent_lab_build', 'agent_lab_inspect', 'agent_lab_edit']);
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
    assert.equal(report.scenarioCount, 2);
    assert.equal(report.profileCount, 1);
    assert.equal(report.evidence.comparison, null);
    assert.deepEqual(report.evidence.modes.map((m: { userMode: string }) => m.userMode), ['static', 'reactive']);
    assert.ok(report.evidence.notes.some((n: string) => /No human verdicts/.test(n)));
    const inspect = output(await tools.get('agent_lab_inspect')!.execute('inspect-v2', { id: report.id, export: true }, undefined, undefined, ctx));
    assert.equal(inspect.evidence.fidelity.realDialogues, 1);
    assert.equal(inspect.scenarios.filter((s: { provenance: string }) => s.provenance === 'curated').length, 1);
    const markdown = await readFile(inspect.artifacts.report, 'utf8');
    assert.match(markdown, /Observed result/); assert.match(markdown, /User modes/); assert.match(markdown, /Judge calibration/); assert.match(markdown, /Simulator fidelity/);
    assert.match(markdown, /module/);
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
    assert.match(quick.evidence.verdict.headline, /No graded dialogues/);
    assert.ok(quick.evidence.verdict.nextSteps.length >= 1);
    const thorough = output(await tools.get('agent_lab_build')!.execute('build-thorough', { mode: 'demo', scenarioCount: 1, preset: 'thorough' }, undefined, undefined, ctx));
    const evidence = JSON.parse(await readFile(thorough.artifacts.evidence, 'utf8'));
    assert.deepEqual(evidence.settings.userModes, ['static', 'scripted', 'reactive']);
    assert.equal(evidence.settings.repeats, 2);
    const markdown = await readFile(thorough.artifacts.report, 'utf8');
    assert.ok(markdown.indexOf('## Verdict') < markdown.indexOf('## Observed result'));
    assert.match(markdown, /Confidence: low/);
    assert.match(markdown, /Cards: 1 synthetic, 0 curated, 0 production/);
    await assert.rejects(access(join(directory, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});
