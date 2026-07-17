# Помощник назначения встреч

Backend Telegram-бота для согласования встреч в личном Google Calendar владельца.

## Текущий этап

M10 Mini App: развиваем центр управления администратора. Доступны закрытые дни и интервалы, список заблокированных пользователей с безопасной разблокировкой и редактор шаблонов уведомлений с проверкой подстановок.

## Требования

- Node.js 20 или новее;
- npm 10 или новее.

## Локальный запуск

```powershell
Copy-Item .env.example .env
npm install
npm run build
npm start
```

При старте приложение автоматически создает каталог и SQLite-файл, применяет непримененные миграции и идемпотентно добавляет базовое расписание и шаблоны сообщений.

После запуска:

- `GET http://localhost:3000/health`
- `POST http://localhost:3000/telegram/webhook`

### Проверка Telegram-бота через polling

1. Создайте бота через `@BotFather` и получите токен.
2. Узнайте свой числовой Telegram ID.
3. В локальном `.env` заполните:

```dotenv
TELEGRAM_BOT_TOKEN=токен_от_BotFather
TELEGRAM_DEV_POLLING=true
ADMIN_TELEGRAM_ID=ваш_числовой_Telegram_ID
```

4. Выполните `npm run build`, затем `npm start`.
5. Откройте бота в Telegram и отправьте `/start`.

Для production используется webhook, поэтому `TELEGRAM_DEV_POLLING` должен быть `false`. Переменная `TELEGRAM_API_ROOT` предназначена только для локального автоматического mock-теста и обычно остается пустой.

## Проверки

```powershell
npm run typecheck
npm test
```

`npm test` выполняет проверки Этапов 1–8: собирает приложение, проверяет HTTP endpoints, прогоняет полный bot-flow через локальный mock Telegram API, проверяет чистую SQLite-базу и резервную копию, расписание, Google-интеграцию, временные календарные маркеры, подписанную web-страницу решения, защиту от подмены и просроченной ссылки, перенос встреч, маршрутизацию уведомлений с повторными попытками, production-артефакты и CI/CD-контур.

Для M6 дополнительно проверяются Mini App-кнопка и menu button Telegram, включение frontend в release-архив, локальный/public HTTPS smoke и ответ `401` закрытого API без Telegram-сессии.

Также выполняется mock-smoke Этапа 5: OAuth URL, статус токена, free/busy, payload события с Meet/гостем/reminder и отмена проверяются без доступа к реальному Google-аккаунту.

## Подключение Google Calendar

1. В Google Cloud создайте OAuth Client типа `Web application` и включите Google Calendar API.
2. Добавьте redirect URI: `http://localhost:3000/google/oauth/callback` для локальной проверки.
3. Заполните в локальном `.env` переменные `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` и `GOOGLE_OAUTH_REDIRECT_URI`.
4. Перезапустите приложение, откройте в Telegram `⚙️ Администрирование` → `🛠 Настройки` и нажмите `🔗 Подключить Google Calendar`.

OAuth-токены сохраняются в локальной SQLite-базе, которая исключена из Git. В production redirect URI обязан использовать HTTPS.

## Production deploy на VPS

Этап 7 использует один backend-контейнер и Caddy:

- приложение собирается на официальном Node.js 24 image и запускается не от root;
- SQLite хранится в примонтированном каталоге `./data` на VPS;
- Caddy автоматически обслуживает HTTPS и проксирует Telegram webhook;
- production работает с `TELEGRAM_DEV_POLLING=false`;
- контейнеры имеют healthcheck и политику `restart: unless-stopped`.

Основные команды:

```bash
cp .env.production.example .env.production
docker compose --env-file .env.production config
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --tail=100 app caddy
```

Полная инструкция, включая webhook, backup и проверку рестарта: [`docs/DEPLOY_VPS.md`](docs/DEPLOY_VPS.md).

Автоматическое обновление из GitHub, резервная копия перед переключением и откат при ошибке описаны в [`docs/AUTO_DEPLOY_GITHUB.md`](docs/AUTO_DEPLOY_GITHUB.md).

## Подключение Email-уведомлений

Для отправки писем нужны отдельные SMTP-данные. Доступ к Google Calendar не даёт права отправлять email.

Для Gmail включите двухэтапную аутентификацию, создайте пароль приложения и заполните только локальный `.env`:

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-address@gmail.com
SMTP_PASSWORD=пароль_приложения
SMTP_FROM=your-address@gmail.com
```

Обычный пароль Google использовать нельзя. Для другого почтового провайдера укажите выданные им SMTP host, port, TLS-режим, логин и пароль. После изменения `.env` перезапустите приложение.

Неудачные доставки сохраняются в SQLite. Планировщик выполняет до трёх попыток, после окончательной ошибки администратор получает техническое уведомление в Telegram; выбор канала пользователя автоматически не меняется.

## База данных

Основной путь задается переменной `DATABASE_URL`; локальное значение по умолчанию — `file:./data/app.db`. Каталог `data` исключен из Git.

Основные сущности:

- `User` — Telegram ID, профиль, последний подтвержденный email, выбранный канал уведомлений и статус бана;
- `Booking` — заявка, статус, TTL, необязательный снимок email и связь с исходной встречей при переносе;
- `SlotReservation` и `CalendarEvent` — по одной записи на заявку;
- `ScheduleSettings`, `ScheduleWorkingPeriod`, `AvailabilityRestriction` — расписание и ограничения;
- `BlacklistEntry`, `MessageTemplate`, `SystemLog`, `BusinessEvent`.
- `NotificationDelivery` — очередь, статус и история повторных попыток пользовательских уведомлений.

Команды:

```powershell
npm run prisma:migrate:dev -- --name название_миграции
npm run prisma:migrate:deploy
npm run db:seed
npm run db:smoke
```

`prisma:migrate:deploy` использует транзакционный SQLite-runner с checksum миграций. Это обход текущего Windows-сбоя Prisma schema engine; сама схема, generated client и runtime-доступ продолжают работать через Prisma 7.

Для простой резервной копии остановите приложение и выполните:

```powershell
npm run db:backup
```

Копия будет создана в каталоге `backups`, который исключен из Git.

## Безопасность

Секреты хранятся только в локальном `.env`, который исключен из Git. В `.env.example` должны находиться только пустые значения и безопасные примеры.
