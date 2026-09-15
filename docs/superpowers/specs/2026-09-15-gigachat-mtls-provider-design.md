# GigaChat через mTLS как провайдер Agent Lab

## Цель

Сейчас `settings.provider`/`settings.model` в Agent Lab — это просто строка,
которую `createPiRuntime()` передаёт в `ModelRuntime.getModel()` из Pi SDK.
Сам репозиторий не регистрирует ни одного провайдера: доступные провайдеры
(`openrouter`, `anthropic` и т.д.) приходят из конфигурации Pi вне проекта.

У нас появились боевые mTLS-сертификаты для внутреннего контура GigaChat.
Нужно, чтобы Agent Lab мог обращаться к этому внутреннему GigaChat напрямую
по сертификату, наравне с существующими внешними провайдерами — без того,
чтобы полагаться на внешнюю конфигурацию Pi или на отдельный процесс-шлюз.

## Контекст и находки

- В соседнем репозитории `agent_oc` (`src/app/incass_ckr/new_agent_logic/`)
  уже есть рабочий паттерн подключения к внутреннему GigaChat по mTLS, через
  официальный Python SDK `gigachat` (обёрнутый `langchain_gigachat`).
- Ключевая находка: аутентификация — **только сертификат, без обмена на
  OAuth-токен**. Если заданы `cert_file`/`key_file` без `credentials`,
  клиент `gigachat` не делает отдельный запрос за Bearer-токеном — сертификат
  предъявляется на каждый HTTPS-запрос к `/chat/completions` напрямую
  (`gigachat/client.py`: `_use_auth` ложно без `credentials`/`user+password`,
  `_get_kwargs` вешает `cert=(cert_file, key_file)` прямо на основной
  `httpx.Client`).
  Отдельный OAuth-контур (`credentials`+`scope` → Bearer) в SDK тоже есть, но
  это другой, не-mTLS путь для публичного/корп API — он не нужен для наших
  боевых сертификатов.
- Формат запроса/ответа GigaChat близок к классическому OpenAI Chat
  Completions (`model`, `messages`, `temperature`, `max_tokens` →
  `choices[0].message.content`, `usage.prompt_tokens/completion_tokens/total_tokens`),
  но использует устаревший формат function calling (`functions`/`function_call`),
  а не современный `tools`/`tool_calls`.
- В этом репозитории провайдер модели используется в трёх ролях с одним и
  тем же `provider`/`model`: симулятор пользователя, судья, и — если
  `target.kind === 'sandbox'` — сама песочница с реальными tool calls
  (`src/pi.ts`, `openTarget`). Из них tool calling нужен только песочнице.
- Провайдеры в Pi SDK можно завести двумя способами: декларативным
  `~/.pi/agent/models.json` (без кода, но и без произвольной TLS-логики) или
  программно через `ModelRuntime.registerProvider()`/`registerNativeProvider()`
  — последнее доступно и из обычного TypeScript-кода этого репозитория, не
  только из расширений Pi.
- Рассмотренная альтернатива — локальный прокси
  [`gpt2giga`](https://github.com/ai-forever/gpt2giga) (Python, транслирует
  OpenAI/Anthropic/Gemini-совместимые запросы в GigaChat, включая маппинг
  tool calling). Он действительно поддерживает cert-only mTLS (использует тот
  же класс `gigachat.settings.Settings`, что и `agent_oc`). Отклонён для v1:
  добавляет Python-зависимость и отдельный процесс ради возможностей
  (tool calling), которые сейчас не нужны. Можно пересмотреть, если позже
  понадобится «песочница с tool calls на GigaChat».

## Нецели (v1)

- Tool/function calling через GigaChat (роль sandbox-агента с инструментами).
  Если контекст запроса содержит инструменты, провайдер должен явно упасть
  с понятной ошибкой, а не тихо проигнорировать инструменты.
- Настоящий потоковый вывод токен-за-токеном (real SSE streaming). Симулятору
  и судье достаточно получить готовый ответ целиком.
- Автоматическое обновление списка моделей через `/models` GigaChat.
- Переключение dev/prod URL по аналогии с Python-паттерном (`DEV_MODE`).
  Выбор внешний/внутренний провайдер уже даёт сам `settings.provider`
  (`openrouter` vs `gigachat`), второй уровень переключения не нужен.

## Архитектура

Новый нативный провайдер Pi SDK (`Provider` из `@earendil-works/pi-ai`),
регистрируемый программно на `modelRuntime` внутри `createPiRuntime()` —
не через `~/.pi/agent/models.json` и не через отдельный процесс-шлюз. Для
остального кода `provider: 'gigachat'` неотличим от любого другого
провайдера.

## Компоненты

### `src/giga-provider.ts` (новый файл)

Экспортирует `createGigaChatProvider(env = process.env): Provider | undefined`.

- Читает `GIGACHAT_CERT_PATH`, `GIGACHAT_KEY_PATH`, `GIGACHAT_URL` (обязательные)
  и `GIGACHAT_CA_PATH` (опциональный). Если обязательные переменные не заданы —
  возвращает `undefined`: провайдер просто не регистрируется, без исключений.
- Статический список моделей на старте: `GigaChat-2-Max`, `GigaChat-2-Pro`
  (те же имена, что уже фигурируют в `docs/AIGW-PILOT.md`). Список — простой
  массив, легко расширяется при необходимости.
- `streamSimple`/`stream`:
  1. Собирает тело запроса в нативном формате GigaChat: `model`, `messages`
     (маппинг ролей user/assistant/system 1:1), `temperature`, `max_tokens`.
  2. Отправляет POST на `${GIGACHAT_URL}/chat/completions` через `fetch` с
     `dispatcher` — undici `Agent({ connect: { cert, key, ca } })`,
     построенным из файлов на каждый вызов провайдера (не глобальный
     dispatcher, чтобы не задевать другие провайдеры). Без Bearer-токена —
     аутентификация только по сертификату.
  3. Проверка серверного сертификата: если задан `GIGACHAT_CA_PATH` —
     проверяем по этому CA bundle; если нет — по системному доверенному
     хранилищу Node (штатная проверка, не `verify: false`). Отключать
     проверку сервера по умолчанию — то, от чего явно предостерегает
     референсный документ по mTLS; здесь мы этого не делаем.
  4. Разбирает ответ (`choices[0].message.content`, `usage.*`) и собирает
     `AssistantMessage` в формате pi-ai, эмитируя минимально достаточную
     последовательность событий: `start` → `text_start` → `text_end` →
     `done` (без промежуточных `text_delta`, так как настоящего стриминга
     нет).
  5. Если `context.tools?.length`, бросает явную ошибку
     `"GigaChat provider does not support tool calling yet"` — вместо тихого
     игнорирования инструментов.
- Ошибки транспорта (сетевые, TLS handshake, non-2xx от GigaChat) пробрасываются
  как обычная ошибка вызова модели — существующий код в `src/pi.ts` уже
  оборачивает такие ошибки в понятное пользователю сообщение
  (`Запрос к ${provider}/${model} не прошёл...`).

### `src/pi.ts` (правка)

В `createPiRuntime()`, сразу после создания `modelRuntime` (только на ветке
реального создания, не на `injectedRuntime`, чтобы не трогать поведение
тестов с фиктивным runtime), вызывается `createGigaChatProvider()` и, если
она вернула провайдера, `modelRuntime.registerProvider('gigachat', ...)`.

## Именование

- Provider id: `gigachat`.
- Env-переменные: собственный набор с суффиксной конвенцией из референсного
  документа — `GIGACHAT_CERT_PATH`, `GIGACHAT_KEY_PATH`, `GIGACHAT_CA_PATH`,
  `GIGACHAT_URL`. Это частично отличается от имён, уже используемых в
  `agent_oc`: там `GIGACHAT_CERT_PATH` называется так же, но ключ — просто
  `GIGACHAT_KEY` (без `_PATH`), а CA-переменной нет вовсе (там
  `verify_ssl_certs=False`); `GIGACHAT_URL` совпадает по имени в обоих
  репозиториях. Файлы сертификата/ключа физически можно переиспользовать
  между репозиториями (это одни и те же боевые файлы) — переменные окружения
  в каждом репозитории просто называются и заполняются независимо.

## Данные и поток вызова

`settings.provider = 'gigachat'` → `modelRuntime.getModel('gigachat', 'GigaChat-2-Max')`
→ обычные `controlledSession`/`jsonResponse` в `src/pi.ts`, ничем не отличающиеся
от вызова любого другого провайдера → `streamSimple` из `giga-provider.ts`
выполняет реальный mTLS-запрос и возвращает стандартный `AssistantMessage`.

## Ошибки и безопасность

- Нет `GIGACHAT_CERT_PATH`/`GIGACHAT_KEY_PATH`/`GIGACHAT_URL` → провайдер не
  регистрируется; выбор `provider: 'gigachat'` даёт то же сообщение о
  недоступной модели, что и для любого другого не настроенного провайдера —
  отдельная ветка не нужна.
- Проверка серверного TLS-сертификата включена всегда; `GIGACHAT_CA_PATH`
  задаёт кастомный CA bundle для внутреннего контура, если системного
  доверенного хранилища недостаточно. `verify: false` нигде не используется.
- Реальные боевые файлы сертификата/ключа никогда не попадают в git — в
  репозитории фиксируются только имена переменных окружения, а не значения
  или пути по умолчанию, указывающие на боевые файлы.
- Без тихих фолбэков: если mTLS-рукопожатие не удалось, ошибка не
  подавляется попыткой запроса без сертификата.

## Тестирование

- Юнит-тесты на чистые функции сборки запроса и разбора ответа
  (`buildGigaChatRequest`/`parseGigaChatResponse` или аналог) — без сети,
  в духе принятого в проекте подхода с fake-реализациями вместо моков.
- Юнит-тест: без переменных окружения `createGigaChatProvider()` возвращает
  `undefined`.
- Юнит-тест: непустой `context.tools` приводит к явной ошибке.
- Ручная опциональная регрессия по уже существующему паттерну:
  `node --import tsx test/live/simulator-stop.ts gigachat GigaChat-2-Max`
  против настоящего внутреннего эндпоинта — не часть `npm test`.

## Будущая работа (вне v1)

- Маппинг OpenAI `tools`/`tool_calls` ↔ GigaChat `functions`/`function_call`,
  если понадобится песочница с инструментами на GigaChat. При появлении этой
  задачи стоит свериться с реализацией маппинга в `gpt2giga`
  (`ai-forever/gpt2giga`) как референсом, а не изобретать заново.
- Возможный пересмотр в пользу `gpt2giga`-прокси, если список необходимых
  возможностей (tool calling, structured output, реальный streaming) вырастет
  настолько, что дешевле переиспользовать готовый транслятор, чем
  поддерживать свой.
