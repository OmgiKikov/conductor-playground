import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Experiment } from './contracts.js';
import type { ExperimentStore } from './store.js';
import { compareRuns, evidenceSummary, type EvidenceSummary, type RunComparison } from './comparison.js';
import { htmlReport, jsonReport, markdownReport } from './report.js';

export interface EvidenceBundle {
  record: Experiment;
  evidence: EvidenceSummary;
  before?: Experiment;
  comparison?: RunComparison;
  comparisonSource?: { kind: 'parent' | 'selected'; beforeId: string; afterId: string };
  warnings: string[];
  traceJournal: string;
}
const failureText = (error: unknown) => (error instanceof Error ? error.name === 'ZodError' ? 'Запись не соответствует формату Agent Lab.' : error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);

/** Resolve the persisted relationship once, independently of navigation and export format. */
export async function evidenceBundle(record: Experiment, store: Pick<ExperimentStore, 'get' | 'traceJournal'>, beforeId?: string): Promise<EvidenceBundle> {
  const snapshot = structuredClone(record);
  const bundle: EvidenceBundle = { record: snapshot, evidence: evidenceSummary(snapshot), warnings: [], traceJournal: '' };
  const parent = beforeId ?? snapshot.parentRunId;
  if (parent) {
    bundle.comparisonSource = { kind: beforeId && beforeId !== snapshot.parentRunId ? 'selected' : 'parent', beforeId: parent, afterId: snapshot.id };
    try { bundle.before = await store.get(parent); bundle.comparison = compareRuns(bundle.before, snapshot); }
    catch (error) { bundle.warnings.push(`Базовый прогон ${parent} недоступен. Сравнение не выполнено; текущие доказательства сохранены. ${failureText(error)}`); }
  }
  try { bundle.traceJournal = await store.traceJournal(snapshot.id); }
  catch (error) { bundle.warnings.push(`Журнал трасс недоступен; реплики из записи включены в отчёт. ${failureText(error)}`); }
  if (['preparing', 'evaluating', 'baseline', 'improving', 'control'].includes(snapshot.phase)) {
    bundle.warnings.push('Прогон ещё идёт. Этот снимок содержит доступные сейчас доказательства; после завершения экспортируйте итог заново.');
  }
  return bundle;
}

/** Each format consumes the same snapshot; canonical raw evidence paths stay compatible with Pi tools. */
export async function exportArtifacts(bundle: EvidenceBundle, directory: string) {
  const exportDir = resolve(directory, 'exports');
  await mkdir(exportDir, { recursive: true, mode: 0o700 });
  const record = bundle.record;
  const stem = `${record.id}.${randomUUID().slice(0, 8)}`;
  const selected = record.target.kind === 'sandbox' ? record.revisions.find(r => r.id === record.selectedRevisionId)?.spec : undefined;
  const paths = {
    evidence: resolve(directory, `${record.id}.json`),
    traceJournal: resolve(directory, `${record.id}.trace.jsonl`),
    report: resolve(exportDir, `${stem}.report.md`),
    htmlReport: resolve(exportDir, `${stem}.report.html`),
    snapshot: resolve(exportDir, `${stem}.snapshot.json`),
    ...(selected ? { agent: resolve(exportDir, `${stem}.agent.json`) } : {}),
  };
  const files: [string, string][] = [
    [paths.report, markdownReport(bundle)], [paths.htmlReport, htmlReport(bundle)], [paths.snapshot, jsonReport(bundle)],
    ...(selected && paths.agent ? [[paths.agent, JSON.stringify(selected, null, 2)] as [string, string]] : []),
  ];
  const created: string[] = [];
  try {
    for (const [path, content] of files) { await writeFile(path, content, { mode: 0o600, flag: 'wx' }); created.push(path); }
  } catch (error) { await Promise.allSettled(created.map(path => unlink(path))); throw error; }
  return paths;
}
