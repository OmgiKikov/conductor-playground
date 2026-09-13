import { stripVTControlCharacters } from 'node:util';
import { createHash } from 'node:crypto';
import { agentRubricResult, awaitingVerdict, evidenceSummary, isAgentFailure, observedRecord, humanFindings, humanFindingText, repeatResultText, type HumanFinding, type RunComparison } from './comparison.js';
import type { Experiment, TraceEvent, Trial } from './contracts.js';
import { describeCheck, fingerprint } from './contracts.js';
import type { EvidenceBundle } from './artifacts.js';

const plain = (value: unknown) => stripVTControlCharacters(String(value ?? '')).replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
const escape = (value: unknown) => plain(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const md = (value: unknown) => plain(value).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!).replace(/[\\`*_{}\[\]()#|]/g, '\\$&');
const outcomes: Record<string, string> = { pass: 'Пройдено', fail: 'Не пройдено', ungraded: 'По рубрикам', invalid: 'Не измерено', cancelled: 'Остановлено', unknown: 'Неясно' };
const modes: Record<string, string> = { static: 'Первая реплика', scripted: 'По сценарию', reactive: 'Реактивный симулятор' };
// Only this fixed script is permitted by CSP; all report data remains escaped text.
const navigationScript = `function reveal(){const el=document.getElementById(decodeURIComponent(location.hash.slice(1)));if(!el)return;for(let p=el;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;el.scrollIntoView();}addEventListener('hashchange',reveal);addEventListener('DOMContentLoaded',reveal);document.addEventListener('click',e=>{const a=e.target.closest('a[href^="#"]');if(a&&a.hash===location.hash)reveal();});`;
const navigationHash = createHash('sha256').update(navigationScript).digest('base64');
const reviewWord = (bundle: EvidenceBundle) => bundle.evidence.verdict.review.status === 'complete' ? 'Аудит завершён' : 'Аудит не завершён';
const version = (record: Experiment) => record.targetVersion ?? record.targetRelease ?? record.targetFingerprint?.slice(0, 12) ?? record.selectedRevisionId?.slice(0, 12) ?? 'не указана';
const trialId = (record: Experiment, trial: Pick<Trial, 'id'>) => `trial-${record.id}-${trial.id}`;
const eventId = (record: Experiment, trial: Trial, seq: number) => `event-${record.id}-${trial.id}-${seq}`;
const title = (record: Experiment) => {
  const agent = record.revisions.find(r => r.id === record.selectedRevisionId)?.spec.name ?? 'Проверка агента';
  return `${plain(agent)} · ${record.scenarios.length === 1 ? plain(record.scenarios[0]!.title) : `${record.scenarios.length} тестов`}`;
};
const target = (record: Experiment) => record.target.kind === 'sandbox' ? 'песочница'
  : record.target.kind === 'http' ? `HTTP ${record.target.url}` : record.target.kind === 'module' ? `модуль ${record.target.path}`
    : `процесс ${[record.target.command, ...record.target.args].join(' ')}`;
const modelLabel = (record: Experiment) => record.mode === 'demo' ? 'Сценарная оценка демо' : 'Оценка модели';
const lastAnswer = (trial: Trial) => trial.events.findLast(e => e.type === 'assistant')?.text ?? 'Ответ агента не записан.';
const list = (values: string[]) => values.length ? `<ul>${values.map(v => `<li>${escape(v)}</li>`).join('')}</ul>` : '';
const percent = (value: number | null) => value === null ? 'нет данных' : `${Math.round(value * 100)}%`;
const numeric = (value: number | null) => value === null ? 'нет данных' : value.toFixed(2);
const metadata = (record: Experiment) => [
  `Релиз адаптера: ${record.targetRelease ?? 'не сообщён'}. Оценщик: ${record.evaluatorVersion ?? 'версия не записана'}.`,
  `Версия критериев: ${fingerprint(record.scenarios.map(s => ({ id: s.id, checks: s.checks, metrics: s.metrics, successCriteria: s.successCriteria })))}.`,
  `Модели ролей: ${JSON.stringify(record.settings.roles)}. Незаданные роли используют общую модель.`,
  ...(record.assessmentOf ? [`Переоценка прогона ${record.assessmentOf}. Агент и симулятор не запускались. Хеш исходных фактов: ${record.evidenceHash}.`] : []),
  ...(record.sourceEvidence ? [`Источник регрессии: прогон ${record.sourceEvidence.runId}, сохранено исходных диалогов ${record.sourceEvidence.trials.length}. Исходные ручные вердикты относятся к тем диалогам.`]
    : record.parentRunId ? ['Исходная трасса не включена в набор; для разбора нужен исходный прогон.'] : []),
];
function reassessmentHTML(record: Experiment, before?: Experiment) {
  if (!record.assessmentOf) return '';
  return `<section><h2>Изменения оценок на тех же ответах</h2><p>Агент не запускался. Исходные оценки сохранены.</p>${record.trials.map(trial => {
    const original = before?.trials.find(t => t.id === trial.id) ?? record.sourceEvidence?.trials.find(t => t.id === trial.id);
    return `<details><summary>${escape(trial.id)}</summary><div class="pair"><div><h3>Исходные оценки</h3>${original ? list(originalChecks(before ?? record, original)) : '<p>Нет в этом снимке; откройте исходный прогон.</p>'}</div><div><h3>Новые оценки</h3>${list(originalChecks(record, trial))}</div></div><a href="#${escape(trialId(record, trial))}">Сохранённые реплики →</a></details>`;
  }).join('')}</section>`;
}
function calibrationLines(bundle: EvidenceBundle): string[] {
  const comparison = bundle.calibrationComparison;
  if (!comparison) return [];
  return [`Проверка оценщика по исходным человеческим меткам: ${comparison.reviewIds.length}. Источник: ${comparison.sourceRunId}.`,
    ...comparison.after.filter(a => a.n).map(a => {
      const b = comparison.before.find(b => b.key === a.key);
      return `${a.key}: n=${a.n}, согласие ${percent(b?.agreement ?? null)} → ${percent(a.agreement)}; TPR ${percent(b?.tpr ?? null)} → ${percent(a.tpr)}; TNR ${percent(b?.tnr ?? null)} → ${percent(a.tnr)}.`;
    }),
    'Сопоставлены те же ответы и неизменные критерии. Исходные метки используются по ссылке и не считаются новой ручной проверкой. Маленькая выборка не устанавливает надёжность судьи.'];
}
function normalize(input: Experiment | EvidenceBundle, comparison?: RunComparison): EvidenceBundle {
  return 'record' in input ? input : { record: input, evidence: evidenceSummary(input), comparison, warnings: [], traceJournal: '' };
}
function visibleScenarios(record: Experiment) {
  const observed = observedRecord(record);
  return record.workflow === 'evaluate' || observed.scenarios.some(s => s.split === 'control') ? record.scenarios : record.scenarios.filter(s => s.split === 'dev');
}
function visibleTrials(record: Experiment) {
  const ids = new Set(visibleScenarios(record).map(s => s.id));
  return record.trials.filter(t => ids.has(t.scenarioId));
}
function eventLabel(event: TraceEvent): string {
  return ({ user: 'Пользователь', assistant: 'Агент', error: 'Ошибка', simulator: 'Симулятор', tool_call: 'Вызов инструмента', tool_result: 'Результат инструмента', state: 'Состояние' } as Record<string, string>)[event.type] ?? event.type;
}
function eventText(event: TraceEvent): string {
  return event.text ?? JSON.stringify(event.result !== undefined ? event.result : event.args !== undefined ? event.args : event.state ?? '', null, 2);
}
function originalChecks(record: Experiment, trial: Trial): string[] {
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  return [
    ...trial.checks.map(c => `Код · ${outcomes[c.passed ? 'pass' : 'fail']}: ${c.description}. ${c.evidence}`),
    ...(trial.assessments ?? []).map(a => `${modelLabel(record)} · ${outcomes[a.result]}: ${scenario?.metrics?.find(m => m.id === a.metricId)?.name ?? a.metricId}. ${a.rationale}`),
  ];
}
function trialHTML(record: Experiment, trial: Trial, findings: HumanFinding[]): string {
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  const failure = isAgentFailure(record, trial);
  const label = findings.length ? 'Замечание человека' : failure ? 'Требует внимания' : outcomes[trial.outcome];
  const rubric = agentRubricResult(scenario, trial);
  const reviews = record.humanReviews.filter(r => r.trialId === trial.id);
  const revision = record.workflow === 'compare' ? `${trial.revisionId === record.revisions[0]?.id ? 'Исходная версия' : trial.revisionId === record.selectedRevisionId ? 'Выбранная версия' : 'Кандидат'} ${trial.revisionId.slice(0, 10)} · ${trial.split === 'control' ? 'Контрольные карточки' : 'Карточки разработки'}` : `Версия ${version(record)}`;
  return `<details class="trial" id="${escape(trialId(record, trial))}"><summary><span class="tag ${failure || trial.outcome === 'invalid' ? 'warning' : ''}">${escape(label)}</span> ${escape(scenario?.title ?? trial.scenarioId)} <span class="muted">· ${escape(modes[trial.userMode])} · попытка ${trial.repeat + 1}</span></summary>
<p class="muted">${escape(revision)} · ${(trial.elapsedMs / 1000).toFixed(1)} с · <code>${escape(trial.id)}</code></p>
<p>${escape(trial.reason)}</p>${list([`Наблюдение: состояние ${trial.observation?.state ?? 'не записано'}, события ${trial.observation?.tools ?? 'не записано'}, сброс ${trial.observation?.resetConfirmed === true ? 'подтверждён адаптером' : 'не подтверждён'}.`, `Расходы внешнего агента: ${trial.externalUsage?.costUsd === undefined || trial.externalUsage.costUsd === null ? 'неизвестны' : `$${trial.externalUsage.costUsd.toFixed(4)}`}.`])}
<p class="basis">Код: ${trial.checks.length ? `${trial.checks.filter(c => c.passed).length}/${trial.checks.length} проверок` : 'проверок нет'} · ${escape(modelLabel(record))}: ${rubric ? escape(outcomes[rubric]) : 'нет оценки'} · Человек: ${reviews.length ? 'см. историю вердиктов' : 'вердикта нет'}</p>
${findings.length ? `<div class="notice">${list(findings.map(humanFindingText))}</div>` : ''}
<h3>Реплики и события</h3>${trial.events.map(e => ['user', 'assistant', 'error'].includes(e.type)
    ? `<div class="turn ${escape(e.type)}" id="${escape(eventId(record, trial, e.seq))}"><small><a href="#${escape(eventId(record, trial, e.seq))}">#${e.seq}</a> · ${escape(eventLabel(e))}</small><pre>${escape(eventText(e))}</pre></div>`
    : `<details class="event" id="${escape(eventId(record, trial, e.seq))}"><summary>#${e.seq} · ${escape(eventLabel(e))}${e.tool ? ` · ${escape(e.tool)}` : ''}</summary><pre>${escape(eventText(e))}</pre></details>`).join('')}
<h3>Пройдено по точным проверкам</h3>${trial.checks.length ? list(trial.checks.map(c => `${c.passed ? 'Пройдено' : 'Не пройдено'} · ${c.description}: ${c.evidence}`)) : '<p class="muted">Не заданы. Оценки по рубрикам показаны отдельно.</p>'}
<h3>${escape(modelLabel(record))} по рубрикам · предварительно</h3>${(trial.assessments ?? []).length ? `<ul>${trial.assessments!.map(a => `<li><b>${escape(outcomes[a.result])} · ${escape(scenario?.metrics?.find(m => m.id === a.metricId)?.name ?? a.metricId)}</b>: ${escape(a.rationale)} ${a.evidence.map(seq => trial.events.some(e => e.seq === seq) ? `<a class="event-link" href="#${escape(eventId(record, trial, seq))}">#${seq}</a>` : `<span class="warning">#${seq} отсутствует</span>`).join(' ')}</li>`).join('')}</ul>` : '<p class="muted">Оценок по рубрикам нет.</p>'}
${trial.assessmentError ? `<p class="warning">${escape(trial.assessmentError)}</p>` : ''}
<h3>История вердиктов человека</h3>${reviews.length ? list(reviews.map(r => `${outcomes[r.verdict]} · ${r.metricId ?? r.checkId ?? 'весь диалог'} · ${r.createdAt}: ${r.note}`)) : '<p class="muted">Вердикты не записаны.</p>'}
<details><summary>Полная трасса и состояния</summary><pre>${escape(JSON.stringify({ trialId: trial.id, revisionId: trial.revisionId, events: trial.events, initialState: trial.initialState, finalState: trial.finalState }, null, 2))}</pre></details>
<p><a href="#attention">К списку замечаний ↑</a></p></details>`;
}
function comparisonHTML(bundle: EvidenceBundle): string {
  const { record, before, comparison, comparisonSource } = bundle;
  if (!comparison) return '';
  const changed = new Set([...comparison.regressed, ...comparison.fixed].map(c => c.scenarioId));
  const pairs = (comparison.pairs ?? []).filter(p => changed.has(p.scenarioId));
  const pairAnchor = (scenarioId: string) => {
    const pair = pairs.find(p => p.scenarioId === scenarioId);
    return pair ? `pair-${pair.scenarioId}-${pair.userMode}-${pair.repeat}` : 'comparison';
  };
  const changes = (values: RunComparison['fixed'], label: string) => values.map(c => `<li><a href="#${escape(pairAnchor(c.scenarioId))}">${escape(label)}: ${escape(c.title)}</a></li>`).join('');
  return `<section id="comparison"><div class="section-heading"><h2>Изменение версии</h2><span class="tag">${comparisonSource?.kind === 'selected' ? 'База выбрана вручную' : 'Сравнение с предыдущим прогоном'}</span></div>
<p class="lead">${escape(comparison.headline)}</p><p class="muted">${before ? `До: <b>${escape(version(before))}</b> · <code>${escape(before.id)}</code><br>` : ''}После: <b>${escape(version(record))}</b> · <code>${escape(record.id)}</code></p>
<p class="basis">Сопоставлено ${comparison.coverage.validPairs} из ${comparison.coverage.plannedPairs} пар · исключено ${comparison.coverage.excludedPairs}. ${comparison.includesRubrics ? 'В сравнении участвуют предварительные оценки по рубрикам.' : 'Сравнение по кодовым проверкам.'}</p>
${comparison.regressed.length || comparison.fixed.length ? `<ul class="change-list">${changes(comparison.regressed, comparison.includesRubrics ? 'Оценка снизилась' : 'Сломалось')}${changes(comparison.fixed, comparison.includesRubrics ? 'Оценка выросла' : 'Исправлено')}</ul>` : ''}
${comparison.notes.length ? `<details><summary>Условия сравнения · ${comparison.notes.length}</summary>${list(comparison.notes)}</details>` : ''}
${before ? pairs.map(pair => {
    const a = before.trials.find(t => t.id === pair.beforeTrialId);
    const b = record.trials.find(t => t.id === pair.afterTrialId);
    if (!a || !b) return '';
    return `<article class="pair-card" id="${escape(pairAnchorFor(pair))}"><h3>${escape(record.scenarios.find(s => s.id === pair.scenarioId)?.title ?? pair.scenarioId)} · ${escape(modes[pair.userMode])} · ${pair.repeat + 1}</h3>${pair.reviewNote ? `<p class="warning">${escape(pair.reviewNote)}</p>` : ''}<div class="pair">${([[before, a, 'До'], [record, b, 'После']] as const).map(([run, trial, label]) => {
      return `<div><p class="eyebrow">${label} · ${escape(version(run))}</p><pre class="answer">${escape(lastAnswer(trial))}</pre>${list(originalChecks(run, trial))}<a href="#${escape(trialId(run, trial))}">Полный диалог · ${escape(trial.id.slice(0, 8))} →</a></div>`;
    }).join('')}</div></article>`;
  }).join('') : ''}</section>`;
}
function pairAnchorFor(pair: RunComparison['pairs'][number]): string { return `pair-${pair.scenarioId}-${pair.userMode}-${pair.repeat}`; }

/** A portable, script-free report. Every supplied or generated string is escaped. */
export function htmlReport(input: Experiment | EvidenceBundle, comparison?: RunComparison): string {
  const bundle = normalize(input, comparison);
  const { record, evidence, before } = bundle;
  const v = evidence.verdict;
  const observed = observedRecord(record);
  const pending = awaitingVerdict(record);
  const trials = visibleTrials(record);
  const flagged = new Set(v.review.findings.map(f => f.trialId));
  const attention = observed.trials.filter(t => flagged.has(t.id) || isAgentFailure(observed, t) || ['invalid', 'cancelled'].includes(t.outcome) || t.assessmentError)
    .sort((a, b) => Number(pending.has(b.id)) - Number(pending.has(a.id)));
  const limits = [...new Set([...v.confidenceReasons.map(n => n.text), ...evidence.notes, ...record.limitations])];
  const beforeFindings = before ? humanFindings(before) : [];
  const comparedBefore = before ? before.trials.filter(t => bundle.comparison?.pairs?.some(p => p.beforeTrialId === t.id)) : [];
  const final = record.comparisons.findLast(c => c.split === 'control');
  const sourceLine = `Карточки: ${v.provenance.synthetic.cards} синтетических · ${v.provenance.curated.cards} golden · ${v.provenance.production.cards} из реальных диалогов`;
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${navigationHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Agent Lab · ${escape(title(record))}</title><style>
:root{color-scheme:light dark;--bg:#f7f8f5;--surface:#fff;--text:#17271f;--muted:#56695d;--line:#dce4db;--accent:#176447;--soft:#eaf2eb;--warn:#a23f25}
@media(prefers-color-scheme:dark){:root{--bg:#101713;--surface:#18221c;--text:#edf4ed;--muted:#adc0b1;--line:#34453a;--accent:#9ad6b3;--soft:#24392c;--warn:#ffa68c}}
*{box-sizing:border-box}html{scroll-padding-top:24px}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:38px 30px 70px}a{color:var(--accent);text-underline-offset:3px}a:hover{text-decoration-thickness:2px}:focus-visible{outline:3px solid var(--accent);outline-offset:5px}header,.section-heading{display:flex;align-items:center;justify-content:space-between;gap:20px}header{border-bottom:1px solid var(--line);padding-bottom:22px;color:var(--muted);font-size:12px}.brand{font-weight:800;letter-spacing:.18em;color:var(--accent)}h1{font-size:clamp(28px,4vw,46px);line-height:1.13;letter-spacing:-.035em;margin:30px 0 16px;max-width:960px;overflow-wrap:anywhere}h2{font-size:22px;letter-spacing:-.02em;margin:0}h3{font-size:15px;margin:20px 0 8px}p{margin:10px 0}.muted{color:var(--muted)}.lead{font-size:19px;line-height:1.5;max-width:930px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:11px;color:var(--muted)}nav{display:flex;gap:12px 22px;flex-wrap:wrap;margin:25px 0}nav a{font-size:13px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:24px 0 14px}.metric,section{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px}.metric h3{font-size:12px;font-weight:550;color:var(--muted);margin:0}.metric strong{display:block;font-size:30px;letter-spacing:-.04em;line-height:1.4;margin-top:8px}.metric small{display:block;color:var(--muted);line-height:1.5;margin-top:8px}section{margin:20px 0}section>h2{margin-bottom:12px}.tag{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:11px;font-weight:600;color:var(--muted)}.warning{color:var(--warn)}.notice{padding:15px 18px;border-left:3px solid var(--warn);background:var(--surface);border-radius:5px;margin:15px 0}.basis{font-size:12px;color:var(--muted);background:var(--soft);padding:12px 15px;border-radius:8px}ul{padding-left:21px}li{margin:7px 0}.attention{list-style:none;padding:0}.attention li{border-top:1px solid var(--line);padding:14px 0;margin:0}.attention a{font-weight:650}.attention p{font-size:13px;color:var(--muted);margin:4px 0}.attention .tag{margin-right:8px}details{border-top:1px solid var(--line);padding:16px 0}summary{cursor:pointer;font-weight:600;overflow-wrap:anywhere}details>p,pre{overflow-wrap:anywhere}.trial:target,.pair-card:target,.turn:target,.event:target{outline:2px solid var(--accent);outline-offset:6px;border-radius:6px}.trial>summary{line-height:1.9}.trial .muted{font-size:12px}.turn{border-left:2px solid var(--line);padding:0 16px;margin:18px 0}.turn.user{border-color:var(--accent)}.turn.error{border-color:var(--warn)}.turn small{font-size:11px;color:var(--muted)}pre{white-space:pre-wrap;font:13px/1.7 ui-monospace,monospace;background:var(--bg);padding:15px;border-radius:8px;overflow:auto;max-height:480px}.turn pre{font:15px/1.7 system-ui,sans-serif;padding:8px 0;background:none;margin:0}.event{padding:9px 0}.event summary,.event-link{font-size:12px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:22px}.pair>div{min-width:0}.pair-card{border-top:1px solid var(--line);padding:12px 0;margin-top:24px}.pair-card>h3{font-size:17px}.pair-card ul{font-size:12px}.answer{min-height:85px}.full-task{max-width:920px;border:0;font-size:12px;padding:0}.full-task summary{font-weight:500;color:var(--muted)}.full-task p{white-space:pre-wrap}code{font-size:12px;overflow-wrap:anywhere}.limits{font-size:13px}footer{color:var(--muted);font-size:12px;margin-top:30px}.skip{position:absolute;left:-9999px}.skip:focus{left:20px;top:12px;background:var(--surface);padding:10px}.empty{padding:10px 0;color:var(--muted)}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;border-bottom:1px solid var(--line);padding:9px;overflow-wrap:anywhere}
@media(max-width:700px){main{padding:24px 16px}.grid{grid-template-columns:repeat(2,1fr)}.pair{grid-template-columns:1fr}.metric,section{padding:17px}header,.section-heading{align-items:flex-start;flex-direction:column;gap:8px}.lead{font-size:17px}}@media print{:root{--bg:#fff;--surface:#fff;--text:#000;--muted:#444;--line:#ccc;--accent:#154e35;--soft:#f6f6f6;--warn:#7a351e}main{padding:0}nav,.skip{display:none}section,.pair-card{break-inside:avoid}pre{max-height:none}a{color:inherit}.trial{break-inside:avoid}}
</style></head><body><a class="skip" href="#attention">Перейти к замечаниям</a><main>
<header><span class="brand">AGENT LAB</span><span>${escape(record.createdAt.slice(0, 16).replace('T', ' '))} UTC · ${record.mode === 'demo' ? 'Сценарное демо' : 'Живой прогон'} · <code>${escape(record.id.slice(0, 8))}</code></span></header>
<h1>${escape(title(record))}</h1><p class="lead">${escape(v.headline)}</p><p class="muted">${reviewWord(bundle)} · Версия ${escape(version(record))}${record.workflow === 'compare' ? ` · Итог по ${observed.scenarios.some(s => s.split === 'control') ? 'контрольным карточкам' : 'карточкам разработки'} выбранной версии` : ''}</p>
<details class="full-task"><summary>Исходная задача и подключение</summary><p>${escape(record.task)}</p><p>Испытуемый: <code>${escape(target(record))}</code></p></details>
${bundle.warnings.map(w => `<div class="notice" role="note">${escape(w)}</div>`).join('')}
<div class="grid"><article class="metric"><h3>Выполнено диалогов</h3><strong>${v.execution.completed}<span class="muted"> / ${v.execution.planned}</span></strong><small>${v.execution.running ? 'Прогон идёт' : 'Сохранённый результат'}${v.execution.invalid ? ` · ${v.execution.invalid} не измерено` : ''}${v.execution.cancelled ? ` · ${v.execution.cancelled} остановлено` : ''}${v.execution.missing ? ` · ${v.execution.missing} не выполнено` : ''}</small></article>
<article class="metric"><h3>Кодовые проверки · диалоги</h3><strong>${v.graded ? `${v.passed}<span class="muted"> / ${v.graded}</span>` : observed.scenarios.some(s => s.checks.length) ? 'Нет данных' : 'Нет'}</strong><small>${v.graded ? 'Детерминированный результат' : observed.scenarios.some(s => s.checks.length) ? 'Проверки заданы, измерений нет' : 'Кодовых проверок не задано'}</small></article>
<article class="metric"><h3>Оценено моделью · предварительно</h3><strong>${v.rubric.assessed ? `${v.rubric.passed}<span class="muted"> / ${v.rubric.assessed}</span>` : 'Нет оценок'}</strong><small>${v.rubric.assessed ? escape(modelLabel(record)) : observed.scenarios.some(s => s.metrics?.some(m => m.subject === 'agent')) ? 'Рубрики заданы, оценок пока нет' : 'Рубрики агента не заданы'}${v.rubric.unknown ? ` · ${v.rubric.unknown} неясно` : ''}</small></article>
<article class="metric"><h3>Разобрано человеком</h3><strong>${v.review.reviewed}<span class="muted"> / ${v.review.total}</span></strong><small>Пройдено ${v.review.passed} · не пройдено ${v.review.failed} · невалидных тестов ${v.review.invalid}<br>${v.review.pending} автоматических провалов ждут решения · критерии отдельно</small></article></div>
<p class="muted">${escape(sourceLine)}</p><nav aria-label="Разделы отчёта"><a href="#attention">Замечания · ${attention.length}</a><a href="#repeats">Повторы</a>${bundle.comparison ? '<a href="#comparison">До и после</a>' : ''}<a href="#dialogues">Диалоги · ${trials.length}</a><a href="#cards">Карточки и критерии</a><a href="#limits">Границы результата</a></nav>
<section id="attention"><h2>Что требует внимания</h2>${v.review.findings.length ? `<p class="notice">Замечания человека: ${v.review.flagged} диалогов · расхождения оценок: ${v.review.disagreements}. Исходные оценки сохранены; основания расхождений нужно проверить по трассе.</p>` : ''}${record.error ? `<p class="warning">${escape(record.error)}</p>` : ''}${attention.length ? `<ul class="attention">${attention.slice(0, 8).map(t => `<li><span class="tag ${isAgentFailure(observed, t) || t.outcome === 'invalid' ? 'warning' : ''}">${escape(['invalid', 'cancelled'].includes(t.outcome) ? outcomes[t.outcome] : pending.has(t.id) ? 'Нужен вердикт' : flagged.has(t.id) ? 'Замечание человека' : t.assessmentError ? 'Ошибка оценщика' : 'Провал разобран')}</span><a href="#${escape(trialId(record, t))}">${escape(record.scenarios.find(s => s.id === t.scenarioId)?.title ?? t.scenarioId)} →</a><p>${escape(v.review.findings.filter(f => f.trialId === t.id).map(humanFindingText).join(' ') || (t.checks.find(c => !c.passed)?.description ?? t.assessments?.find(a => a.result === 'fail' && record.scenarios.find(s => s.id === t.scenarioId)?.metrics?.some(m => m.id === a.metricId && m.subject === 'agent'))?.rationale ?? t.assessmentError ?? t.reason))}</p></li>`).join('')}</ul>${attention.length > 8 ? `<p><a href="#dialogues">Все замечания: ${attention.length} →</a></p>` : ''}` : `<p class="empty">${v.execution.completed ? 'В сохранённых диалогах нет зарегистрированных провалов. Это не гарантия качества в реальном трафике.' : 'Измерений пока нет. Следующий шаг указан ниже.'}</p>`}
${record.failureModes?.length ? `<details><summary>Типы провалов</summary>${list(record.failureModes.map(m => `${m.name}: ${m.description}`))}</details>` : ''}
<h3>Следующий шаг</h3>${list(v.nextSteps.slice(0, 1).map(n => n.text))}</section>
<section id="repeats"><h2>Повторы одинаковых карточек</h2><p class="basis">Код и рубрики вместе для разбора; ручные вердикты отдельно. Наблюдаемые попытки не дают вероятность будущего успеха.</p>${record.settings.repeats > 1 ? `<ul>${v.repeats.map(r => `<li>${escape(repeatResultText(r))}<br>${r.trialIds.map((id, i) => `<a href="#${escape(trialId(record, { id }))}">Диалог ${i + 1}</a>`).join(" · ")}</li>`).join("")}</ul>` : '<p class="muted">По одной попытке на карточку и режим: повторяемость не проверена.</p>'}</section>
${reassessmentHTML(record, before)}${bundle.calibrationComparison ? `<section><h2>Проверка оценщика до и после</h2>${list(calibrationLines(bundle))}</section>` : ''}${comparisonHTML(bundle)}
${final && record.workflow === 'compare' && observed.scenarios.some(s => s.split === 'control') ? `<section><h2>Контрольное сравнение</h2><p class="lead">Исходная версия: ${final.baselinePasses}/${final.validPairs} → выбранная версия: ${final.candidatePasses}/${final.validPairs}.</p><p>Исправлено ${final.fixed}, сломалось ${final.regressed}. ${final.validPairs} валидных пар из ${final.plannedPairs}.</p>${list(final.reasons)}<p class="muted">Все версии и попытки сохранены ниже с отдельными обозначениями.</p></section>` : ''}
<section id="dialogues"><h2>Диалоги и основания</h2><p class="muted">Раскройте диалог. Ссылки # ведут к событию, на которое опиралась оценка; исходные оценки и вердикты человека сохранены отдельно.</p>${trials.length ? trials.map(t => trialHTML(record, t, v.review.findings.filter(f => f.trialId === t.id))).join('') : '<p class="empty">Диалоги появятся после утверждения карточек и запуска.</p>'}</section>
${before && comparedBefore.length ? `<section id="before-dialogues"><h2>Диалоги до изменения · ${escape(version(before))}</h2><p class="muted">Базовый прогон <code>${escape(before.id)}</code>. Это исходные доказательства для сопоставленных попыток.</p>${comparedBefore.map(t => trialHTML(before, t, beforeFindings.filter(f => f.trialId === t.id))).join('')}</section>` : ''}
<section id="cards"><h2>Карточки и критерии</h2><p class="muted">${record.reviewedAt ? 'Версия, использованная в прогоне.' : 'Черновик · карточки ещё не утверждены.'}</p>${visibleScenarios(record).map(s => `<details><summary>${escape(s.title)} <span class="tag">${escape({ synthetic: 'Синтетика', curated: 'Golden', production: 'Реальный диалог' }[s.provenance])}</span></summary><p>${escape(s.user.persona ?? 'Без персоны · по цели, фактам и поведению')}${s.profileId ? ` · профиль ${escape(s.profileId)}` : ''}</p>${list(s.user.characteristics ?? [])}${list([`Цель: ${s.user.goal}`, `Знает: ${s.user.facts}`, `Поведение: ${s.user.behavior}`, `Первая реплика: ${s.user.opening}`, ...(s.user.script ?? []).map((message, i) => `Продолжение ${i + 1}: ${message}`), `Успех: ${s.successCriteria ?? 'По проверкам ниже'}`])}<h3>Правило и источник</h3>${s.requirementIds.map(id => record.requirements.find(r => r.id === id)).filter(r => !!r).map(r => `<blockquote>${escape(r!.quote)}<br><small>${escape(record.sources.find(source => source.id === r!.sourceId)?.name ?? r!.sourceId)} · ${escape(r!.id)}</small></blockquote>`).join('')}<h3>Проверки и рубрики</h3>${list([...s.checks.map(c => `Код: ${c.description}. Проверяется: ${describeCheck(c)}`), ...(s.metrics ?? []).map(m => `${m.subject === 'simulator' ? 'Симулятор' : 'Агент'} · ${m.name}. Прошёл: ${m.passCriteria} Не прошёл: ${m.failCriteria}`)])}${s.assumptions?.length ? `<h3>Допущения</h3>${list(s.assumptions)}` : ''}</details>`).join('')}
${record.profiles.length ? `<h3>Исходные профили и правки</h3>${record.profiles.map(p => `<details><summary>${escape(p.id)} · ${p.source === 'owner' ? 'Задан владельцем' : 'Выведен из логов'}${p.draftOverride ? ' · Правка черновика' : ''}</summary><p>${escape(p.persona ?? 'Без персоны')}</p>${list(p.characteristics)}${p.observedStyle ? `<p>${escape(p.observedStyle)}</p>` : ''}<p class="muted">Диалоги: ${escape(p.evidenceDialogueIds.join(', ') || 'не использовались')}</p>${p.draftOverride ? `<h3>Используется после правки</h3>${list([...(p.draftOverride.persona !== undefined ? [`Персона: ${p.draftOverride.persona ?? 'убрана'}`] : []), ...(p.draftOverride.characteristics !== undefined ? [`Характеристики: ${p.draftOverride.characteristics.join('; ') || 'убраны'}`] : [])])}` : ''}</details>`).join('')}` : ''}</section>
<section id="limits"><details class="limits"><summary>Условия и границы результата · ${limits.length}</summary>${list(limits)}<p>Доверие: ${{ low: 'низкое', medium: 'среднее', high: 'высокое' }[v.confidence]}. Это эвристика полноты аудита, не статистическая гарантия качества в продакшне.</p>${evidence.modes.length ? `<h3>Режимы пользователя</h3><table><thead><tr><th>Режим</th><th>Код: пройдено / оценено</th><th>Попытки</th></tr></thead><tbody>${evidence.modes.map(m => `<tr><td>${escape(modes[m.userMode])}</td><td>${m.passed} / ${m.valid}</td><td>${m.trials}</td></tr>`).join('')}</tbody></table>` : ''}</details></section>
<section><h2>Идентичность и источник доказательств</h2>${list(metadata(record))}${record.sourceEvidence ? `<details><summary>Исходные диалоги и вердикты · ${escape(record.sourceEvidence.runId)}</summary><pre>${escape(JSON.stringify(record.sourceEvidence, null, 2))}</pre></details>` : ''}</section>
<section><h2>Польза режимов и расходы</h2><p>${escape(evidence.pilot.conclusion)}</p><table><thead><tr><th>Режим</th><th>Подтверждённые группы</th><th>Только здесь</th><th>Сбои симулятора</th><th>Лаборатория, $</th><th>Внешний агент, $</th><th>Время прогона / разбора, с</th></tr></thead><tbody>${evidence.pilot.modes.map(m => `<tr><td>${escape(m.userMode)}</td><td>${m.confirmedFailureKeys.length}</td><td>${m.exclusiveConfirmed.length}</td><td>${m.simulatorFailures}</td><td>${m.labCostUsd === null ? 'неизвестно' : m.labCostUsd.toFixed(4)}</td><td>${m.externalCostUsd === null ? 'неизвестно' : m.externalCostUsd.toFixed(4)}</td><td>${(m.elapsedMs / 1000).toFixed(1)} / ${m.reviewMs === null ? 'неизвестно' : (m.reviewMs / 1000).toFixed(1)}</td></tr>`).join('')}</tbody></table><p>${escape(evidence.pilot.limitation)}</p></section>
<footer><p>Расходы выбранной модели: ${record.usage.costUsd === null ? 'неизвестны' : `$${record.usage.costUsd.toFixed(4)}`} · вызовов ${record.usage.calls}. Расходы внешнего агента и разговора с Pi не входят в эту оценку.</p><p>Локальный автономный отчёт · полные данные и сравнение доступны в JSON-снимке. ${escape(record.id)}</p></footer></main><script>${navigationScript}</script></body></html>`;
}

/** Preserve the CLI's `experiment` field while exporting the full shared snapshot. */
export function jsonReport(bundle: EvidenceBundle): string {
  const { record, ...evidence } = bundle;
  return JSON.stringify({ experiment: record, ...evidence }, null, 2);
}

export function markdownReport(bundle: EvidenceBundle): string {
  const { record, evidence: e, comparison, before } = bundle;
  const v = e.verdict;
  const quote = (value: unknown) => md(value).split('\n').map(line => `> ${line}`).join('\n');
  const rows = [
    `# Agent Lab · ${md(title(record))}`, '',
    '## Итог', '', md(v.headline), '',
    `Выполнено: ${v.execution.completed}/${v.execution.planned}. Не измерено: ${v.execution.invalid}. Остановлено: ${v.execution.cancelled}. Не выполнено: ${v.execution.missing}.`,
    `Кодовые проверки: ${v.graded ? `${v.passed}/${v.graded} диалогов` : observedRecord(record).scenarios.some(s => s.checks.length) ? 'заданы, измерений нет' : 'не заданы'}. ${modelLabel(record)} по рубрикам: ${v.rubric.passed}/${v.rubric.assessed}; неясно ${v.rubric.unknown}.`,
    `Вердикт на весь диалог: ${v.review.reviewed}/${v.review.total}. Пройдено ${v.review.passed}, не пройдено ${v.review.failed}. Автоматических провалов без решения: ${v.review.pending}. ${reviewWord(bundle)}.`,
    `Карточки: синтетических ${v.provenance.synthetic.cards}, golden ${v.provenance.curated.cards}, из продакшна ${v.provenance.production.cards}.`, '',
    `Проверка карточек: ${record.reviewMode === 'human' ? 'человеком' : record.reviewMode === 'automated' ? 'автоматическая' : 'ожидается'}.`,
    `Испытуемый: ${md(target(record))}. Версия: ${md(version(record))}. Прогон: ${md(record.id)}.`, '',
    ...metadata(record).map(md), '', ...calibrationLines(bundle).map(md), '',
    '### Польза режимов и расходы', '', md(e.pilot.conclusion), '',
    ...e.pilot.modes.map(m => `- ${m.userMode}: подтверждено групп ${m.confirmedFailureKeys.length}, только здесь ${m.exclusiveConfirmed.length}; сбои симулятора ${m.simulatorFailures}. Лаборатория: ${m.labCostUsd ?? 'неизвестно'} USD; внешний агент: ${m.externalCostUsd ?? 'неизвестно'} USD; время разбора: ${m.reviewMs ?? 'неизвестно'} мс.`), '',
    md(e.pilot.limitation), '',
    ...bundle.warnings.map(w => `- ${md(w)}`), '',
    ...(v.review.findings.length ? ['### Человек и автоматическая оценка', '', ...v.review.findings.map(f => `- Диалог ${md(f.trialId)}: ${md(humanFindingText(f))}`), '', 'Исходные оценки сохранены. Расхождение нужно проверить по трассе.', ''] : []),
    '### Повторы одинаковых карточек', '', 'Код и рубрики вместе для разбора; ручные вердикты отдельно. Это наблюдения, не вероятность успеха.', '',
    ...(record.settings.repeats > 1 ? v.repeats.map(r => `- ${md(repeatResultText(r))} Диалоги: ${r.trialIds.map(md).join(', ')}.`) : ['По одной попытке на карточку и режим: повторяемость не проверена.']), '',
    '### Что делать дальше', '', ...v.nextSteps.map(n => `- ${md(n.text)}`), '',
    '## Наблюдаемый результат', '',
    ...(comparison ? [
      md(comparison.headline), '',
      `${bundle.comparisonSource?.kind === 'selected' ? 'База выбрана вручную' : 'Сравнение с предыдущим прогоном'}: ${md(before ? version(before) : bundle.comparisonSource?.beforeId)} → ${md(version(record))}.`,
      `До: ${md(bundle.comparisonSource?.beforeId)}. После: ${md(record.id)}.`,
      ...comparison.regressed.map(c => `- ${comparison.includesRubrics ? 'Оценка снизилась' : 'Сломалось'}: ${md(c.title)}`), ...comparison.fixed.map(c => `- ${comparison.includesRubrics ? 'Оценка выросла' : 'Исправлено'}: ${md(c.title)}`),
      ...comparison.notes.map(n => `- ${md(n)}`), '',
      ...(before ? comparison.pairs.filter(p => [...comparison.fixed, ...comparison.regressed].some(c => c.scenarioId === p.scenarioId)).flatMap(p => {
        const a = before.trials.find(t => t.id === p.beforeTrialId); const b = record.trials.find(t => t.id === p.afterTrialId);
        return a && b ? [`### ${md(record.scenarios.find(s => s.id === p.scenarioId)?.title ?? p.scenarioId)} · попытка ${p.repeat + 1}`, '', `До · ${md(a.id)}`, '', quote(lastAnswer(a)), '', ...originalChecks(before, a).map(c => `- ${md(c)}`), '', `После · ${md(b.id)}`, '', quote(lastAnswer(b)), '', ...originalChecks(record, b).map(c => `- ${md(c)}`), ''] : [];
      }) : []),
    ] : e.comparison ? [md(e.comparison.observed), md(e.comparison.status), ''] : [bundle.comparisonSource ? 'Сравнение недоступно; причина указана выше.' : 'Предыдущая версия для сравнения не задана.', '']),
    '## Режимы пользователя', '', '| Режим | Код: пройдено / оценено | Диалогов | Реплик в среднем |', '|---|---|---|---|',
    ...e.modes.map(m => `| ${modes[m.userMode]} | ${m.passed}/${m.valid} | ${m.trials} | ${numeric(m.avgUserTurns)} |`), '',
    '## Калибровка судьи', '', 'Положительный класс — провал. Показатели с менее чем 60 размеченными парами предварительные.', '',
    '| Критерий | n | TPR | TNR | Согласие |', '|---|---|---|---|---|',
    ...e.calibration.map(c => `| ${md(c.key)} | ${c.n} | ${percent(c.tpr)} | ${percent(c.tnr)} | ${percent(c.agreement)} |`), '',
    '## Верность симулятора', '', ...(e.fidelity ? [
      `Реальных диалогов: ${e.fidelity.realDialogues}. Симуляций: ${e.fidelity.simulatedDialogues}. Ручная проверка верности: ${e.fidelity.humanFidelity.passed}/${e.fidelity.humanFidelity.reviewed}.`, '',
      '| Показатель | Реальные | Симуляция | Разрыв |', '|---|---|---|---|',
      ...e.fidelity.metrics.map(m => `| ${md(m.metric)} | ${numeric(m.real)} | ${numeric(m.simulated)} | ${numeric(m.gap)} |`),
    ] : ['Реальные диалоги не загружены. Верность симулятора неизвестна.']), '',
    '## Диалоги и основания', '',
    ...visibleTrials(record).flatMap(t => [
      `### ${md(record.scenarios.find(s => s.id === t.scenarioId)?.title ?? t.scenarioId)} · ${md(t.id)}`, '',
      `Версия: ${md(t.revisionId)}. ${t.split === 'control' ? 'Контрольные карточки' : 'Карточки разработки'}. ${modes[t.userMode]}, попытка ${t.repeat + 1}.`,
      `Результат кодовых проверок: ${t.outcome === 'ungraded' ? 'нет' : outcomes[t.outcome]}. ${md(t.reason)}`, '',
      ...t.events.flatMap(event => [`**#${event.seq} · ${eventLabel(event)}${event.tool ? ` · ${md(event.tool)}` : ''}**`, '', quote(eventText(event)), '']),
      ...originalChecks(record, t).map(c => `- ${md(c)}`),
      ...(t.assessmentError ? [`- Ошибка оценщика: ${md(t.assessmentError)}`] : []),
      ...record.humanReviews.filter(r => r.trialId === t.id).map(r => `- Человек · ${outcomes[r.verdict]} · ${md(r.metricId ?? r.checkId ?? 'весь диалог')} · ${md(r.createdAt)}: ${md(r.note)}`), '',
    ]),
    '## Исходная задача', '', quote(record.task), '',
    '## Границы доказательств', '', `Доверие: ${{ low: 'низкое', medium: 'среднее', high: 'высокое' }[v.confidence]}. Эвристика аудита, не гарантия качества в продакшне.`, '',
    ...[...new Set([...v.confidenceReasons.map(n => n.text), ...e.notes, ...record.limitations])].map(n => `- ${md(n)}`), '',
    `Расходы выбранной модели: ${record.usage.costUsd === null ? 'неизвестны' : `$${record.usage.costUsd.toFixed(4)}`}. Внешний агент и разговор с Pi в них не входят.`,
    'Полные состояния, журнал и базовый прогон для сравнения сохранены в JSON-снимке.', '',
  ];
  return rows.join('\n');
}
