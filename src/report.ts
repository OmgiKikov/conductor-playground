import { stripVTControlCharacters } from 'node:util';
import { awaitingVerdict, evidenceSummary, isAgentFailure, type RunComparison } from './comparison.js';
import type { Experiment } from './contracts.js';

const escape = (value: unknown) => stripVTControlCharacters(String(value ?? '')).replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const outcomes: Record<string, string> = { pass: 'Пройдено', fail: 'Не пройдено', ungraded: 'По рубрикам', invalid: 'Не измерено', cancelled: 'Остановлено', unknown: 'Неясно' };

/** A portable, script-free report. All supplied/model text is escaped before entering HTML. */
export function htmlReport(record: Experiment, comparison?: RunComparison): string {
  const evidence = evidenceSummary(record);
  const verdict = evidence.verdict;
  const pending = awaitingVerdict(record);
  const failures = record.trials.filter(t => isAgentFailure(record, t)).length;
  const items = (values: string[]) => `<ul>${values.map(v => `<li>${escape(v)}</li>`).join('')}</ul>`;
  const target = record.target.kind === 'sandbox' ? 'Песочница' : record.target.kind === 'http' ? record.target.url
    : record.target.kind === 'module' ? record.target.path : [record.target.command, ...record.target.args].join(' ');
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Agent Lab · ${escape(record.task)}</title><style>
:root{color-scheme:light dark;--bg:#f8f9f7;--surface:#fff;--text:#18211e;--muted:#5c6861;--line:#dfe5df;--accent:#12684c;--warn:#935118}
@media(prefers-color-scheme:dark){:root{--bg:#101713;--surface:#18211c;--text:#edf3ee;--muted:#a5b3a9;--line:#334039;--accent:#85d8b6;--warn:#f1bd80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 system-ui,sans-serif}main{max-width:1040px;margin:auto;padding:48px 28px 80px}header{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid var(--line);padding-bottom:22px;color:var(--muted);font-size:13px}.brand{font-weight:750;letter-spacing:.15em;color:var(--accent)}h1{font-size:clamp(26px,4vw,42px);line-height:1.18;letter-spacing:-.035em;margin:38px 0 16px;max-width:900px}h2{font-size:21px;letter-spacing:-.02em;margin:0 0 16px}h3{font-size:14px;color:var(--muted);font-weight:500;margin:0}p{margin:10px 0}.muted{color:var(--muted)}.lead{font-size:20px;max-width:820px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}.metric,section{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:24px}.metric strong{display:block;font-size:34px;line-height:1.3;margin-top:10px;letter-spacing:-.04em}section{margin:18px 0}.tag{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:2px 9px;font-size:12px;color:var(--muted)}.warning{color:var(--warn)}ul{padding-left:22px;margin:10px 0}li{margin:7px 0}details{border-top:1px solid var(--line);padding:18px 0}summary{cursor:pointer;font-weight:650;overflow-wrap:anywhere}summary:focus-visible{outline:3px solid var(--accent);outline-offset:6px}details p,pre{overflow-wrap:anywhere}pre{white-space:pre-wrap;font:13px/1.6 ui-monospace,monospace;background:var(--bg);padding:16px;border-radius:8px;max-height:500px;overflow:auto}.turn{border-left:2px solid var(--line);padding:4px 18px;margin:20px 0}.turn.user{border-color:var(--accent)}.turn small{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}footer{color:var(--muted);font-size:12px;margin-top:36px}code{font-size:13px;overflow-wrap:anywhere}@media(max-width:640px){main{padding:24px 16px}.grid{grid-template-columns:repeat(2,1fr)}section,.metric{padding:18px}header{flex-direction:column;gap:8px}}@media print{:root{--bg:#fff;--surface:#fff;--text:#000;--muted:#444;--line:#ddd;--accent:#14563e;--warn:#754619}main{padding:0}section{break-inside:avoid}details[open] pre{max-height:none}summary{list-style:none}}
</style></head><body><main>
<header><span class="brand">AGENT LAB</span><span>${escape(record.createdAt.slice(0, 16).replace('T', ' '))} UTC · ${escape(record.id.slice(0, 8))}</span></header>
<h1>${escape(record.task)}</h1><p class="lead">${escape(verdict.headline)}</p>
<p class="muted">${record.mode === 'demo' ? 'Сценарное демо' : 'Живой прогон'} · ${record.resultsReviewedAt ? 'Аудит завершён' : 'Аудит не завершён'} · Версия ${escape(record.targetVersion ?? record.targetFingerprint?.slice(0, 12) ?? 'не указана')}</p>
<div class="grid"><article class="metric"><h3>${verdict.graded ? 'Объективно пройдено' : 'По рубрикам · предварительно'}</h3><strong>${verdict.graded ? verdict.passed : verdict.rubric.passed}<span class="muted"> / ${verdict.graded || verdict.rubric.assessed}</span></strong></article><article class="metric"><h3>Диалоги с провалами</h3><strong>${failures}</strong></article><article class="metric"><h3>Ожидают разбора</h3><strong>${pending.size}</strong></article><article class="metric"><h3>Разных карточек</h3><strong>${record.scenarios.length}</strong></article></div>
<section><h2>Что делать дальше</h2>${items(verdict.nextSteps.map(n => n.text))}</section>
<section><h2>Границы результата</h2>${items([...verdict.confidenceReasons.map(n => n.text), ...evidence.notes, ...record.limitations])}<p class="muted">Карточки: ${verdict.provenance.synthetic.cards} синтетических, ${verdict.provenance.curated.cards} golden, ${verdict.provenance.production.cards} из реальных диалогов. Порог аудита — ориентир, не гарантия качества в продакшне.</p></section>
${comparison ? `<section><h2>Изменение версии</h2><p>${escape(comparison.headline)}</p>${items([...comparison.regressed.map(c => `Сломалось: ${c.title}`), ...comparison.fixed.map(c => `Исправлено: ${c.title}`), ...comparison.notes])}</section>` : ''}
${record.failureModes?.length ? `<section><h2>Типы провалов</h2>${items(record.failureModes.map(m => `${m.name}: ${m.description} (${m.trialIds.length} диалогов)`))}</section>` : ''}
<section><h2>Карточки и критерии</h2><p class="muted">${record.reviewedAt ? 'Версия, использованная в прогоне.' : 'Черновик · карточки ещё не утверждены.'}</p>
${record.scenarios.filter(s => record.workflow === 'evaluate' || s.split === 'dev' || !!record.controlConsumedAt && !['control', 'improving', 'baseline'].includes(record.phase)).map(s => `<details><summary>${escape(s.title)}</summary>
<p>${escape(s.user.persona ?? 'Без персоны · по цели, фактам и поведению')}${s.profileId ? ` · профиль ${escape(s.profileId)}` : ''}</p>${items(s.user.characteristics ?? [])}
${items([`Цель: ${s.user.goal}`, `Знает: ${s.user.facts}`, `Поведение: ${s.user.behavior}`, `Первая реплика: ${s.user.opening}`, `Успех: ${s.successCriteria ?? 'По проверкам ниже'}`])}
<h3>Проверки и рубрики</h3>${items([...s.checks.map(c => c.description), ...(s.metrics ?? []).map(m => `${m.subject === 'simulator' ? 'Симулятор' : 'Агент'} · ${m.name}. Прошёл: ${m.passCriteria} Не прошёл: ${m.failCriteria}`)])}
${s.assumptions?.length ? `<h3>Допущения</h3>${items(s.assumptions)}` : ''}</details>`).join('')}
${record.profiles.length ? `<h3>Исходные профили и правки</h3>${record.profiles.map(p => `<details><summary>${escape(p.id)} · ${p.source === 'owner' ? 'Задан владельцем' : 'Выведен из логов'}${p.draftOverride ? ' · Правка черновика' : ''}</summary>
<p>${escape(p.persona ?? 'Без персоны')}</p>${items(p.characteristics)}${p.observedStyle ? `<p>${escape(p.observedStyle)}</p>` : ''}<p class="muted">Диалоги: ${escape(p.evidenceDialogueIds.join(', ') || 'не использовались')}</p>
${p.draftOverride ? `<h3>Используется после правки</h3>${items([...(p.draftOverride.persona !== undefined ? [`Персона: ${p.draftOverride.persona ?? 'убрана'}`] : []), ...(p.draftOverride.characteristics !== undefined ? [`Характеристики: ${p.draftOverride.characteristics.join('; ') || 'убраны'}`] : [])])}` : ''}</details>`).join('')}` : ''}</section>
<section><h2>Диалоги и основания</h2><p class="muted">Раскройте диалог, чтобы проверить ответ, оценки и трассу.</p>
${record.trials.map(trial => {
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    const failed = isAgentFailure(record, trial);
    const reviews = record.humanReviews.filter(r => r.trialId === trial.id);
    return `<details><summary><span class="tag${failed ? ' warning' : ''}">${escape(failed ? 'Требует внимания' : outcomes[trial.outcome])}</span> ${escape(scenario?.title ?? trial.scenarioId)} <span class="muted">· ${escape(trial.userMode)} #${trial.repeat + 1}</span></summary>
<p class="muted">${escape(trial.reason)} · ${(trial.elapsedMs / 1000).toFixed(1)} с</p>
${trial.events.filter(e => ['user', 'assistant', 'error'].includes(e.type)).map(e => `<div class="turn ${e.type === 'user' ? 'user' : ''}"><small>#${e.seq} ${e.type === 'user' ? 'Пользователь' : e.type === 'assistant' ? 'Агент' : 'Ошибка'}</small><p>${escape(e.text).replaceAll('\n', '<br>')}</p></div>`).join('')}
<h3>Объективные проверки</h3>${items(trial.checks.map(c => `${c.passed ? 'Пройдено' : 'Не пройдено'} · ${c.description}: ${c.evidence}`))}
<h3>Оценки по рубрикам · предварительные</h3>${items((trial.assessments ?? []).map(a => `${outcomes[a.result]} · ${scenario?.metrics?.find(m => m.id === a.metricId)?.name ?? a.metricId}: ${a.rationale} (#${a.evidence.join(', #')})`))}
${trial.assessmentError ? `<p class="warning">${escape(trial.assessmentError)}</p>` : ''}
<h3>Вердикты человека</h3>${reviews.length ? items(reviews.map(r => `${outcomes[r.verdict]} · ${r.metricId ?? r.checkId ?? 'весь диалог'}: ${r.note}`)) : '<p class="muted">Не записаны.</p>'}
<details><summary>Полная трасса и состояния</summary><pre>${escape(JSON.stringify({ events: trial.events, initialState: trial.initialState, finalState: trial.finalState }, null, 2))}</pre></details></details>`;
  }).join('')}
</section><footer><p>Подключение: <code>${escape(target)}</code></p><p>Расходы выбранной модели: ${record.usage.costUsd === null ? 'неизвестны' : `$${record.usage.costUsd.toFixed(4)}`}. Расходы внешнего агента не входят в эту оценку.</p><p>Локальный отчёт. Модельные оценки, сообщённое состояние и человеческие вердикты сохраняются раздельно.</p></footer></main></body></html>`;
}
