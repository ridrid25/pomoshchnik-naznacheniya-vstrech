# Mini App M6 — Telegram и production

## Что реализовано

- Mini App открывается из главного меню бота кнопкой `✨ Открыть приложение`.
- При старте бот вызывает `setChatMenuButton` и назначает стандартную кнопку меню типа `web_app` на `${PUBLIC_BASE_URL}/mini-app`.
- Frontend собирается внутри того же Docker-образа, что и backend.
- Release-архив GitHub Actions включает `prototype/`, необходимый Docker build-stage.
- Локальная проверка deploy блокирует переключение релиза, если `/mini-app` или `/mini-app/app.js` не отдаются корректно.
- Финальная GitHub Actions-проверка контролирует публичные `/health`, `/mini-app`, `/mini-app/app.js` и ожидаемый `401` от `/api/mini-app/v1/me` без сессии.
- Production требует отдельный `MINI_APP_SESSION_SECRET` длиной не менее 32 символов и HTTPS `PUBLIC_BASE_URL`.

## Production URL

Для текущего VPS ожидаемый адрес:

```text
https://meeting.85.198.98.201.sslip.io/mini-app
```

В Telegram используется только этот HTTPS URL. Query-параметр деморежима удалён; без подтверждённой Telegram-сессии рабочий интерфейс не открывается.

## Переменные окружения

```dotenv
PUBLIC_BASE_URL=https://meeting.85.198.98.201.sslip.io
MINI_APP_SESSION_SECRET=<отдельный случайный секрет>
MINI_APP_SESSION_TTL_SECONDS=7200
MINI_APP_INIT_DATA_MAX_AGE_SECONDS=600
```

Для первого обновления уже работающего VPS предусмотрен безопасный переходный режим: пока отдельный `MINI_APP_SESSION_SECRET` ещё не добавлен старым системным deploy-скриптом, подпись сессий использует существующий `ADMIN_ACTION_SECRET` длиной не менее 32 символов. Новые установки и обновлённый deploy-скрипт создают отдельный session secret автоматически; он остаётся приоритетным.

Скрипт `scripts/prepare-production-env.sh` генерирует новый session secret при первоначальной подготовке production-файла. Для уже работающего VPS deploy-скрипт выполняет безопасную одноразовую миграцию: добавляет секрет только при его отсутствии и сохраняет его между следующими релизами. Поэтому активные сессии не сбрасываются при каждом deploy.

## Проверка после выкладки

На VPS:

```bash
cd /opt/meeting-assistant
sh scripts/verify-production-mini-app.sh /opt/meeting-assistant
```

Успешный результат:

```text
MINI_APP_STATUS=ready
MINI_APP_URL=https://meeting.85.198.98.201.sslip.io/mini-app
MENU_BUTTON=web_app
```

После этого откройте личный чат с ботом, нажмите `/start`, затем `✨ Открыть приложение`. Telegram должен передать подписанный `initData`, а Mini App — открыть обычный интерфейс без demo-режима.

## Main Mini App в профиле бота

Стандартная кнопка меню настраивается автоматически через Bot API. Дополнительную крупную кнопку запуска в профиле можно включить отдельно в `@BotFather`, указав тот же URL. Это не заменяет серверную проверку `initData` и не требует другого frontend URL.

## Контрольная точка M6

M6 считается завершённым после одновременного выполнения условий:

1. production deploy завершился без rollback;
2. HTTPS smoke вернул корректные HTML и JavaScript;
3. `getChatMenuButton` вернул `web_app` с точным production URL;
4. приложение реально открылось из личного чата Telegram;
5. обычный пользователь увидел пользовательский интерфейс, а администратор — раздел согласования.
