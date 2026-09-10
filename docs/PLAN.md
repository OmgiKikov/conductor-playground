# Agent Lab v2: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Agent Lab from "evaluates the sandbox agent it built" into "evaluates the agent you actually run, on your real data, and tells you how far the simulator and the judge are from humans".

**Architecture:** Keep the existing seams (Runtime for models, TargetSession for the agent under test, ExperimentLab for orchestration, Pi extension for the human). Add adapters and pure statistics behind them; no new frameworks. Every claim stays labelled: observed vs confirmed, synthetic vs production.

**Tech Stack:** TypeScript 5.9, Node 22 (global fetch, node:test), zod 4, typebox, @earendil-works/pi-coding-agent 0.85.1, @earendil-works/pi-tui.

**Spec:** this document, section "Что берём из ревью" (each numbered take maps to tasks). Sources of the takes: the review of 2026-09-08 in the Pi session transcript and the verified external sources listed at the end.

Дата: 2026-09-08. Базовый коммит: `85579dc`. Ветка: `pi-agent-builder-evals`. Язык документа: русский для текста, английский для кода и идентификаторов.

## Global Constraints

- Node `>=22.19.0`; никаких новых runtime-зависимостей.
- Pi остаётся единственным интерфейсом. Нет web-приложения и сервера. Вложенные сессии без fetch, shell и файловых инструментов.
- Методика встроена в код, схемы и промпты. Ссылки только в документации для человека.
- Человек утверждает черновик до диалогов и проверяет результаты после. Модель не может подтвердить ни то, ни другое.
- Каждое число в отчёте помечено: «наблюдение» или «подтверждено», «синтетика» или «продакшн».
- Файлы не превышают 1000 строк; отдельный модуль на ответственность, без DI-контейнеров и generic-фреймворков.
- Секреты не попадают в записи экспериментов и экспорт.
- `npm test` зелёный после каждой задачи; коммит после каждой задачи.

---

## Что берём из ревью (каждый тейк → задача)

| # | Тейк из ревью | Источник | Задача |
|---|---|---|---|
| 1 | Нет адаптера к реальному агенту; все три OSS-инструмента подключают внешний агент одним callback | Scenario, DeepEval, promptfoo | T3, T4 |
| 2 | Синтетика первична, а должны быть реальные ошибки и продовые диалоги | Anthropic evals, OpenAI best practices | T2, T5 |
| 3 | Верность симулятора никем не проверяется, LLM оценивает LLM | Lost in Simulation, Sim2Real, Never Walk Away | T6, T7 |
| 4 | Персона из головы даёт карикатуру (Directive Amplification) | RealUserSim | T7 |
| 5 | Судья не откалиброван; нужны TPR/TNR и n≈100 на тип ошибки | Hamel Husain | T6 |
| 6 | Вердикт «improved» недостижим при дефолтах; нужна описательная дельта с интервалом | Anthropic statistics | T6, T8 |
| 7 | Не проведён эксперимент «корзина vs scripted vs реактивный симулятор» | заметки пользователя | T4, T5, T6 |
| 8 | Симуляторы не уходят и не отказывают (disengagement deficit) | Never Walk Away | T7 |
| 9 | evaluation.ts смешивает инструменты, раннер и статистику; два одинаковых цикла в experiment.ts | thermo-nuclear, improve-codebase-architecture | T1 |
| 10 | Промпты ролей внутри SDK-оркестрации | improve-codebase-architecture | T1 |
| 11 | Опциональные поля Experiment протекли в тип | thermo-nuclear | T2 |

---

## Step 0. Scope challenge (plan-eng-review)

**What already exists и переиспользуется.**

- `Runtime` seam (`prepare/improve/openTarget/userTurn/assess`) с двумя адаптерами: Pi и demo. Новая роль `profiles` добавляется в тот же seam.
- `TargetSession { respond, close }` уже отделяет раннер от того, кто отвечает. Сегодня две реализации (Pi, demo). Внешние адаптеры встают за ту же interface.
- `user.maxFollowUps = 0` уже даёт «статический» режим одной реплики. Режимы формализуют то, что есть.
- `provenance: 'synthetic' | 'curated'` уже в схеме. Добавляем `'production'`.
- `humanReviews` хранятся отдельно от `assessments`. Это готовый вход для калибровки судьи; не хватает только вычисления.
- `compareTrials` уже считает парные дельты по семействам и bootstrap-интервал. Описательный блок строится из его полей.
- Доска `LabBoard` с секциями и клавишами. Новая секция «Статистика» добавляется без нового компонента.

**Minimum set of changes.** Всё в таблице выше. Ничего из этого нельзя отложить без потери одного из тейков, кроме T1 (рефакторинг). T1 оставлен, потому что без него T4 и T6 раздувают `evaluation.ts` до несогласованного файла и дублируют цикл прогонов.

**Complexity check.** План трогает 12 файлов и добавляет 4 модуля (`sandbox.ts`, `comparison.ts`, `targets.ts`, `prompts.ts`). Это триггер. Решение в автоматическом режиме: **идти полным объёмом**, потому что каждый модуль отвечает одному подтверждённому тейку, ни один не вводит новую технологию, и все встают за уже существующие seams. Минимальная версия (только T2–T6 без T1 и T7) сэкономила бы около 20 минут работы агента и оставила бы два дублирующихся цикла и симулятор без заземления. Отклонено.

**Search check.** [Layer 1] Node 22 `fetch` и `AbortSignal.any/timeout` для HTTP-адаптера, без библиотек. [Layer 1] динамический `import()` c `pathToFileURL` для модульного адаптера. [Layer 1] zod `discriminatedUnion` для видов target, уже используется для checks. [Layer 1] percentile bootstrap уже реализован. Новых токенов инноваций не тратим.

**Distribution.** Артефакт прежний: npm-пакет Pi. CI (`npm test`, `npm pack --dry-run`) без изменений. Добавляется `examples/echo-agent.mjs` как справочный адаптер и попадает в `files`.

**TODOS.md.** Отсутствует. Новые отложенные пункты перечислены в разделе «NOT in scope».

---

## Архитектура целевого состояния

```
                    Pi conversation (trusted operator)
   ┌────────────────────────────────────────────────────────────────┐
   │ agent_lab_build ─┐  agent_lab_edit   agent_lab_inspect         │
   │ /agent-lab board ┴─► ExperimentLab (experiment.ts)             │
   └───────────┬───────────────────────────────┬────────────────────┘
               │ create/updateDraft/start       │ evidenceSummary (read)
               ▼                                ▼
   ┌──────────────────────┐          ┌──────────────────────────┐
   │ Runtime (models)     │          │ comparison.ts (pure)     │
   │  pi.ts  ◄─ prompts.ts│          │  compareTrials           │
   │  demo.ts             │          │  compareUserModes        │
   │  prepare/profiles/   │          │  judgeCalibration        │
   │  userTurn/assess/    │          │  simulatorFidelity       │
   │  improve/openTarget  │          │  evidenceSummary         │
   └──────────┬───────────┘          └──────────────────────────┘
              │ userTurn / assess              ▲ reads Experiment
              ▼                                │
   ┌──────────────────────┐   respond   ┌──────┴───────────────┐
   │ evaluation.ts runner │◄───────────►│ TargetSession        │
   │  userMode:           │             │  sandbox: Pi session │
   │   reactive/scripted/ │             │  http:   targets.ts  │
   │   static             │             │  module: targets.ts  │
   │  grade(checks)       │             └──────────────────────┘
   └──────────┬───────────┘
              │ tools (sandbox only)
              ▼
   ┌──────────────────────┐
   │ sandbox.ts           │  World: records, writableFields, transientFailures
   └──────────────────────┘
```

Поток данных одного прогона в режиме `evaluate`:

```
Task + materials + existingAgent? + target + goldenCases[] + dialogues[]
  → prepare: requirements → profiles(dialogues) → cards(profiles) → agent
  → goldenCases → curated scenarios (appended)
  → phase review: human edits/approves exact draftHash
  → for mode in settings.userModes: for scenario: for repeat: evaluateTrial
  → phase results_review: human annotates → reviewResults
  → evidenceSummary: modes · calibration · fidelity · descriptive comparison
```

Состояния эксперимента (без изменений, только `evaluating` теперь итерирует режимы):

```
preparing → review → evaluating → results_review → complete
                 └──► baseline → improving → control → complete   (compare workflow)
any running phase → cancelled | error | interrupted
```

---

## 1. Architecture review (plan-eng-review, авторешения)

Формат: `[SEVERITY] (confidence) место — проблема` → решение.

**A1 [P1] (9/10) src/evaluation.ts:160 `session = await runtime.openTarget(...)`** — единственный способ получить цель; внешний агент недостижим.
Решение **1A**: раннер выбирает `runtime.openTarget` для `target.kind === 'sandbox'` и `openExternalTarget` из `targets.ts` для `http`/`module`. Интерфейс `TargetSession` не меняется. Альтернатива 1B (класть внешние цели в Runtime) отклонена: Runtime про модели, а не про испытуемого; смешивание сделает demo-runtime знать про HTTP.

**A2 [P1] (8/10) src/evaluation.ts:101 `grade()` читает `trial.finalState`** — для внешнего агента песочница не видит его действий.
Решение **2A**: ответ адаптера может нести `events[]` и `records`. Раннер пишет events в трассу, `records` заменяют записи мира до оценки. В `limitations` появляется строка «состояние сообщено внешним harness, не наблюдалось доверенным кодом». Альтернатива 2B (запрещать `state_equals` для внешних целей) отклонена: их заметки прямо требуют управляемое состояние пользователя из тестового контура.

**A3 [P2] (8/10) src/contracts.ts createInputSchema** — импорт реальных данных как отдельный tool даст записи вне манифеста и нарушит freeze.
Решение **3A**: `goldenCases` и `dialogues` часть `createInput`, сохраняются в Experiment и входят в `measurementHash`. Отдельный tool не нужен.

**A4 [P2] (7/10) src/pi.ts cards role** — модель придумывает persona/characteristics; RealUserSim показывает, что рукописные черты утрируются.
Решение **4A**: роль `profiles` извлекает профили из реальных диалогов с `evidenceDialogueIds`; генератор карточек выбирает `profileId`, а код копирует persona и characteristics из профиля поверх ответа модели. Модель не может приукрасить.

**A5 [P2] (8/10) settings** — режимы пользователя нужны как условие эксперимента, а не как свойство карточки.
Решение **5A**: `settings.userModes` (по умолчанию `['reactive']`) для `evaluate`; `compare` требует ровно один режим. `trial.userMode` записывается. Для `scripted` карточка должна иметь `user.script`; иначе она пропускается в этом режиме с пометкой.

**A6 [P2] (9/10) src/experiment.ts** — производные числа (калибровка, верность) нельзя хранить: они устаревают при каждой заметке человека.
Решение **6A**: считать на чтение чистыми функциями в `comparison.ts`; расширение, доска, CLI и отчёт вызывают одну `evidenceSummary(record)`. Никто, кроме этой функции, не считает баллы.

**A7 [P1] (9/10) targets.ts headers** — заголовок Authorization в `target.headers` попал бы в JSON эксперимента и экспорт.
Решение **8A**: только `headersEnv: { HeaderName: ENV_VAR }`. Значения читаются из окружения в момент запроса, в записи остаются имена переменных. Отсутствующая переменная это ошибка до первого диалога.

**A8 [P2] (7/10) распространение** — модульный адаптер исполняет код пользователя в процессе Pi.
Решение: документировать как доверенную операцию оператора, требовать абсолютный путь, никаких сетевых загрузок модулей.

Сценарии отказов новых путей смотри в разделе «Failure modes».

## 2. Code quality review (thermo-nuclear, авторешения)

**Q1 [P1] (9/10) src/evaluation.ts (348 строк)** — четыре ответственности в одном модуле: инструменты песочницы, предикаты оценки, раннер, статистика. С добавлением калибровки и верности файл станет несогласованным.
Решение: `sandbox.ts` (tools), `evaluation.ts` (runner + grade), `comparison.ts` (все чистые функции над записью). Перенос без изменения поведения, тесты зелёные до и после.

**Q2 [P1] (9/10) src/experiment.ts:200 и :215** — цикл `for scenario / for repeat / evaluateTrial / checkpoint` продублирован в `execute` и `evaluateReviewed`.
Решение: приватный `runSuite(record, revision, split, ctx)` с итерацией по режимам. Deletion test пройден: удаление копий концентрирует сложность в одном месте.

**Q3 [P2] (8/10) src/pi.ts:250–360** — около 170 строк прозы ролей внутри SDK-оркестрации.
Решение: `prompts.ts` с типизированными константами и функциями (`cardsRole(compare, hasProfiles)`). Тесты могут проверять содержимое промптов без SDK.

**Q4 [P2] (8/10) src/contracts.ts Experiment** — `workflow?`, `humanReviews?`, `resultsReviewedAt?` опциональны ради старых файлов; девять мест с `?? []` и `?.`.
Решение: defaults в `experimentSchema` при загрузке, тип без `?` для `workflow` и `humanReviews`. `resultsReviewedAt`/`resultsReviewHash` остаются опциональными: это реальное состояние «не проверено».

**Q5 [P3] (7/10) extensions/agent-lab.ts summary()/exportArtifacts()** — отчёт собирается из полей сравнения вручную.
Решение: отчёт и summary берут блок `evidence` из `evidenceSummary`. Расширение перестаёт считать.

**Q6 [P3] (6/10) src/demo.ts regex-агент** — приемлемо: помечен как scripted, покрыт тестами. Без изменений. Medium confidence, verify this is actually an issue: нет.

## 3. Test review

Фреймворк: `node:test` через `tsx`, запуск `npm test` (сначала `tsc` build). Существующие тесты: 66, все зелёные на `85579dc`.

```
CODE PATHS                                                      USER FLOWS
[+] src/targets.ts                                              [+] Подключение своего агента
  ├── openExternalTarget(http)                                    ├── [GAP] [→E2E] build с target.http → review → run → results
  │   ├── [GAP] 200 + valid body → reply, events, records         ├── [GAP] переменная окружения не задана → понятная ошибка до диалогов
  │   ├── [GAP] 500 → invalid trial, stage 'target response'      └── [GAP] адаптер вернул мусор → invalid, не pass
  │   ├── [GAP] timeout → invalid, reason mentions deadline
  │   ├── [GAP] abort via ctx.signal → cancelled
  │   └── [GAP] headersEnv missing var → throws before session
  └── openExternalTarget(module)
      ├── [GAP] valid factory → reply; close() called
      ├── [GAP] missing export → invalid
      └── [GAP] string reply normalized
[+] src/evaluation.ts evaluateTrial                             [+] Режимы пользователя
  ├── userMode static → stops after first response                ├── [GAP] evaluate с 3 режимами → 3×N диалогов в results
  ├── userMode scripted → lines in order, stops when exhausted    ├── [GAP] карточка без script в scripted → пропуск с пометкой
  ├── userMode scripted + done budget still bounds                └── [GAP] статистика режимов на доске (секция 4)
  ├── userMode reactive → unchanged (existing ★★★)
  ├── external records replace world before grade
  └── external events appear in trace with seq
[+] src/comparison.ts                                           [+] Калибровка и верность
  ├── compareUserModes: pass rate, unique failed checks            ├── [GAP] n<60 → «недостаточно» на доске и в отчёте
  ├── judgeCalibration: TP/TN/FP/FN, TPR, TNR, n, sufficient       ├── [GAP] без диалогов → блок верности «нет реальных данных»
  ├── judgeCalibration: latest human verdict wins                  └── [GAP] описательная дельта видна при insufficient
  ├── simulatorFidelity: real vs simulated, gaps, human share
  └── evidenceSummary: descriptive comparison text
[+] src/experiment.ts                                           [+] Импорт реальных данных
  ├── runSuite iterates modes × scenarios × repeats                ├── [GAP] goldenCases → curated карточки в review
  ├── compare rejects >1 mode                                      ├── [GAP] dialogues → profiles → карточки ссылаются на profileId
  ├── create: golden → curated scenarios, ids unique               └── [GAP] persona из профиля перезаписывает ответ модели
  ├── create: profiles from runtime.profiles, evidence ids valid
  └── measurementHash covers target/golden/dialogues/profiles
[+] src/pi.ts + prompts.ts                                      LLM integration
  ├── profiles role: rejects unknown evidence ids                  [GAP] [→EVAL] simulator prompt содержит разрешение уйти
  ├── cards role receives observedProfiles                         [GAP] [→EVAL] persona копируется из профиля
  └── simulator prompt has disengagement + no-exaggeration lines
[+] extensions                                                  
  ├── agent_lab_build принимает target/goldenCases/dialogues/userModes
  ├── agent_lab_inspect возвращает evidence
  ├── exportArtifacts включает описательный блок и статистику
  └── LabBoard секция 4 рендерится в узком и широком терминале

COVERAGE (планируемая): 38 новых путей, 38 тестов; существующие 66 сохраняются
```

Регрессии: перенос `compareTrials` и `sandbox` не меняет поведение; существующие тесты `evaluation.test.ts` обновляют только импорты. Это регрессионная защита по правилу IRON RULE.

## 4. Performance review

- **Трижды больше диалогов.** `userModes` умножает число прогонов. Бюджет `maxCalls=300` при 5 картах × 3 режима × ~6 вызовов ≈ 90. Достаточно; лимит остаётся жёстким стопом.
- **Статистика на каждом refresh доски (750 мс).** `evidenceSummary` это O(trials × events) над локальной записью, единицы миллисекунд. Мемоизация не нужна.
- **Размер записи.** До 200 диалогов × 60 сообщений × 8000 символов теоретически 96 МБ; практический кап: суммарно 2 000 000 символов на dialogues (проверка в схеме). Лимит файла 50 МБ остаётся.
- **HTTP-адаптер.** Последовательные запросы, таймаут на запрос `target.timeoutMs` (60 с по умолчанию), общий таймаут эксперимента прежний.

Проблем не найдено; ограничения зафиксированы в схемах.

## Failure modes

| Путь | Отказ | Тест | Обработка | Что видит человек |
|---|---|---|---|---|
| http adapter | 5xx / сеть | да | trial invalid, reason со статусом | НЕВАЛИДНО + причина, без pass |
| http adapter | таймаут | да | AbortSignal.timeout → invalid | «deadline exceeded» |
| http adapter | тело не по схеме | да | zod → invalid | причина с путём поля |
| http adapter | нет env-переменной | да | ошибка до сессии, эксперимент error | текст с именем переменной |
| module adapter | нет экспорта / throw | да | invalid | причина |
| scripted mode | скрипт закончился раньше | да | stopped=true, валидный исход | обычная оценка |
| scripted mode | карточка без script | да | пропуск, limitation | пометка в статистике |
| profiles role | чужие dialogue ids | да | prepare error | ошибка подготовки |
| calibration | n < 60 | да | `sufficient=false` | «недостаточно данных» |
| fidelity | нет реальных диалогов | да | `null` | «нет реальных данных» |
| external state | records не переданы | да | мир без изменений, limitation | проверки состояния честно fail |

Критических пробелов (без теста, без обработки, молча) нет.

## NOT in scope

- **Обучаемый симулятор** (RealUserSim-style fine-tuning). Заземляем промпт профилями из логов; модель не дообучаем.
- **Коннекторы к Langfuse/Arize/логам.** Импорт только из JSON по документированному формату.
- **Автоподстройка судьи по калибровке.** Отчёт показывает TPR/TNR; правка рубрики остаётся за человеком.
- **Сравнение двух внешних версий агента** (prompt_v10 vs prompt_v11 по HTTP). Требует `candidateTarget` и отдельного согласования, что считается «версией». Следующий этап Improvement Engine.
- **Параллельные эксперименты и очередь.** Один активный эксперимент на каталог, как раньше.
- **Публикация в npm.** Пакет ставится по пути.
- **Метрика USI как в Sim2Real.** Реализуем прозрачные описательные метрики и долю человеческих вердиктов; USI требует размеченных людьми диалогов по восьми измерениям.

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| T1 refactor | src/ (evaluation, sandbox, comparison, prompts, experiment) | — |
| T2 contracts | src/contracts.ts | T1 |
| T3 targets | src/targets.ts, test/fixtures | T2 |
| T4 evaluation modes + external | src/evaluation.ts | T2, T3 |
| T5 experiment | src/experiment.ts, src/demo.ts | T2, T4 |
| T6 statistics | src/comparison.ts | T2 |
| T7 prompts/profiles | src/prompts.ts, src/pi.ts, src/demo.ts | T2 |
| T8 extension/board/CLI | extensions/, src/cli.ts | T5, T6, T7 |
| T9 docs | README, SKILL, CONTEXT | T8 |

Lane A: T1 → T2 → T3 → T4 → T5 (shared src/). Lane B: T6 (comparison.ts, независим после T2). Lane C: T7 (pi.ts/prompts.ts/demo.ts, независим после T2; demo.ts пересекается с T5, поэтому demo-часть T7 делается после T5). Execution: T1, T2 последовательно; затем T3–T5 и T6 параллельно; T7 после T5; T8, T9 последовательно. Выполнение inline в этой сессии, последовательно, чтобы не ловить лимиты API.

---

## Implementation Tasks

### Task 1: Структурный рефакторинг без изменения поведения

**Files:**
- Create: `src/sandbox.ts`, `src/comparison.ts`, `src/prompts.ts`
- Modify: `src/evaluation.ts`, `src/pi.ts`, `src/experiment.ts`, `test/evaluation.test.ts` (импорты)

**Interfaces:**
- Produces: `sandbox(state: World, sources: Source[], push, ctx): Tool[]` из `sandbox.ts`; `compareTrials(...)` из `comparison.ts` с прежней сигнатурой; константы промптов из `prompts.ts`: `TOOL_GUIDE`, `DATA_BOUNDARY`, `REQUIREMENTS_ROLE`, `FAMILY_PLAN_ROLE`, `cardsRole(compare: boolean, hasProfiles: boolean): string`, `AGENT_ROLE`, `IMPROVE_ROLE`, `ASSESS_ROLE`, `SIMULATOR_ROLE`, `PROFILES_ROLE`.
- Consumes: ничего нового.

- [x] **Step 1: Перенести `sandbox()` в `src/sandbox.ts`**

```ts
// src/sandbox.ts
import { z } from 'zod';
import { scalarSchema, type CallContext, type Source, type Tool, type Trial, type World } from './contracts.js';
// ...тело функции sandbox и вспомогательные схемы queryArgs/lookupArgs/updateArgs без изменений...
export function sandbox(state: World, sources: Source[], push: (event: Omit<Trial['events'][number], 'seq'>) => void, ctx: CallContext): Tool[] { /* moved verbatim */ }
```

- [x] **Step 2: Перенести `clusterInterval` и `compareTrials` в `src/comparison.ts`**, оставить в `evaluation.ts` re-export `export { compareTrials } from './comparison.js';` на один коммит, затем обновить импорты в `experiment.ts` и тестах и удалить re-export.

- [x] **Step 3: Создать `src/prompts.ts`** и перенести дословно строки ролей из `pi.ts`. `cardsRole(compare, hasProfiles)` возвращает текущий текст плюс (при `hasProfiles`) абзац:

```ts
export const PROFILE_CLAUSE = `observedProfiles lists user profiles extracted from real dialogues. Every synthetic card MUST set profileId to one of them. Do not write persona or characteristics yourself: the harness copies them from the chosen profile. Vary goals and facts, not personality.`;
```

- [x] **Step 4: В `experiment.ts` выделить `private async runSuite(record, revision, split, ctx)`** и вызвать его из `execute` и `evaluateReviewed`. Сообщение чекпоинта: `${label}: ${scenario.title} · ${repeat + 1}/${repeats}`.

- [x] **Step 5: Запустить `npm test`**, ожидание: 66 pass. Коммит `refactor: split evaluation into sandbox/comparison, extract prompts and runSuite`.

### Task 2: Контракты v2

**Files:**
- Modify: `src/contracts.ts`
- Test: `test/contracts.test.ts` (новый)

**Interfaces (Produces):**

```ts
export const userModeSchema = z.enum(['reactive', 'scripted', 'static']);
export type UserMode = z.infer<typeof userModeSchema>;
export const targetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sandbox') }),
  z.strictObject({ kind: z.literal('http'), url: z.string().url().max(2000),
    headersEnv: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/)).default({}),
    timeoutMs: z.number().int().min(1000).max(120000).default(60000) }),
  z.strictObject({ kind: z.literal('module'), path: z.string().min(1).max(4000).refine(p => p.startsWith('/'), 'Absolute path required'),
    exportName: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/).default('createSession') }),
]);
export type Target = z.infer<typeof targetSchema>;
export const dialogueSchema = z.strictObject({
  id: identifier, goal: text.max(3000).optional(),
  messages: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), content: text.max(8000) })).min(1).max(60),
  outcome: z.enum(['success', 'failure', 'abandoned', 'unknown']).default('unknown'),
});
export type Dialogue = z.infer<typeof dialogueSchema>;
export const profileSchema = z.strictObject({
  id: identifier, persona: text.max(2000), characteristics: z.array(text.max(300)).min(1).max(12),
  observedStyle: text.max(2000), evidenceDialogueIds: z.array(identifier).min(1).max(50),
});
export type Profile = z.infer<typeof profileSchema>;
export const goldenCaseSchema = z.strictObject({
  id: identifier, title: text.max(200).optional(), goal: text.max(3000), opening: text.max(3000),
  facts: text.max(5000).default('No additional facts.'), persona: text.max(2000).optional(),
  characteristics: z.array(text.max(300)).max(12).default([]), behavior: text.max(2000).default('Ask once; answer clarifications from facts; finish when answered.'),
  script: z.array(text.max(3000)).max(15).optional(), maxFollowUps: z.number().int().min(0).max(15).default(1),
  successCriteria: text.max(3000), initialState: worldSchema.default({ records: {}, writableFields: [], transientFailures: 0 }),
  checks: z.array(checkSchema).max(12).default([]), metrics: z.array(rubricSchema).max(8).default([]),
});
export type GoldenCase = z.infer<typeof goldenCaseSchema>;
export function goldenToScenario(c: GoldenCase): Omit<Scenario, 'split'>;
```

Изменения существующих схем:
- `userSchema` += `script: z.array(text.max(3000)).max(15).optional()`.
- `scenarioSchema`: `provenance: z.enum(['synthetic', 'curated', 'production'])`, `profileId: identifier.optional()`, `requirementIds: z.array(identifier).max(20)`; `.superRefine`: synthetic требует `requirementIds.length >= 1`.
- `settingsSchema` += `userModes: z.array(userModeSchema).min(1).max(3).refine(unique).default(['reactive'])`.
- `createInputSchema` += `target: targetSchema.default({ kind: 'sandbox' })`, `goldenCases: z.array(goldenCaseSchema).max(40).default([])`, `dialogues: z.array(dialogueSchema).max(200).default([])`; refine: суммарная длина `dialogues` ≤ 2 000 000 символов; уникальные id.
- `Experiment` += `target: Target; goldenCases: GoldenCase[]; dialogues: Dialogue[]; profiles: Profile[]`; `workflow: 'evaluate' | 'compare'` и `humanReviews: HumanReview[]` без `?`; в `experimentSchema` defaults: `workflow` → `'compare'`, `humanReviews` → `[]`, `target` → sandbox, массивы → `[]`.
- `Trial` += `userMode: UserMode`; в `trialSchema` `.default('reactive')`.
- `PrepareInput` += `profiles: Profile[]`; `Runtime` += `profiles?(input: { task: string; sources: Source[]; dialogues: Dialogue[] }, ctx): Promise<Profile[]>`.
- `validatePreparation(raw, sources, workflow, profiles = [])`: если `profiles.length` и карточка synthetic → `profileId` обязателен и существует; persona/characteristics копируются из профиля; `provenance !== 'synthetic'` освобождает от `requirementIds.min(1)` и от требования покрытия критичных требований.

- [x] **Step 1: Написать `test/contracts.test.ts`** с кейсами: target http без абсолютного пути → reject; headersEnv с невалидным именем → reject; golden → scenario сохраняет checks/metrics и ставит `provenance:'curated'`; старый Experiment JSON без `workflow/humanReviews/target` парсится с defaults; synthetic без requirementIds → reject, curated без них → ok; `validatePreparation` с профилями перезаписывает persona; неизвестный `profileId` → reject; `userModes` дубликаты → reject.
- [x] **Step 2: Запустить тест, убедиться, что падает** (`tsx --test test/contracts.test.ts`).
- [x] **Step 3: Реализовать схемы** согласно блоку выше.
- [x] **Step 4: `npm test` зелёный**, коммит `feat(contracts): targets, user modes, golden cases, dialogues, profiles`.

### Task 3: Внешние адаптеры цели

**Files:**
- Create: `src/targets.ts`, `examples/echo-agent.mjs`, `test/targets.test.ts`
- Modify: `package.json` (`files` += `examples`)

**Interfaces:**

```ts
// src/targets.ts
export const externalReplySchema = z.union([
  z.string().max(20000),
  z.strictObject({
    reply: z.string().max(20000),
    events: z.array(z.strictObject({ tool: z.string().max(200), args: z.unknown().optional(), result: z.unknown().optional() })).max(50).default([]),
    records: z.record(identifier, z.record(identifier, scalarSchema)).optional(),
  }),
]);
export interface ExternalTargetInput {
  target: Exclude<Target, { kind: 'sandbox' }>; sessionId: string; scenarioId: string;
  state: World; history: () => DialogueMessage[]; ctx: CallContext;
}
export async function openExternalTarget(input: ExternalTargetInput): Promise<TargetSession>;
```

Контракт HTTP: `POST url`, тело `{ sessionId, scenarioId, initialState, messages, message }`, ответ `externalReplySchema`. Заголовки: `content-type: application/json` плюс `headersEnv` из `process.env` (отсутствие переменной → `Error('Environment variable X for header Y is not set')` до первого запроса). Каждый запрос: `AbortSignal.any([ctx.signal, AbortSignal.timeout(target.timeoutMs)])`, `ctx.beforeCall()` не вызывается (это не модельный вызов), но `usage.calls` внешнего агента не считается. Статус не 2xx → `Error(\`External agent responded ${status}\`)`.

Контракт module: `const mod = await import(pathToFileURL(path).href); const factory = mod[exportName]; const session = await factory({ sessionId, scenarioId, initialState }); session.respond(message, messages) → externalReplySchema; session.close?.()`.

Общее: `events` → `ctx.onTargetEvent?.({ type: 'tool_call', tool, args })` и `({ type: 'tool_result', tool, result, state })`; `records` → `state.records = structuredClone(records)`; возвращается `reply` (пустая строка остаётся пустой: раннер сам помечает).

- [x] **Step 1: Написать `examples/echo-agent.mjs`**

```js
export function createSession({ initialState }) {
  const records = structuredClone(initialState.records);
  return {
    async respond(message) {
      const id = Object.keys(records)[0];
      const time = message.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/)?.[0];
      if (id && time && 'time' in records[id]) { records[id].time = time; return { reply: `Moved ${id} to ${time}.`, events: [{ tool: 'update_record', args: { recordId: id, changes: { time } }, result: { ok: true } }], records }; }
      return { reply: `You said: ${message}`, events: [], records };
    },
    async close() {},
  };
}
```

- [x] **Step 2: Написать `test/targets.test.ts`**: локальный `node:http` сервер с режимами ok/500/slow/garbage; проверки из диаграммы; module-адаптер с fixture из `examples/`; отсутствующий экспорт; `headersEnv` без переменной; заголовок реально приходит на сервер; `ctx.signal.abort()` прерывает медленный запрос с причиной сигнала.
- [x] **Step 3: Прогнать, падает.** **Step 4: Реализовать `targets.ts`.** **Step 5: Зелёный, коммит** `feat(targets): http and module adapters for external agents`.

### Task 4: Режимы пользователя и внешняя цель в раннере

**Files:**
- Modify: `src/evaluation.ts`, `test/evaluation.test.ts`

**Interfaces:**
- `evaluateTrial(input & { userMode: UserMode; target: Target })`; `Trial.userMode` заполняется.

Логика после ответа цели:

```ts
if (userMode === 'static' || finalUserReply || (scenario.user.maxFollowUps !== undefined && turn >= scenario.user.maxFollowUps)) { stopped = true; break; }
if (userMode === 'scripted') {
  const next = scenario.user.script?.[turn];
  if (next === undefined) { stopped = true; break; }
  userMessage = next; emit({ type: 'simulator', result: { message: next, done: false, scripted: true } }); continue;
}
// reactive: как раньше
```

Открытие цели:

```ts
session = target.kind === 'sandbox'
  ? await runtime.openTarget(structuredClone(revision.spec), structuredClone(sources), tools, localCtx)
  : await openExternalTarget({ target, sessionId: trial.id, scenarioId: scenario.id, state, history: () => structuredClone(messages), ctx: localCtx });
```

Для внешней цели в `trial.reason` при отсутствии `records` в ответах добавляется суффикс `; external state was not reported`, а `grade` работает над `state` как обычно.

- [x] **Step 1: Тесты**: static останавливается после первого ответа и не вызывает `userTurn`; scripted подаёт реплики по порядку и не вызывает `userTurn`; scripted с `maxFollowUps` меньше длины скрипта останавливается по бюджету; external module-цель: events в трассе с seq, records заменяют мир, `state_equals` проходит; external без records → check fail и суффикс в reason; ошибка адаптера → invalid со stage `target response`.
- [x] **Step 2: Падают. Step 3: Реализация. Step 4: Зелёный, коммит** `feat(evaluation): static/scripted/reactive user modes and external targets`.

### Task 5: Оркестрация: режимы, импорт реальных данных, профили

**Files:**
- Modify: `src/experiment.ts`, `src/demo.ts`, `test/experiment.test.ts`

**Interfaces:**
- `runSuite` итерирует `record.settings.userModes`; для `scripted` пропускает карточки без `script` и один раз добавляет в `limitations`: `Scripted mode skipped N card(s) without a script.`
- `create`: `if (workflow === 'compare' && settings.userModes.length !== 1) throw`; `profiles = runtime.profiles && dialogues.length ? await runtime.profiles({ task, sources, dialogues }, ctx) : []`; проверка `evidenceDialogueIds ⊆ dialogues.map(d => d.id)`; `prepared = validatePreparation(await runtime.prepare({ ..., profiles, goldenCases }), sources, workflow, profiles)`; golden → `goldenToScenario` добавляются к `prepared.scenarios` (уникальность id), `split: 'dev'`.
- `measurementHash` += `target, goldenCases, dialogues, profiles`. `draftHash` += `target, profiles`.
- `demo.ts`: `profiles(input)` детерминированно: одна запись `{ id: 'observed_1', persona: 'Appointment holder (observed in real dialogues)', characteristics: [...из статистики диалогов...], observedStyle: 'avg N chars per message', evidenceDialogueIds: all }`; карточки `clarify` получают `script: ['My appointment ID is A103.']`, `preference` → `script: ['Actually, please move it to 18:00 instead.']`; demo `prepare` при наличии профилей ставит `profileId`.

- [x] **Step 1: Тесты**: evaluate с `userModes: ['static','scripted','reactive']` на демо даёт `3 × cards × repeats` минус пропуски, `trial.userMode` распределён; compare с двумя режимами → reject; goldenCases появляются как `curated` с их checks; dialogues → `profiles.length === 1`, все synthetic-карточки ссылаются на `observed_1` и имеют persona профиля; `measurementHash` меняется при изменении dialogues; профиль с чужим dialogue id → эксперимент в `error` с понятным сообщением.
- [x] **Step 2–4: как в T4.** Коммит `feat(experiment): user modes loop, golden set and dialogue import, grounded profiles`.

### Task 6: Статистика: режимы, калибровка судьи, верность симулятора, описательное сравнение

**Files:**
- Modify: `src/comparison.ts`
- Test: `test/comparison.test.ts` (новый; тесты `compareTrials` переезжают сюда из `evaluation.test.ts`)

**Interfaces (Produces):**

```ts
export interface ModeComparison { userMode: UserMode; trials: number; valid: number; passed: number; passRate: number | null; failedChecks: string[]; uniqueFailedChecks: string[]; avgUserTurns: number | null; calls: number; costUsd: number | null }
export function compareUserModes(record: Experiment): ModeComparison[];
export interface CalibrationRow { key: string; subject: 'agent' | 'simulator' | 'check'; n: number; tp: number; tn: number; fp: number; fn: number; tpr: number | null; tnr: number | null; agreement: number | null; sufficient: boolean }
export function judgeCalibration(record: Experiment): CalibrationRow[];   // sufficient = n >= 60
export interface FidelityReport { metrics: { metric: 'userTurns' | 'userMessageLength' | 'questionRate' | 'disengagementRate'; real: number | null; simulated: number | null; gap: number | null }[]; realDialogues: number; simulatedDialogues: number; humanFidelity: { reviewed: number; passed: number } }
export function simulatorFidelity(record: Experiment): FidelityReport | null;  // null без dialogues
export interface EvidenceSummary { comparison: { observed: string; status: string } | null; modes: ModeComparison[]; calibration: CalibrationRow[]; fidelity: FidelityReport | null; notes: string[] }
export function evidenceSummary(record: Experiment): EvidenceSummary;
```

Определения:
- `uniqueFailedChecks` режима = check ids, провалившиеся в этом режиме хотя бы раз и ни разу не провалившиеся в других режимах на тех же сценариях.
- Калибровка: для каждой пары (trial, metricId) берётся последний human verdict (`pass|fail`) и модельный `result` (`pass|fail`); `unknown`/`invalid` пропускаются. Для checks: human `checkId` verdict против `check.passed`. Положительный класс = `fail` (ошибка агента), поэтому TPR = доля человеческих `fail`, которые судья тоже назвал `fail`.
- Верность: реальные метрики по `dialogues` (user-реплики), симулированные по trials с `userMode === 'reactive'`. `disengagementRate` real = доля `outcome === 'abandoned'`; simulated = доля trials, где последний simulator-event имеет `done: true` и объективный исход не `pass`. `questionRate` = доля user-сообщений с `?`. `humanFidelity` = human verdicts по метрикам `subject: 'simulator'`.
- `comparison.observed` для последнего control-сравнения: `Кандидат исправил {fixed} из {validPairs} пар, регрессий {regressed}; семейная дельта {delta} (95% {lo}…{hi}).`; `status` = вердикт с первой причиной. Для evaluate workflow `comparison = null`.
- `notes`: строки вида `Калибровка: n<60 для {key}`, `Верность: реальные диалоги не загружены`, `Scripted: пропущено N карточек`.

- [x] **Step 1: Тесты** на синтетических записях (фабрика в тесте): режимы с уникальными провалами; калибровка с 3 human/3 model → tp/fp правильные, `sufficient=false`; последний вердикт побеждает; верность без диалогов → null; с диалогами → real/simulated/gap; описательная строка при `insufficient`.
- [x] **Step 2–4.** Коммит `feat(comparison): user-mode comparison, judge calibration, simulator fidelity, descriptive evidence`.

### Task 7: Промпты: профили из реальных диалогов, право уйти, без утрирования

**Files:**
- Modify: `src/prompts.ts`, `src/pi.ts`, `test/pi.test.ts`

**Interfaces:**
- `PROFILES_ROLE`: вход `{ task, dialogues: [{ id, userMessages: string[] , outcome }] }`, выход `{ profiles: Profile[] }` (1–6). Требование: `evidenceDialogueIds` только из входа; `characteristics` описывают наблюдаемый стиль (длина, вопросы, тон, готовность уточнять, склонность прекращать), не демографию.
- `SIMULATOR_ROLE` += две строки:
  `Real users leave. If the assistant cannot help, refuses, or your goal is blocked, you may end like a real user would ("ok, not now") with done:true instead of pushing.`
  `Play the assigned persona at the intensity a real person would show. Do not exaggerate traits; one visible trait per message at most.`
- `cardsRole(compare, hasProfiles)` добавляет `PROFILE_CLAUSE` и поле `profileId` в схему генерируемых карточек.
- `pi.ts`: реализация `profiles()` через `ask('User profiles', PROFILES_ROLE, input, z.strictObject({ profiles: z.array(profileSchema).min(1).max(6) }), ctx)` с проверкой evidence ids; `prepare` передаёт `observedProfiles` в evidence карточек.

- [x] **Step 1: Тесты** через offline SDK fixture: роль профилей отклоняет неизвестный dialogue id; при профилях запрос карточек содержит `observedProfiles` и слово `profileId`; ответ карточки с `profileId` получает persona из профиля (проверяется на выходе `prepare` + `validatePreparation`); запрос симулятора содержит «Real users leave» и «Do not exaggerate».
- [x] **Step 2–4.** Коммит `feat(pi): grounded user profiles, disengagement and anti-exaggeration in the simulator`.

### Task 8: Расширение Pi, доска, CLI, отчёт

**Files:**
- Modify: `extensions/agent-lab.ts`, `extensions/cards.ts`, `src/cli.ts`, `test/extension.test.ts`, `test/cards.test.ts`

**Interfaces:**
- `agent_lab_build` params += `target` (`Type.Unsafe(z.toJSONSchema(targetSchema))`), `goldenCases`, `dialogues`, и `settings.userModes` через существующий `settings`.
- `summary(record)` += `evidence: evidenceSummary(record)`; `agent_lab_inspect` возвращает его.
- `exportArtifacts` отчёт: после заголовка блок «Наблюдаемый результат» (`evidence.comparison.observed` или сводка режимов), затем «Режимы пользователя», «Калибровка судьи», «Верность симулятора», «Ограничения».
- `cards.ts`: секция `4 Статистика` (`key('4')`), `statsLines(record)` рендерит `evidenceSummary`; в шапке `4 Статистика`; в футере подсказка. При `null` частях выводит «нет реальных данных» / «недостаточно данных».
- `/agent-lab` подтверждение запуска показывает число режимов и число диалогов `modes × cards × repeats`.
- `cli.ts`: `export` включает `evidence: evidenceSummary(record)`; help упоминает target и import-поля.

- [x] **Step 1: Тесты**: build с `target: { kind: 'module', path: <examples/echo-agent.mjs> }` в demo-режиме → draft с `target.kind === 'module'`; inspect содержит `evidence.modes`; отчёт содержит «Наблюдаемый результат»; доска рендерит секцию 4 в ширинах 16/40/80/132 без переполнения и показывает «недостаточно данных».
- [x] **Step 2–4.** Коммит `feat(pi-extension): target/import parameters, evidence summary, stats board section`.

### Task 9: Документация и глоссарий

**Files:**
- Modify: `README.md`, `skills/agent-builder/SKILL.md`, `CONTEXT.md`, `package.json` (`files`)

- [x] **Step 1: README**: разделы «Подключение своего агента» (контракты HTTP и module с JSON-примерами, `headersEnv`), «Импорт golden set и реальных диалогов» (формат `task.json`), «Режимы пользователя и эксперимент три‑в‑одном», «Калибровка судьи и верность симулятора» (что значат TPR/TNR, n≥60, что значит gap), «Границы» (reported state, синтетика).
- [x] **Step 2: SKILL.md**: протокол начинается с реальных данных: если есть golden set и диалоги, сначала они; профили только из диалогов; симулятор может уйти; калибровка перед доверием судье; режимы для проверки ценности симулятора.
- [x] **Step 3: CONTEXT.md**: термины Target, User mode, Golden case, Production dialogue, Profile, Calibration, Fidelity, Observed vs Confirmed.
- [x] **Step 4: `npm test`, `npm run typecheck`, `npm pack --dry-run`**. Коммит `docs: external agents, real-data import, calibration and fidelity`.

### Task 10: Верификация

- [x] `npm test` (ожидается ≥ 100 тестов, 0 fail), `npx tsc --noEmit`, `npm pack --dry-run` содержит `examples/`.
- [x] Прогон демо end-to-end через CLI: `node dist/cli.js build --input <task.json с dialogues и goldenCases и userModes>` → phase review; затем через ExperimentLab в тесте — три режима, статистика на выходе.
- [x] Live-проверка с настроенным провайдером (если доступен `openai-codex/gpt-5.6-sol`): одна карточка, режим reactive, module-цель `examples/echo-agent.mjs`. Отчёт с описательным блоком. Если провайдер недоступен, зафиксировать это явно в финальном отчёте.

---

## Решения, которые стоит переиграть (taste calls, приняты автоматически)

1. **HTTP-контракт без сессионного `close`**: история отправляется целиком каждый ход. Проще для Langflow/API, дороже по трафику. Альтернатива: `sessionId` + серверная память.
2. **Один режим в compare workflow.** Альтернатива: парное сравнение внутри каждого режима.
3. **Порог достаточности калибровки n≥60** (Hamel). Альтернатива: настраиваемый порог в settings.
4. **Профили только при наличии диалогов**; без них карточки остаются синтетическими с явной пометкой. Альтернатива: запрещать синтетические персоны совсем.
5. **`records` из внешнего ответа полностью заменяют мир.** Альтернатива: merge по записям.

## Sources (для человека, не для рантайма)

- Anthropic, Demystifying evals for AI agents: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- Anthropic, A statistical approach to model evaluations: https://www.anthropic.com/research/statistical-approach-to-model-evals
- OpenAI, Evaluation best practices: https://developers.openai.com/api/docs/guides/evaluation-best-practices
- Hamel Husain, LLM-as-a-judge: https://hamel.dev/blog/posts/llm-judge/
- τ^τ-Bench: https://arxiv.org/abs/2609.04611
- Lost in Simulation: https://arxiv.org/abs/2601.17087
- RealUserSim: https://arxiv.org/abs/2605.20204
- Mind the Sim2Real Gap: https://arxiv.org/abs/2603.11245
- Simulated Customers Never Walk Away: https://arxiv.org/abs/2606.20708
- LangWatch Scenario: https://github.com/langwatch/scenario · DeepEval ConversationSimulator: https://deepeval.com/docs/conversation-simulator · promptfoo simulated user: https://www.promptfoo.dev/docs/providers/simulated-user/
- Pi extensions: https://pi.dev/docs/latest/extensions

## Статус выполнения (2026-09-09)

Все задачи T1–T10 выполнены на ветке `pi-agent-builder-evals`, коммиты от `5f20cba` до текущего HEAD.

| Проверка | Результат |
|---|---|
| `npm test` | 91 тестов, 0 падений (было 66) |
| `npm run typecheck` (src + extensions) | чисто |
| `npm pack --dry-run` | 42 файла, `examples/echo-agent.mjs` включён |
| CLI end-to-end, demo, 3 режима, golden + диалоги | 7 диалогов: static 3/3, scripted 1/1, reactive 3/3; верность real 2 / sim 3; экспорт содержит evidence |
| Live, `openai-codex/gpt-5.6-sol`, module-цель `examples/echo-agent.mjs` | подготовка 4 вызова ($0.134): 2 профиля с верными evidence, карточка с profileId и скопированной персоной, golden как curated; прогон 6 вызовов ($0.152 всего): golden pass по сообщённому состоянию, синтетическая карточка fail с уликой судьи #1, рубрика верности симулятора pass |

Оговорки live-проверки: подтверждение черновика выдал проверочный скрипт, а не человек; echo-агент не понимает формат «3:30 PM», поэтому провал синтетической карточки это свойство справочного адаптера, а не модели. Человеческих вердиктов нет, калибровка судьи помечена как неизвестная.

### v2.1 (2026-09-09): синтетика как полноправный вход и простой верхний слой

Два замечания владельца после v2: синтетические карточки не должны стать единственной правдой, но остаются нормальным стартом («накидал вводных, билдер понял»); и продукту нужен простой верхний слой для команды, которая хочет знать одно: хороший ли агент.

- `notes` (вводные своими словами) и `profiles` (типы пользователей от владельца, `source: owner`) стали полноправным входом карточек; синтетика помечается, её доля всегда видна.
- `verdictSummary`: пройдено X из Y, слабые места, доверие (низкое/среднее/высокое) с причинами, следующие шаги. Идёт первым на доске (блок ИТОГ и строка заголовка), в отчёте (## Verdict), в выводе инструментов и в экспорте CLI. Исследовательская статистика осталась в секции 4.
- `preset: thorough` включает три режима и два повтора без ручных настроек.
- Проверка: 97 тестов, typecheck чист.

### v2.2 (2026-09-09): пилот на реальном RAG-агенте

Задача дня владельца: взять реальный RAG-агент (локально на Python или по HTTP в тестовом контуре), получить его карточку, из логов вывести персоны, стиль и цели пользователей, собрать простую модель пользователя, получить диалог и оценку с метриками.

- `target` вида `command`: локальный процесс (python3 agent.py) общается JSON-строками через stdin/stdout; таймаут убивает зависший процесс, падение показывает код и stderr. Справочный адаптер `examples/echo-agent.py`.
- Роль `goals`: из реплик пользователей в логах извлекаются наблюдаемые цели; каждая становится production-карточкой с дословной первой репликой реального пользователя, наблюдаемым профилем и рубриками «цель», «периметр», «верность симулятора». Дословность и ссылки на диалоги проверяются кодом.
- Синтетические карточки получают список наблюдаемых целей и покрывают то, чего нет в логах; при описанном периметре агента добавляется карточка вне периметра с ожиданием отказа.
- README: таблица «восемь шагов» с тем, что нужно от команды, и что делает Agent Lab.
- Проверка: 112 тестов, typecheck чист; сквозной прогон демо с Python-агентом через `command`.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | issues_open → decisions recorded (auto-decide mode) | 8 architecture, 6 code quality, 38 test gaps planned, 0 performance, 0 critical failure gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **ARCHITECTURE (mattpocock improve-codebase-architecture):** 5 deepening candidates; top recommendation: deepen the target seam (see /tmp/architecture-review-20260908-2330.html).
- **CODE QUALITY (thermo-nuclear):** Q1–Q5 accepted, Q6 rejected as non-issue.
- **UNRESOLVED:** 0 blocking; 5 taste calls listed above for the owner to override.
- **VERDICT:** ENG CLEARED in auto-decide mode — ready to implement.
