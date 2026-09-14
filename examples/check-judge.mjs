// Live engineering acceptance, not human calibration. Expected labels never enter the judge input.
// node examples/check-judge.mjs --provider openrouter --model anthropic/claude-haiku-4.5 --output /tmp/judge.json
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { emptyUsage, fingerprint, scenarioSchema, settingsSchema, trialSchema } from '../dist/contracts.js';
import { createPiRuntime, evaluatorVersion } from '../dist/pi.js';

const { values } = parseArgs({ options: { provider: { type: 'string' }, model: { type: 'string' }, upstream: { type: 'string' }, output: { type: 'string' } } });
if (!values.provider || !values.model || !values.output) throw new Error('Provide --provider, --model and a new --output JSON path. This runs real model calls.');
const cases = JSON.parse(await readFile(new URL('./judge-cases.json', import.meta.url), 'utf8'));
const settings = settingsSchema.parse({ provider: values.provider, model: values.model,
  judge: { provider: values.provider, model: values.model, ...(values.upstream ? { upstream: values.upstream } : {}) } });
const output = resolve(values.output);
const report = { format: 'agent-lab-judge-check-1', createdAt: new Date().toISOString(), kind: 'synthetic_engineering',
  note: 'Authored test expectations, not owner labels or independent production validation. Cases were not supplied as few-shot anchors.',
  casesHash: fingerprint(cases), evaluatorVersion: evaluatorVersion(settings), settings, usage: emptyUsage(), results: [], status: 'running' };
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const runtime = await createPiRuntime(settings);
const signal = AbortSignal.timeout(settings.maxDurationMs);
const ctx = { signal, timeoutMs: settings.timeoutMs,
  beforeCall() { signal.throwIfAborted(); if (report.usage.calls >= cases.length * 3) throw new Error('Judge check call budget exhausted.'); report.usage.calls++; },
  addUsage(u) { report.usage.inputTokens += u.inputTokens; report.usage.outputTokens += u.outputTokens;
    report.usage.costUsd = u.costUsd === null || report.usage.costUsd === null ? null : report.usage.costUsd + u.costUsd; } };
for (const c of cases) {
  const expected = z.enum(['pass', 'fail', 'unknown']).parse(c.expected);
  const metric = { id: 'criterion', name: 'Case criterion', subject: c.subject ?? 'agent', description: c.policy, passCriteria: c.pass, failCriteria: c.fail, ...(c.stage ? { stage: c.stage } : {}) };
  const scenario = { ...scenarioSchema.parse({ id: c.id, familyId: c.id, title: c.id, requirementIds: ['policy'], provenance: 'synthetic',
    user: { opening: c.opening ?? 'Please complete the request.', goal: c.opening ?? 'Receive the requested response.', facts: 'No additional private facts supplied.', behavior: 'Ask once; obey the supplied stopping rule.', maxFollowUps: c.script?.length ?? 0, ...(c.script ? { script: c.script } : {}) },
    initialState: { records: c.initialRecords ?? {}, writableFields: ['time'] }, checks: c.checks ?? [], metrics: [metric], successCriteria: c.pass }), split: 'dev' };
  const trial = trialSchema.parse({ id: c.id, scenarioId: c.id, familyId: c.id, revisionId: 'withheld', repeat: 0, split: 'dev', userMode: c.mode ?? 'static',
    manifestHash: 'engineering', outcome: 'ungraded', reason: '', checks: [], usage: emptyUsage(), elapsedMs: 0,
    events: c.events ?? [{ seq: 0, type: 'user', text: scenario.user.opening }, { seq: 1, type: 'assistant', text: c.answer }],
    initialState: scenario.initialState, finalState: { ...scenario.initialState, records: c.finalRecords ?? scenario.initialState.records },
    observation: { state: c.finalRecords ? 'reported' : 'missing', tools: c.finalRecords ? 'complete' : 'partial', ...(c.finalRecords ? { resetConfirmed: true } : {}) } });
  const input = { scenario, trial, sources: [{ id: 'policy', name: 'Explicit test policy', content: c.policy, hash: fingerprint(c.policy) }] };
  let assessments, error, judgeAudit, persistenceError;
  try { assessments = await runtime.assess(input, { ...ctx, onJudgment(_id, audit) {
    judgeAudit = audit;
    // Keep every original response before the judge parses it, including a pending interrupted request.
    try { writeFileSync(output, JSON.stringify({ ...report, activeCase: { id: c.id, expected, input, judgeAudit } }, null, 2) + '\n'); }
    catch (e) { persistenceError = e; throw e; }
  } }); }
  catch (e) { error = e instanceof Error ? e.message : 'Judge failed'; }
  if (persistenceError) throw persistenceError;
  const actual = assessments?.[0]?.result;
  report.results.push({ id: c.id, expected, actual, matches: actual === expected && !error, error, input, assessments, judgeAudit });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ id: c.id, expected, actual, error }));
}
report.status = 'complete';
report.summary = { total: cases.length, matched: report.results.filter(r => r.matches).length,
  errors: report.results.filter(r => r.error).length, mismatches: report.results.filter(r => !r.error && !r.matches).map(r => r.id) };
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ summary: report.summary, usage: report.usage, output }));
process.exitCode = report.summary.errors ? 2 : report.summary.matched !== cases.length ? 1 : 0;
