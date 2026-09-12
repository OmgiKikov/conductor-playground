import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { draftPatchSchema, profileUser, TOOL_NAMES, type DraftPatch, type Profile } from '../dist/contracts.js';
import { safeText, type BoardAction } from './cards.ts';

export function inputError(error: unknown): string {
  if (error instanceof z.ZodError) return safeText(error.issues.slice(0, 3).map(issue => {
    if (issue.path.at(-1) === 'maxFollowUps') return 'Введите целое число от 0 до 15.';
    const field = issue.path.join('.');
    const rule = issue.code === 'too_small' ? `Минимум: ${issue.minimum}.`
      : issue.code === 'too_big' ? `Максимум: ${issue.maximum}.`
      : issue.code === 'invalid_type' ? 'Проверьте тип значения и заполните обязательное поле.'
      : issue.code === 'unrecognized_keys' ? `Неизвестные поля: ${issue.keys.join(', ')}.`
      : issue.message;
    return `${field ? `${field}: ` : ''}${rule}`;
  }).join(' '));
  if (error instanceof SyntaxError) return 'Некорректный JSON. Проверьте кавычки, запятые и скобки.';
  return safeText(error instanceof Error ? error.message : error);
}

/** The editor owns unfinished input; only a schema-valid patch can leave it. */
async function editValidated<T>(ctx: ExtensionContext, title: string, initial: string, parse: (text: string) => T | Promise<T>): Promise<T | undefined> {
  let input = safeText(initial);
  let error = '';
  for (;;) {
    const changed = await ctx.ui.editor(`${title}${error ? `\nОшибка: ${error}` : ''}`, input);
    if (changed === undefined) return;
    input = changed;
    try { return await parse(changed); }
    catch (reason) { error = inputError(reason); }
  }
}

export async function editDraft(ctx: ExtensionContext, action: Extract<BoardAction, { record: unknown }>, save?: (patch: DraftPatch) => Promise<void>): Promise<DraftPatch | undefined> {
  const { record } = action;
  const commit = async (patch: DraftPatch): Promise<DraftPatch> => { await save?.(patch); return patch; };
  const editPatch = (title: string, initial: string, patch: (text: string) => unknown) =>
    editValidated(ctx, title, initial, text => commit(draftPatchSchema.parse(patch(text))));
  const editJSON = (title: string, value: unknown, key: 'scenarios' | 'agent' | 'settings' | 'target') =>
    editPatch(title, JSON.stringify(value, null, 2), text => ({ [key]: JSON.parse(text) }));
  const editTarget = async (): Promise<DraftPatch | undefined> => {
    const target = record.target;
    const fields = target.kind === 'command' ? ['Программа или путь', 'Аргументы · по одному в строке', 'Рабочая папка · абсолютный путь']
      : target.kind === 'http' ? ['URL агента'] : target.kind === 'module' ? ['Путь к модулю', 'Имя экспорта'] : [];
    const choice = await ctx.ui.select('Подключение агента', [...fields, 'Подключение целиком · JSON']);
    if (!choice) return;
    if (choice === 'Подключение целиком · JSON') return editJSON(choice, target, 'target');
    const key = choice === fields[0] ? target.kind === 'command' ? 'command' : target.kind === 'http' ? 'url' : 'path'
      : choice === fields[1] ? target.kind === 'command' ? 'args' : 'exportName' : 'cwd';
    if (key === 'args' && target.kind === 'command') {
      // Multiline and empty arguments need JSON to preserve their exact argv representation.
      if (target.args.some(arg => !arg || /[\r\n]/.test(arg))) return editJSON('Аргументы с пустыми строками или переносами · JSON', target, 'target');
      return editPatch('Аргументы · по одному в строке, без добавочных кавычек · пусто = без аргументов', target.args.join('\n'), text => ({ target: { ...target, args: text === '' ? [] : text.split('\n') } }));
    }
    return editPatch(choice, String((target as unknown as Record<string, unknown>)[key] ?? ''), text => ({ target: { ...target, [key]: key === 'cwd' && !text ? undefined : text } }));
  };
  const editAll = () => editValidated(ctx, 'Все карточки · JSON · удаление потребует подтверждения', JSON.stringify(record.scenarios, null, 2), async text => {
    const patch = draftPatchSchema.parse({ scenarios: JSON.parse(text) });
    const ids = new Set(patch.scenarios!.map(s => s.id));
    const removed = record.scenarios.filter(s => !ids.has(s.id));
    if (removed.length) {
      if (!await ctx.ui.confirm(`Удалить ${removed.length} карточек?`, removed.map(s => safeText(s.title)).join('\n'))) return;
      patch.removeScenarioIds = removed.map(s => s.id);
    }
    return commit(patch);
  });
  const editProfile = async (profile: Profile, field?: 'persona' | 'characteristics'): Promise<DraftPatch | undefined> => {
    const choice = field ?? await ctx.ui.select(`Профиль ${safeText(profile.id)} · исходные данные сохранятся`, ['Персона', 'Характеристики', 'Восстановить исходный профиль']);
    if (!choice) return;
    if (choice === 'Восстановить исходный профиль') return commit({ profileEdits: [{ id: profile.id, override: null }] });
    const key = choice === 'Персона' || choice === 'persona' ? 'persona' : 'characteristics';
    const user = profileUser(profile);
    const count = record.scenarios.filter(s => s.profileId === profile.id).length;
    return editPatch(`${key === 'persona' ? 'Персона' : 'Характеристики · по одной в строке'} · ${count} карточек · пусто = убрать`,
      key === 'persona' ? user.persona ?? '' : user.characteristics?.join('\n') ?? '', changed => ({
        profileEdits: [{ id: profile.id, override: { ...profile.draftOverride,
          [key]: key === 'persona' ? changed.trim() || null : changed.split('\n').map(v => v.trim()).filter(Boolean),
        } }],
      }));
  };
  if (action.type === 'settings') {
    const choice = await ctx.ui.select('Настройки прогона', [
      'Быстрый · реактивные диалоги, один повтор', 'Полный · три режима, два повтора',
      'Версия агента · название релиза или коммит', 'Подключение · команда, модуль или HTTP', 'Профили пользователей', 'Лимиты · расширенные настройки',
    ]);
    if (choice?.startsWith('Быстрый')) return commit({ settings: { userModes: ['reactive'], repeats: 1 } });
    if (choice?.startsWith('Полный')) return commit({ settings: { userModes: ['static', 'scripted', 'reactive'], repeats: 2 } });
    if (choice?.startsWith('Версия')) return editPatch('Версия агента · например acquiring-v3', record.targetVersion ?? '', targetVersion => ({ targetVersion }));
    if (choice?.startsWith('Подключение')) return editTarget();
    if (choice === 'Профили пользователей') {
      if (!record.profiles.length) throw new Error('Профилей нет. Карточки работают по цели, фактам и поведению.');
      const labels = record.profiles.map(p => safeText(`${p.id} · ${profileUser(p).persona ?? 'Без персоны'}${p.draftOverride ? ' · изменён' : ''}`));
      const selected = await ctx.ui.select('Какой профиль изменить?', labels);
      const profile = record.profiles[labels.indexOf(selected ?? '')];
      return profile ? editProfile(profile) : undefined;
    }
    if (choice?.startsWith('Лимиты')) return editJSON('Лимиты · повторы, ходы, вызовы и время', record.settings, 'settings');
    return;
  }
  if (action.section === 'cards' && record.scenarios[action.selected]) {
    const scenario = structuredClone(record.scenarios[action.selected]!);
    const fields = [
      ['opening', 'Первая реплика'], ['successCriteria', 'Критерий успеха'],
      ['script', 'Продолжения после первой реплики · по одному в строке'],
      ['facts', 'Факты, известные пользователю'], ['maxFollowUps', 'Максимум ответов после первой реплики'],
      ['profileId', 'Профиль пользователя · выбрать или убрать'],
      ['title', 'Название'], ['persona', 'Персона'], ['characteristics', 'Характеристики · по одной в строке'],
      ['goal', 'Цель пользователя'], ['behavior', 'Поведение'], ['assumptions', 'Допущения · по одному в строке'],
      ['tier', 'Ступень · дымовая, регрессия или фронтир'],
      ['metrics', 'Метрики · JSON'], ['checks', 'Точные проверки · JSON'], ['initialState', 'Начальное состояние · JSON'],
      ['all', 'Все карточки · JSON'],
    ] as const;
    let choice = await ctx.ui.select('Что изменить в тесте? · можно обсудить обычными словами: a', [...fields.slice(0, 5).map(([, label]) => label), 'Расширенные настройки']);
    if (choice === 'Расширенные настройки') choice = await ctx.ui.select('Расширенные настройки теста', fields.slice(5).map(([, label]) => label));
    const entry = fields.find(([, label]) => label === choice);
    if (!entry) return;
    const [field, title] = entry;
    if (field === 'successCriteria') return editPatch('Ожидание и исполняемые проверки · измените их вместе · для правки обычными словами нажмите a на доске',
      JSON.stringify({ successCriteria: scenario.successCriteria, checks: scenario.checks, metrics: scenario.metrics ?? [] }, null, 2), text => {
        const expectation = z.strictObject({ successCriteria: z.string().min(1), checks: z.array(z.unknown()), metrics: z.array(z.unknown()) }).parse(JSON.parse(text));
        return { scenarios: [{ ...scenario, ...expectation }] };
      });
    if (field === 'profileId') {
      const labels = ['Без профиля и персоны', ...record.profiles.map(p => `${p.id} · ${profileUser(p).persona ?? 'Без персоны'}`)].map(safeText);
      const selected = await ctx.ui.select('Профиль этой карточки', labels);
      const index = labels.indexOf(selected ?? '');
      if (index < 0) return;
      delete scenario.user.persona; delete scenario.user.characteristics;
      if (index === 0) delete scenario.profileId;
      else scenario.profileId = record.profiles[index - 1]!.id;
      return commit({ scenarios: [scenario] });
    }
    if (scenario.profileId && (field === 'persona' || field === 'characteristics')) return editProfile(record.profiles.find(p => p.id === scenario.profileId)!, field);
    if (field === 'all') return editAll();
    if (field === 'tier') {
      const choices = [{ value: 'smoke', label: 'smoke · базовое поведение' }, { value: 'regression', label: 'regression · уже работает' }, { value: 'frontier', label: 'frontier · новая возможность' }] as const;
      const selected = await ctx.ui.select('Ступень карточки', choices.map(c => c.label));
      const tier = choices.find(c => c.label === selected)?.value;
      if (!tier) return;
      return commit({ scenarios: [{ ...scenario, tier }] });
    }
    const userFields = new Set(['persona', 'characteristics', 'goal', 'behavior', 'facts', 'opening', 'maxFollowUps', 'script']);
    const object = (userFields.has(field) ? scenario.user : scenario) as unknown as Record<string, unknown>;
    const json = ['metrics', 'checks', 'initialState'].includes(field);
    const array = ['characteristics', 'assumptions', 'script'].includes(field);
    const initial = object[field];
    return editPatch(title, json ? JSON.stringify(initial ?? [], null, 2)
      : array ? (initial as string[] | undefined)?.join('\n') ?? '' : String(initial ?? ''), changed => {
      if (field === 'maxFollowUps' && !/^\d+$/.test(changed.trim())) throw new Error('Введите целое число от 0 до 15.');
      object[field] = json ? JSON.parse(changed) : field === 'script' ? changed === '' ? [] : changed.split('\n')
        : array ? changed.split('\n').map(v => v.trim()).filter(Boolean) : field === 'maxFollowUps' ? Number(changed) : changed;
      if (field === 'persona' && !changed.trim()) delete object[field];
      return { scenarios: [scenario] };
    });
  }
  const agent = record.revisions.find(r => r.id === record.selectedRevisionId)?.spec;
  if (!agent) throw new Error('Агент ещё не подготовлен.');
  const choice = await ctx.ui.select('Что изменить?', record.target.kind === 'sandbox' ? ['Инструкции агента', 'Инструменты агента', 'Агент целиком · JSON', 'Все карточки · JSON'] : ['Подключение агента', 'Все карточки · JSON']);
  if (choice === 'Подключение агента') return editTarget();
  if (choice === 'Инструкции агента') return editPatch(choice, agent.instructions, instructions => ({ agent: { ...agent, instructions } }));
  if (choice === 'Инструменты агента') {
    const labels = TOOL_NAMES.map(tool => `${agent.tools.includes(tool) ? '✓' : '○'} ${tool} · ${tool === 'update_record' ? 'изменить запись' : tool === 'lookup_record' ? 'прочитать запись' : 'найти правило'}`);
    const selected = await ctx.ui.select('Выберите инструмент, чтобы включить или выключить', labels);
    const tool = TOOL_NAMES[labels.indexOf(selected ?? '')];
    if (!tool) return;
    return commit({ agent: { ...agent, tools: agent.tools.includes(tool) ? agent.tools.filter(t => t !== tool) : [...agent.tools, tool] } });
  }
  if (choice === 'Агент целиком · JSON') return editJSON(choice, agent, 'agent');
  if (choice === 'Все карточки · JSON') return editAll();
}
